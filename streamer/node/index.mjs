// Streaming Server v2 - 50ms/500ms 이중 폴링 + 캔들 데이터 지원
// 50ms: 실시간 사용자 (depth, candle)
// 500ms: 익명 사용자 (캐시 사용)

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const FAST_POLL_MS = 50;   // 실시간 사용자
const SLOW_POLL_MS = 500;  // 익명 사용자

function debug(...args) {
  if (DEBUG_MODE) console.log('[DEBUG]', ...args);
}

console.log('=== Streaming Server v2 ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT}`);
console.log(`Polling: ${FAST_POLL_MS}ms (realtime) / ${SLOW_POLL_MS}ms (anonymous)`);

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  lazyConnect: false,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));
valkey.on('connect', () => console.log('Connected to Valkey'));

// API Gateway 클라이언트
const apiClient = new ApiGatewayManagementApiClient({
  endpoint: `https://${WEBSOCKET_ENDPOINT}`,
  region: AWS_REGION,
});

// === 캐시 (500ms용) ===
let depthCache = {};    // symbol -> depthJson
let tickerCache = {};   // symbol -> tickerJson
let candleCache = {};   // symbol -> candleData

// 상태 추적
let prevSymbolCount = 0;

// === 유틸리티 ===
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 410) {
      await cleanupConnection(connectionId);
    }
    return false;
  }
}

async function cleanupConnection(connectionId) {
  const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
  if (mainSymbol) {
    await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
    await valkey.srem(`symbol:${mainSymbol}:subscribers`, connectionId);
    await valkey.del(`conn:${connectionId}:main`);
  }
  await valkey.del(`ws:${connectionId}`);
  debug(`Cleaned stale connection: ${connectionId}`);
}

// === 데이터 조회 ===
async function fetchSymbolData(symbol) {
  const [depthJson, tickerJson, candle] = await Promise.all([
    valkey.get(`depth:${symbol}`),
    valkey.get(`ticker:${symbol}`),
    valkey.hgetall(`candle:1m:${symbol}`),
  ]);
  
  // 캐시 갱신 (500ms용)
  if (depthJson) depthCache[symbol] = depthJson;
  if (tickerJson) tickerCache[symbol] = tickerJson;
  if (candle && candle.t) candleCache[symbol] = candle;
  
  return { depthJson, tickerJson, candle };
}

// === 봉 마감 체크 ===
async function checkCandleClose(symbol) {
  const closed = await valkey.lpop(`candle:closed:1m:${symbol}`);
  if (closed) {
    debug(`Candle closed: ${symbol}`);
    return JSON.parse(closed);
  }
  return null;
}

// === 브로드캐스트 ===
async function broadcastToSubscribers(symbol, mainSubs, subSubs, data) {
  const { depthJson, tickerJson, candle, closedCandle } = data;
  
  // Main 구독자 → depth + candle
  if (mainSubs.length > 0) {
    const tasks = [];
    
    if (depthJson) {
      tasks.push(...mainSubs.map(id => sendToConnection(id, depthJson)));
    }
    
    if (candle && candle.t) {
      const candleMsg = JSON.stringify({ e: 'candle', tf: '1m', s: symbol, ...candle });
      tasks.push(...mainSubs.map(id => sendToConnection(id, candleMsg)));
    }
    
    if (closedCandle) {
      const closeMsg = JSON.stringify({ e: 'candle_close', tf: '1m', s: symbol, ...closedCandle });
      tasks.push(...mainSubs.map(id => sendToConnection(id, closeMsg)));
    }
    
    await Promise.allSettled(tasks);
    debug(`${symbol} sent to ${mainSubs.length} main subs`);
  }
  
  // Sub 구독자 → ticker only
  if (subSubs.length > 0 && tickerJson) {
    await Promise.allSettled(
      subSubs.map(id => sendToConnection(id, tickerJson))
    );
    debug(`${symbol} ticker sent to ${subSubs.length} subs`);
  }
}

// === 50ms 폴링 (실시간 사용자) ===
async function fastPollLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('subscribed:symbols');
      
      if (activeSymbols.length !== prevSymbolCount) {
        console.log(`[INFO] Active symbols: ${prevSymbolCount} → ${activeSymbols.length}`);
        prevSymbolCount = activeSymbols.length;
      }
      
      for (const symbol of activeSymbols) {
        // 구독자 조회
        const [mainSubs, subSubs, legacySubs] = await Promise.all([
          valkey.smembers(`symbol:${symbol}:main`),
          valkey.smembers(`symbol:${symbol}:sub`),
          valkey.smembers(`symbol:${symbol}:subscribers`),
        ]);
        
        const allMain = [...new Set([...mainSubs, ...legacySubs])];
        if (allMain.length === 0 && subSubs.length === 0) continue;
        
        // 데이터 조회 (캐시도 갱신)
        const { depthJson, tickerJson, candle } = await fetchSymbolData(symbol);
        
        // 봉 마감 체크
        const closedCandle = await checkCandleClose(symbol);
        
        // 브로드캐스트
        await broadcastToSubscribers(symbol, allMain, subSubs, {
          depthJson, tickerJson, candle, closedCandle
        });
      }
    } catch (error) {
      console.error('Fast poll error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, FAST_POLL_MS));
  }
}

// === 500ms 폴링 (익명 사용자) - 캐시 사용 ===
async function slowPollLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('subscribed:symbols');
      
      for (const symbol of activeSymbols) {
        // 익명 구독자만 (로그인 유저는 50ms에서 처리)
        // TODO: 익명/로그인 구분 로직 추가 필요
        // 현재는 50ms가 모든 구독자 처리하므로 이 루프는 캐시 유지용
      }
    } catch (error) {
      console.error('Slow poll error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, SLOW_POLL_MS));
  }
}

// === 시작 ===
console.log('Starting Streaming Server v2...');
fastPollLoop();
// slowPollLoop(); // 필요시 활성화
console.log('Streaming Server running. Press Ctrl+C to stop.');
