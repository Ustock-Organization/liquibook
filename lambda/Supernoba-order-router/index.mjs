// order-router Lambda - 주문 라우터 (Kinesis 버전) - Optimized
// Supabase 잔고 확인 + UUID 생성 + Kinesis 발행 + CANCEL/REPLACE 지원
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from 'https';
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// === Optimization: TCP Keep-Alive for AWS SDK ===
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: true,
});

const kinesis = new KinesisClient({ 
  region: process.env.AWS_REGION || 'ap-northeast-2',
  requestHandler: new NodeHttpHandler({
    httpsAgent: agent
  })
});

// === Optimization: Redis Connection Reuse ===
// 전역 변수로 선언하여 효율적인 재사용 (Warm Start 시 연결 유지)
let valkey = null;

function getValkey() {
  if (!valkey) {
    valkey = new Redis({
      host: process.env.VALKEY_HOST,
      port: parseInt(process.env.VALKEY_PORT || '6379'),
      lazyConnect: true, // 필요할 때 연결
      connectTimeout: 2000,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }
  return valkey;
}

// Supabase 클라이언트 (지연 초기화 - NAT Gateway 없을 시 사용 안함)
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

// UUID v4 생성 (crypto 사용 - 빠름)
function generateOrderId(prefix = 'ord') {
  return `${prefix}_${crypto.randomUUID().split('-')[0]}${Date.now().toString(36)}`;
}

// Supabase에서 사용자 잔고 확인 (현재 비활성화 - NAT Gateway 필요)
async function checkBalance(userId, side, symbol, price, quantity) {
  // TODO: NAT Gateway 추가 후 활성화
  return { success: true, skipped: true };
}

export const handler = async (event) => {
  // CORS 헤더
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  
  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  // Context 초기화
  const redis = getValkey();
  
  try {
    let requestBody;
    if (typeof event.body === 'string') {
      requestBody = JSON.parse(event.body);
    } else if (event.body) {
      requestBody = event.body;
    } else {
      requestBody = event;
    }
    
    // 필수 필드 검증 (공통)
    if (!requestBody.symbol || !requestBody.user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields: symbol, user_id' }),
      };
    }

    const { 
      symbol, 
      user_id, 
      action = 'ADD', // 기본값 ADD
      order_id,      // CANCEL/REPLACE 시 필수
      price = 0,     // MARKET 주문 시 0
      quantity = 0,
      side = 'BUY',
      type = 'LIMIT', // LIMIT or MARKET
      qty_delta = 0,  // REPLACE 시 수량 변경분
      conditions = null // {all_or_none: bool, immediate_or_cancel: bool}
    } = requestBody;
    
    // 거래 가능 종목인지 가볍게 체크 (Redis Cache)
    // 최적화: 캐시가 없으면 통과시키고 엔진에서 Reject 되게 하는게 낫다 (Latency 우선)
    // 여기서는 Redis에 데이터가 확실히 있다고 가정하고 체크
    // const isActiveSymbol = await redis.sismember('active:symbols', symbol);
    // if (!isActiveSymbol) { ... } -> 10ms 소요되므로 일단 생략하거나 병렬 처리 권장

    // === Action별 처리 ===
    let kinesisRecord = {};
    let finalOrderId = order_id;

    if (action === 'ADD') {
      // 신규 주문
      finalOrderId = generateOrderId();
      
      let finalPrice = Number(price);
      let orderType = type;
      let finalConditions = conditions || {};

      // === 시장가 주문 처리 ===
      if (type === 'MARKET') {
        // 1. 호가 존재 확인 (Valkey에서 depth 조회)
        try {
          const depthJson = await redis.get(`depth:${symbol}`);
          const depth = depthJson ? JSON.parse(depthJson) : null;
          
          const isBuy = (side === 'BUY' || side === 'buy');
          const hasLiquidity = isBuy 
            ? (depth?.a?.length > 0)   // 매수 시 매도호가 필요
            : (depth?.b?.length > 0);  // 매도 시 매수호가 필요
          
          if (!hasLiquidity) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ 
                error: 'MARKET_NO_LIQUIDITY',
                message: '시장가 주문 불가: 오더북이 비어있습니다'
              })
            };
          }
        } catch (depthErr) {
          console.warn('Depth check failed, proceeding anyway:', depthErr.message);
        }
        
        // 2. 가격 설정 (극단적 가격)
        if (side === 'BUY' || side === 'buy') {
          finalPrice = 2147483647; // MAX_INT
        } else {
          finalPrice = 0;
        }
        
        // 3. IOC 강제 적용 (체결 후 잔량 자동 취소)
        finalConditions.immediate_or_cancel = true;
      }

      kinesisRecord = {
        action: 'ADD',
        order_id: finalOrderId,
        user_id: user_id,
        symbol: symbol,
        is_buy: (side === 'BUY' || side === 'buy'),
        price: finalPrice,
        quantity: Number(quantity),
        order_type: orderType,
        timestamp: Date.now(),
        conditions: finalConditions
      };

      // 잔고 확인 (신규 주문만)
      // const balanceCheck = await checkBalance(...)
      
    } else if (action === 'CANCEL') {
      // 주문 취소
      if (!order_id) throw new Error('order_id is required for CANCEL');
      kinesisRecord = {
        action: 'CANCEL',
        order_id: order_id,
        user_id: user_id,
        symbol: symbol,
        timestamp: Date.now()
      };

    } else if (action === 'REPLACE') {
      // 주문 정정
      if (!order_id) throw new Error('order_id is required for REPLACE');
      
      // qty_delta 검증: 0이면 정정이 안 일어날 수 있음.
      // 사용자가 '새 수량'을 보냈다면, 이전 수량을 모르므로 계산 불가.
      // 따라서 API는 반드시 'delta'를 받아야 함. (Web UI에서 delta 계산해서 보냄)
      
      kinesisRecord = {
        action: 'REPLACE',
        order_id: order_id,
        user_id: user_id,
        symbol: symbol,
        qty_delta: Number(qty_delta), // 수량 변경분 (+/-)
        new_price: Number(price),     // 새 가격
        timestamp: Date.now()
      };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
    }
    
    // Valkey Route Info 조회 (필요 시) - 생략 가능하면 생략 (Latency Opt)
    // const routeInfo = await redis.get(`route:${symbol}`); ...
    
    const streamName = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
    
    // Kinesis 발행 (최적화된 Client 사용)
    await kinesis.send(new PutRecordCommand({
      StreamName: streamName,
      Data: Buffer.from(JSON.stringify(kinesisRecord)),
      PartitionKey: symbol,  // 순서 보장
    }));
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: `${action} accepted`,
        order_id: finalOrderId,
        action: action,
        symbol: symbol,
        stream: streamName
      }),
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
