// symbol-manager Lambda
// 종목 관리 API (공개: 조회, Admin: 추가/삭제)

import Redis from 'ioredis';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));

// CORS 헤더
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Admin 권한 확인 (추후 Cognito/API Key로 확장)
function isAdmin(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  // TODO: 실제 권한 검증 로직 (Cognito, API Key 등)
  return authHeader === process.env.ADMIN_API_KEY;
}

export const handler = async (event) => {
  // OPTIONS 요청 처리
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const method = event.httpMethod || event.requestContext?.http?.method;
  const pathParams = event.pathParameters || {};
  const symbol = pathParams.symbol;
  
  try {
    // GET /symbols - 종목 목록 조회 (공개)
    // "호가 캐시(depth:*)"에 존재하는 모든 종목을 스캔하여 반환
    if (method === 'GET' && !symbol) {
      const symbols = new Set();
      let cursor = '0';
      
      do {
        // depth:* 키 스캔 (실제 엔진이 돌고 있는 종목들)
        const [nextCursor, keys] = await valkey.scan(cursor, 'MATCH', 'depth:*', 'COUNT', 100);
        cursor = nextCursor;
        
        keys.forEach(key => {
          // depth:TEST -> TEST
          const sym = key.replace('depth:', '');
          if(sym) symbols.add(sym);
        });
      } while (cursor !== '0');

      const symbolList = Array.from(symbols).sort();
      console.log(`Found ${symbolList.length} active symbols from cache:`, symbolList);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          symbols: symbolList,
          count: symbolList.length,
          source: 'cache_scan'
        }),
      };
    }
    
    // GET /symbols/{symbol} - 종목 상세 조회 (공개)
    if (method === 'GET' && symbol) {
      const exists = await valkey.sismember('active:symbols', symbol);
      if (!exists) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Symbol not found', symbol }),
        };
      }
      
      // 추가 정보 조회 (ticker, depth 등)
      const [ticker, depth] = await Promise.all([
        valkey.get(`ticker:${symbol}`),
        valkey.get(`depth:${symbol}`),
      ]);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          symbol,
          active: true,
          ticker: ticker ? JSON.parse(ticker) : null,
          depth: depth ? JSON.parse(depth) : null,
        }),
      };
    }
    
    // POST /symbols - 종목 추가 (Admin)
    if (method === 'POST') {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
      }
      
      const body = JSON.parse(event.body || '{}');
      const newSymbol = body.symbol?.toUpperCase();
      
      if (!newSymbol) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'symbol is required' }) };
      }
      
      const added = await valkey.sadd('active:symbols', newSymbol);
      console.log(`Symbol added: ${newSymbol}, new=${added > 0}`);
      
      return {
        statusCode: added > 0 ? 201 : 200,
        headers,
        body: JSON.stringify({
          message: added > 0 ? 'Symbol added' : 'Symbol already exists',
          symbol: newSymbol,
        }),
      };
    }
    
    // DELETE /symbols/{symbol} - 종목 삭제 (Admin)
    if (method === 'DELETE' && symbol) {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
      }
      
      const removed = await valkey.srem('active:symbols', symbol);
      console.log(`Symbol removed: ${symbol}, existed=${removed > 0}`);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: removed > 0 ? 'Symbol removed' : 'Symbol not found',
          symbol,
        }),
      };
    }
    
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
