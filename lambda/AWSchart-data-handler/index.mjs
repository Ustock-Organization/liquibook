// chart-data-handler Lambda
// 차트 데이터 REST API - 1분봉을 쿼리 시 상위 타임프레임으로 집계
// 지원: 1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'candle_history';

// 타임프레임별 분 수
const INTERVAL_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '10m': 10,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440
};

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const symbol = params.symbol || 'TEST';
  const interval = params.interval || '1m';
  const limit = Math.min(parseInt(params.limit || '100'), 500);
  
  console.log(`Chart request: ${symbol} ${interval} limit=${limit}`);
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  try {
    const minutes = INTERVAL_MINUTES[interval];
    if (!minutes) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Invalid interval: ${interval}` })
      };
    }
    
    // 1분봉 필요 개수 계산
    const minuteCandlesNeeded = limit * minutes;
    
    // DynamoDB에서 1분봉 조회
    const oneMinCandles = await get1mCandles(symbol, minuteCandlesNeeded);
    
    if (oneMinCandles.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ symbol, interval, data: [] })
      };
    }
    
    // 1분봉 그대로 반환
    if (interval === '1m') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          symbol,
          interval,
          data: oneMinCandles.slice(-limit).map(formatCandle)
        })
      };
    }
    
    // 상위 타임프레임으로 집계
    const aggregated = aggregateCandles(oneMinCandles, minutes);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbol,
        interval,
        data: aggregated.slice(-limit).map(formatCandle)
      })
    };
    
  } catch (error) {
    console.error('Chart data error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// DynamoDB에서 1분봉 조회
async function get1mCandles(symbol, limit) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `CANDLE#${symbol}#1m`
      },
      ScanIndexForward: false,  // 최신순
      Limit: limit
    }));
    
    if (!result.Items || result.Items.length === 0) {
      return [];
    }
    
    // 시간순 정렬 (오래된 것 → 최신)
    return result.Items.sort((a, b) => a.sk - b.sk);
    
  } catch (error) {
    console.error('DynamoDB query error:', error);
    return [];
  }
}

// 1분봉 → 상위 타임프레임 집계
function aggregateCandles(oneMinCandles, intervalMinutes) {
  if (oneMinCandles.length === 0) return [];
  
  const result = [];
  
  // intervalMinutes 단위로 그룹핑
  for (let i = 0; i < oneMinCandles.length; i += intervalMinutes) {
    const group = oneMinCandles.slice(i, i + intervalMinutes);
    
    if (group.length === 0) continue;
    
    // 그룹의 시작 시간 (interval 단위로 내림)
    const startTime = Math.floor(group[0].time / (intervalMinutes * 60)) * (intervalMinutes * 60);
    
    // OHLCV 집계
    const open = group[0].open;
    const close = group[group.length - 1].close;
    let high = group[0].high;
    let low = group[0].low;
    let volume = 0;
    
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume || 0;
    }
    
    result.push({
      time: startTime,
      open,
      high,
      low,
      close,
      volume
    });
  }
  
  return result;
}

// lightweight-charts 호환 포맷
function formatCandle(candle) {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0
  };
}
