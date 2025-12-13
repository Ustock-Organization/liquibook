// trades-backup-handler Lambda v2
// 10분마다: candle:closed:* + trades:* → S3 + DynamoDB 백업

import Redis from 'ioredis';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
});

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';
const DYNAMODB_CANDLE_TABLE = process.env.DYNAMODB_CANDLE_TABLE || 'candle_history';
const DYNAMODB_TRADE_TABLE = process.env.DYNAMODB_TRADE_TABLE || 'trade_history';

export const handler = async (event) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hourStr = now.toISOString().slice(11, 13);
  const minStr = now.toISOString().slice(14, 16);
  
  console.log(`Backup started: ${dateStr} ${hourStr}:${minStr}`);
  
  try {
    const results = {
      candles: { count: 0, symbols: [] },
      trades: { count: 0, symbols: [] }
    };
    
    // === 1. 캔들 백업 ===
    const candleKeys = await valkey.keys('candle:closed:1m:*');
    console.log(`Found ${candleKeys.length} symbols with closed candles`);
    
    for (const key of candleKeys) {
      const symbol = key.replace('candle:closed:1m:', '');
      
      // 모든 마감 캔들 조회
      const closedCandles = await valkey.lrange(key, 0, -1);
      if (closedCandles.length === 0) continue;
      
      const candleData = closedCandles.map(c => {
        try { return JSON.parse(c); } catch (e) { return null; }
      }).filter(c => c !== null);
      
      if (candleData.length === 0) continue;
      
      // S3 저장
      const s3Key = `candles/timeframe=1m/symbol=${symbol}/year=${dateStr.slice(0,4)}/month=${dateStr.slice(4,6)}/day=${dateStr.slice(6,8)}/${hourStr}${minStr}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: JSON.stringify({ symbol, candles: candleData }),
        ContentType: 'application/json'
      }));
      
      // DynamoDB 저장
      for (const candle of candleData) {
        try {
          await dynamodb.send(new PutCommand({
            TableName: DYNAMODB_CANDLE_TABLE,
            Item: {
              pk: `CANDLE#${symbol}#1m`,
              sk: parseInt(candle.t),
              time: parseInt(candle.t),
              open: parseFloat(candle.o),
              high: parseFloat(candle.h),
              low: parseFloat(candle.l),
              close: parseFloat(candle.c),
              volume: parseFloat(candle.v) || 0,
              symbol,
              interval: '1m'
            }
          }));
        } catch (dbErr) {
          console.warn(`DynamoDB candle put failed: ${symbol}`, dbErr.message);
        }
      }
      
      // Valkey에서 백업된 캔들 삭제
      await valkey.del(key);
      
      results.candles.count += candleData.length;
      results.candles.symbols.push({ symbol, count: candleData.length });
      console.log(`Candle backup: ${symbol} - ${candleData.length} candles`);
    }
    
    // === 2. 체결 백업 (기존 로직) ===
    const tradeKeys = await valkey.keys('trades:*');
    console.log(`Found ${tradeKeys.length} symbols with trades`);
    
    for (const key of tradeKeys) {
      const symbol = key.replace('trades:', '');
      const trades = await valkey.lrange(key, 0, -1);
      
      if (trades.length === 0) continue;
      
      const tradeData = trades.map(t => {
        try { return JSON.parse(t); } catch (e) { return null; }
      }).filter(t => t !== null);
      
      // S3 저장
      const s3Key = `trades/${symbol}/${dateStr}/${hourStr}/${minStr}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: JSON.stringify({ symbol, date: dateStr, trades: tradeData }),
        ContentType: 'application/json'
      }));
      
      // DynamoDB 저장
      for (const trade of tradeData) {
        try {
          await dynamodb.send(new PutCommand({
            TableName: DYNAMODB_TRADE_TABLE,
            Item: {
              pk: `TRADE#${symbol}#${dateStr}`,
              sk: parseInt(trade.t),
              symbol,
              price: trade.p,
              quantity: trade.q,
              timestamp: trade.t,
              date: dateStr
            }
          }));
        } catch (dbErr) {
          console.warn(`DynamoDB trade put failed: ${symbol}`, dbErr.message);
        }
      }
      
      results.trades.count += tradeData.length;
      results.trades.symbols.push({ symbol, count: tradeData.length });
    }
    
    console.log(`Backup complete: ${results.candles.count} candles, ${results.trades.count} trades`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Backup complete',
        timestamp: `${dateStr} ${hourStr}:${minStr}`,
        ...results
      })
    };
    
  } catch (error) {
    console.error('Backup error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
