// candle-aggregator Lambda
// 매 분 실행: trades:SYMBOL → 1분봉 집계 → DynamoDB 저장

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

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

export const handler = async (event) => {
  // 현재 시간에서 1분 전 구간 계산 (KST)
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  
  // 1분 전 시작 시간 (분 단위로 내림)
  const candleEnd = Math.floor(kstNow.getTime() / 60000) * 60; // 초 단위
  const candleStart = candleEnd - 60; // 1분 전
  
  console.log(`Aggregating 1m candles: ${new Date(candleStart * 1000).toISOString()}`);
  
  try {
    // 모든 종목의 trades 조회
    const tradeKeys = await valkey.keys('trades:*');
    console.log(`Found ${tradeKeys.length} symbols`);
    
    let aggregated = 0;
    
    for (const key of tradeKeys) {
      const symbol = key.replace('trades:', '');
      
      // 최근 체결 내역 조회 (최대 1000개)
      const trades = await valkey.lrange(key, 0, 999);
      
      // 지난 1분 구간의 체결만 필터
      const candleTrades = [];
      for (const tradeStr of trades) {
        try {
          const trade = JSON.parse(tradeStr);
          if (trade.t >= candleStart && trade.t < candleEnd) {
            candleTrades.push(trade);
          }
        } catch (e) {
          // 파싱 실패 무시
        }
      }
      
      if (candleTrades.length === 0) {
        continue; // 해당 구간 체결 없음
      }
      
      // 시간순 정렬
      candleTrades.sort((a, b) => a.t - b.t);
      
      // OHLCV 계산
      const open = candleTrades[0].p;
      const close = candleTrades[candleTrades.length - 1].p;
      let high = open;
      let low = open;
      let volume = 0;
      
      for (const t of candleTrades) {
        if (t.p > high) high = t.p;
        if (t.p < low) low = t.p;
        volume += t.q;
      }
      
      // DynamoDB에 저장
      await dynamodb.send(new PutCommand({
        TableName: DYNAMODB_TABLE,
        Item: {
          pk: `CANDLE#${symbol}#1m`,
          sk: candleStart,
          symbol,
          interval: '1m',
          time: candleStart,
          open,
          high,
          low,
          close,
          volume,
          trades: candleTrades.length
        }
      }));
      
      aggregated++;
      console.log(`1m candle saved: ${symbol} o=${open} h=${high} l=${low} c=${close} v=${volume}`);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: '1m candles aggregated',
        timestamp: candleStart,
        symbols: aggregated
      })
    };
    
  } catch (error) {
    console.error('Aggregation error:', error);
    return { statusCode: 500, body: error.message };
  }
};
