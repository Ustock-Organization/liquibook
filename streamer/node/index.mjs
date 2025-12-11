// Streaming Server - 신구 버전 모두 지원
// 구버전: symbol:*:subscribers
// 신버전: symbol:*:main, symbol:*:sub

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const POLL_INTERVAL_MS = 500;

function debug(...args) {
  if (DEBUG_MODE) console.log('[DEBUG]', ...args);
}

console.log('=== Streaming Server Configuration ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT} (TLS: ${VALKEY_TLS})`);
console.log(`WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);

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

// 상태 추적
let prevSymbolCount = 0;

// 연결 ID로 메시지 전송
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

// 심볼별 브로드캐스트
async function broadcastSymbol(symbol) {
  // 구독자 조회 (신구 버전 모두)
  const [mainSubs, subSubs, legacySubs] = await Promise.all([
    valkey.smembers(`symbol:${symbol}:main`),
    valkey.smembers(`symbol:${symbol}:sub`),
    valkey.smembers(`symbol:${symbol}:subscribers`),
  ]);
  
  // 모든 구독자 합치기 (중복 제거)
  const allSubs = [...new Set([...mainSubs, ...subSubs, ...legacySubs])];
  
  if (allSubs.length === 0) return;
  
  // depth 데이터 조회
  const depthJson = await valkey.get(`depth:${symbol}`);
  if (!depthJson) return;
  
  // ticker 데이터 조회 (있으면)
  const tickerJson = await valkey.get(`ticker:${symbol}`);
  
  // Main 구독자 → depth
  if (mainSubs.length > 0 || legacySubs.length > 0) {
    const mainAllSubs = [...new Set([...mainSubs, ...legacySubs])];
    await Promise.allSettled(
      mainAllSubs.map(connId => sendToConnection(connId, depthJson))
    );
    debug(`${symbol} depth sent to ${mainAllSubs.length} subscribers`);
  }
  
  // Sub 구독자 → ticker (있으면)
  if (subSubs.length > 0 && tickerJson) {
    await Promise.allSettled(
      subSubs.map(connId => sendToConnection(connId, tickerJson))
    );
    debug(`${symbol} ticker sent to ${subSubs.length} subscribers`);
  }
}

// 메인 푸시 루프
async function pushLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('active:symbols');
      
      if (activeSymbols.length !== prevSymbolCount) {
        console.log(`[INFO] Active symbols: ${prevSymbolCount} → ${activeSymbols.length}`);
        prevSymbolCount = activeSymbols.length;
      }
      
      for (const symbol of activeSymbols) {
        await broadcastSymbol(symbol);
      }
    } catch (error) {
      console.error('Push loop error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// 시작
console.log('Starting Streaming Server...');
pushLoop();
console.log('Streaming Server running. Press Ctrl+C to stop.');
