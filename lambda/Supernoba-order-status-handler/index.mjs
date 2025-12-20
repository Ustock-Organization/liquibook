// order-status-handler Lambda
// Kinesis 트리거: supernoba-order-status 스트림에서 주문 상태 변경 이벤트 수신
// WebSocket으로 해당 사용자에게 실시간 알림 전송

import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import Redis from 'ioredis';

// === 환경변수 ===
const VALKEY_HOST = process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT; // wss://xxx.execute-api.region.amazonaws.com/prod

console.log('[INIT] order-status-handler starting...');
console.log(`[INIT] WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  lazyConnect: true,
});

valkey.on('error', (err) => console.error('[VALKEY] Error:', err.message));

// API Gateway Management Client (지연 초기화)
let apiClient = null;
function getApiClient() {
  if (!apiClient && WEBSOCKET_ENDPOINT) {
    // wss:// → https:// 변환
    const endpoint = WEBSOCKET_ENDPOINT.replace('wss://', 'https://').replace('ws://', 'http://');
    apiClient = new ApiGatewayManagementApiClient({ endpoint });
  }
  return apiClient;
}

// === WebSocket 메시지 전송 ===
async function sendToConnection(connectionId, data) {
  const client = getApiClient();
  if (!client) {
    console.error('[WS] No WebSocket endpoint configured');
    return false;
  }
  
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(data)
    }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊김 - 정리
      console.log('[WS] Connection gone:', connectionId);
      return false;
    }
    console.error('[WS] Send failed:', error.message);
    return false;
  }
}

// === 메인 핸들러 (Kinesis 트리거) ===
export const handler = async (event) => {
  console.log(`[HANDLER] Received ${event.Records?.length || 0} records`);
  
  // Valkey 연결 확인
  if (valkey.status !== 'ready') {
    await valkey.connect();
  }
  
  let processed = 0;
  let failed = 0;
  
  for (const record of event.Records || []) {
    try {
      // Kinesis 데이터 디코딩
      const payload = JSON.parse(
        Buffer.from(record.kinesis.data, 'base64').toString('utf-8')
      );
      
      // 필수 필드 확인
      const { user_id, order_id, status, symbol, reason } = payload;
      if (!user_id || !order_id || !status) {
        console.warn('[HANDLER] Missing required fields:', payload);
        continue;
      }
      
      console.log(`[HANDLER] Order ${order_id}: ${status} for user ${user_id}`);
      
      // 사용자의 WebSocket 연결 목록 조회
      const connections = await valkey.smembers(`user:${user_id}:connections`);
      
      if (!connections || connections.length === 0) {
        console.log(`[HANDLER] No active connections for user ${user_id}`);
        continue;
      }
      
      // WebSocket 메시지 구성
      const wsMessage = {
        type: 'ORDER_STATUS',
        order_id,
        symbol,
        status,
        reason: reason || null,
        timestamp: Date.now()
      };
      
      // 모든 연결에 전송
      let sentCount = 0;
      for (const connId of connections) {
        const sent = await sendToConnection(connId, wsMessage);
        if (sent) sentCount++;
      }
      
      console.log(`[HANDLER] Sent to ${sentCount}/${connections.length} connections for user ${user_id}`);
      processed++;
      
    } catch (err) {
      console.error('[HANDLER] Record processing error:', err.message);
      failed++;
    }
  }
  
  console.log(`[HANDLER] Completed: ${processed} processed, ${failed} failed`);
  
  return {
    statusCode: 200,
    body: JSON.stringify({ processed, failed })
  };
};
