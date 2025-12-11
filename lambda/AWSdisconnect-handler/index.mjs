// disconnect-handler Lambda
// 신구 버전 키 모두 정리

import Redis from 'ioredis';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  
  console.log(`Disconnecting: ${connectionId}`);
  
  try {
    // === Main 구독 해제 ===
    const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
    if (mainSymbol) {
      await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
      await valkey.srem(`symbol:${mainSymbol}:subscribers`, connectionId);
      await valkey.del(`conn:${connectionId}:main`);
      console.log(`Removed main: ${mainSymbol}`);
    }
    
    // === 모든 구독 정리 (SCAN) ===
    let cursor = '0';
    do {
      const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'symbol:*:*', 'COUNT', 100);
      cursor = newCursor;
      
      for (const key of keys) {
        if (key.endsWith(':subscribers') || key.endsWith(':main') || key.endsWith(':sub')) {
          const removed = await valkey.srem(key, connectionId);
          if (removed > 0) console.log(`Removed from ${key}`);
        }
      }
    } while (cursor !== '0');
    
    // === 연결 정보 정리 ===
    await valkey.del(`ws:${connectionId}`);
    
    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Disconnect error:', error.message);
    return { statusCode: 500, body: 'Error' };
  }
};
