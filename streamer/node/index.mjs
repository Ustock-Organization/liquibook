// Streaming Server - API Gateway WebSocket 푸시
// Valkey에서 depth 캐시를 읽어 구독자에게 브로드캐스트
// 변경이 있을 때만 푸시 (폴링 대신 변경 감지)

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// 폴링 간격 (폴백용)
const POLL_INTERVAL_MS = 500;

// 디버그 로그 함수
function debug(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
}

console.log('=== Streaming Server Configuration ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT} (TLS: ${VALKEY_TLS})`);
console.log(`WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);
console.log(`Debug Mode: ${DEBUG_MODE}`);

// Valkey 연결 (데이터 조회용)
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

// 마지막 전송한 depth 데이터 캐시 (변경 감지용)
const lastDepthCache = new Map();

// 연결 ID로 메시지 전송
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (DEBUG_MODE) {
      console.error(`[ERROR] sendToConnection(${connectionId}):`, error.name, error.message);
    }
    
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊김 - 정리
      const connInfo = await valkey.get(`ws:${connectionId}`);
      if (connInfo) {
        const { userId } = JSON.parse(connInfo);
        if (userId) {
          await valkey.srem(`user:${userId}:connections`, connectionId);
        }
      }
      await valkey.del(`ws:${connectionId}`);
      console.log(`Removed stale connection: ${connectionId}`);
    }
    return false;
  }
}

// 심볼별 depth 브로드캐스트 (변경된 경우에만)
async function broadcastDepthIfChanged(symbol, subscribers) {
  const depthJson = await valkey.get(`depth:${symbol}`);
  if (!depthJson) return { sent: 0, changed: false };

  // 변경 감지: 마지막으로 보낸 데이터와 비교
  const lastDepth = lastDepthCache.get(symbol);
  if (lastDepth === depthJson) {
    debug(`${symbol}: No change, skipping broadcast`);
    return { sent: 0, changed: false };
  }

  // 변경됨 - 캐시 업데이트
  lastDepthCache.set(symbol, depthJson);

  const results = await Promise.allSettled(
    subscribers.map(connId => sendToConnection(connId, depthJson))
  );
  
  const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  return { sent, changed: true };
}

// 메인 푸시 루프 (폴링, 변경 감지 포함)
async function pushLoop() {
  let loopCount = 0;
  
  while (true) {
    try {
      loopCount++;
      
      // 활성 심볼 목록 조회
      const activeSymbols = await valkey.smembers('active:symbols');
      
      // 디버그: 루프 상태 출력 (20회마다)
      if (loopCount % 20 === 1) {
        debug(`Loop #${loopCount}, activeSymbols: ${JSON.stringify(activeSymbols)}`);
      }
      
      for (const symbol of activeSymbols) {
        const subscribers = await valkey.smembers(`symbol:${symbol}:subscribers`);
        
        if (subscribers.length > 0) {
          const { sent, changed } = await broadcastDepthIfChanged(symbol, subscribers);
          
          if (changed) {
            console.log(`[BROADCAST] ${symbol}: ${sent}/${subscribers.length} sent`);
          }
        }
      }
    } catch (error) {
      console.error('Push loop error:', error.message);
      if (DEBUG_MODE) {
        console.error(error.stack);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// 메인 시작
console.log('Starting Streaming Server...');
pushLoop();
console.log('Streaming Server running. Press Ctrl+C to stop.');
