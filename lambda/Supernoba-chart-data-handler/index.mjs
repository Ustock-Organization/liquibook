// chart-data-handler Lambda v2
// Hot/Cold 하이브리드 조회 - Valkey(최근) + DynamoDB(과거)
// 백업 갭 처리: 10분 미만 데이터는 Valkey candle:closed:* 에서 조회

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
});

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'candle_history';
const HOT_DATA_TTL_MS = 10 * 60 * 1000; // 10분

// 타임프레임별 분 수
const INTERVAL_MINUTES = {
  '1m': 1, '3m': 3, '5m': 5, '10m': 10,
  '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
};

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const symbol = (params.symbol || 'TEST').toUpperCase();
  const interval = params.interval || '1m';
  const limit = Math.min(parseInt(params.limit || '100'), 500);
  
  console.log(`Chart request: ${symbol} ${interval} limit=${limit}`);
  
  try {
    const minutes = INTERVAL_MINUTES[interval];
    if (!minutes) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid interval: ${interval}` }) };
    }
    
    // === 데이터 조회 ===
    const minuteCandlesNeeded = limit * minutes;
    
    // 1. Hot 데이터 (Valkey) - 최근 10분
    const hotCandles = await getHotCandles(symbol);
    
    // 2. Cold 데이터 (DynamoDB) - 과거
    const coldCandles = await getColdCandles(symbol, minuteCandlesNeeded);
    
    // 3. 활성 캔들 (현재 진행 중)
    const activeCandle = await getActiveCandle(symbol);
    
    // 4. 병합 및 중복 제거
    let oneMinCandles = mergeCandles(coldCandles, hotCandles, activeCandle);
    
    console.log(`Data: cold=${coldCandles.length}, hot=${hotCandles.length}, active=${activeCandle ? 1 : 0}`);
    
    if (oneMinCandles.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ symbol, interval, data: [] }) };
    }
    
    // 1분봉 그대로 반환
    if (interval === '1m') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ symbol, interval, data: oneMinCandles.slice(-limit).map(formatCandle) })
      };
    }
    
    // 상위 타임프레임 집계
    const aggregated = aggregateCandles(oneMinCandles, minutes);
    
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ symbol, interval, data: aggregated.slice(-limit).map(formatCandle) })
    };
    
  } catch (error) {
    console.error('Chart data error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// === Hot 데이터: Valkey candle:closed:* ===
async function getHotCandles(symbol) {
  try {
    const closedList = await valkey.lrange(`candle:closed:1m:${symbol}`, 0, -1);
    
    return closedList.map(item => {
      try {
        const parsed = JSON.parse(item);
        return {
          time: parseInt(parsed.t),
          open: parseFloat(parsed.o),
          high: parseFloat(parsed.h),
          low: parseFloat(parsed.l),
          close: parseFloat(parsed.c),
          volume: parseFloat(parsed.v) || 0
        };
      } catch (e) {
        return null;
      }
    }).filter(c => c !== null);
    
  } catch (error) {
    console.error('Valkey hot candles error:', error.message);
    return [];
  }
}

// === 활성 캔들: Valkey candle:1m:* ===
async function getActiveCandle(symbol) {
  try {
    const candle = await valkey.hgetall(`candle:1m:${symbol}`);
    
    if (!candle || !candle.t) return null;
    
    return {
      time: parseInt(candle.t),
      open: parseFloat(candle.o),
      high: parseFloat(candle.h),
      low: parseFloat(candle.l),
      close: parseFloat(candle.c),
      volume: parseFloat(candle.v) || 0,
      active: true  // 진행 중 표시
    };
    
  } catch (error) {
    console.error('Valkey active candle error:', error.message);
    return null;
  }
}

// === Cold 데이터: DynamoDB ===
async function getColdCandles(symbol, limit) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `CANDLE#${symbol}#1m` },
      ScanIndexForward: false,
      Limit: limit
    }));
    
    if (!result.Items || result.Items.length === 0) return [];
    
    return result.Items.map(item => ({
      time: item.time || item.sk,
      open: item.open || item.o,
      high: item.high || item.h,
      low: item.low || item.l,
      close: item.close || item.c,
      volume: item.volume || item.v || 0
    })).sort((a, b) => a.time - b.time);
    
  } catch (error) {
    console.error('DynamoDB query error:', error);
    return [];
  }
}

// === 병합 및 중복 제거 ===
function mergeCandles(cold, hot, active) {
  const timeMap = new Map();
  
  // Cold 먼저 (오래된 데이터)
  for (const c of cold) {
    timeMap.set(c.time, c);
  }
  
  // Hot으로 덮어쓰기 (최신 데이터)
  for (const c of hot) {
    timeMap.set(c.time, c);
  }
  
  // 활성 캔들 추가
  if (active) {
    timeMap.set(active.time, active);
  }
  
  // 시간순 정렬
  return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
}

// === 상위 타임프레임 집계 ===
function aggregateCandles(oneMinCandles, intervalMinutes) {
  if (oneMinCandles.length === 0) return [];
  
  const result = [];
  
  for (let i = 0; i < oneMinCandles.length; i += intervalMinutes) {
    const group = oneMinCandles.slice(i, i + intervalMinutes);
    if (group.length === 0) continue;
    
    const startTime = Math.floor(group[0].time / (intervalMinutes * 60)) * (intervalMinutes * 60);
    
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
      open: group[0].open,
      high, low,
      close: group[group.length - 1].close,
      volume
    });
  }
  
  return result;
}

// === 포맷 ===
function formatCandle(candle) {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
    ...(candle.active && { active: true })
  };
}
