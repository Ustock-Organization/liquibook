// trades-backup-handler Lambda
// 10분마다 + 매시 정각: trades:* 캐시 → S3 + DynamoDB 백업

import Redis from 'ioredis';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'trade_history';

export const handler = async (event) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const hourStr = now.toISOString().slice(11, 13); // HH
  const minStr = now.toISOString().slice(14, 16); // MM
  
  console.log(`Trades backup started: ${dateStr} ${hourStr}:${minStr}`);
  
  try {
    // 모든 trades:* 키 조회
    const tradeKeys = await valkey.keys('trades:*');
    console.log(`Found ${tradeKeys.length} symbol(s) with trades`);
    
    let totalTrades = 0;
    const backupResults = [];
    
    for (const key of tradeKeys) {
      const symbol = key.replace('trades:', '');
      
      // 모든 체결 내역 조회
      const trades = await valkey.lrange(key, 0, -1);
      
      if (trades.length === 0) {
        continue;
      }
      
      totalTrades += trades.length;
      
      // 체결 내역 파싱
      const tradeData = trades.map(t => {
        try {
          return JSON.parse(t);
        } catch (e) {
          return null;
        }
      }).filter(t => t !== null);
      
      // === S3 저장 (종목별 폴더 구조) ===
      const s3Key = `trades/${symbol}/${dateStr}/${hourStr}/${minStr}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: JSON.stringify({
          symbol,
          date: dateStr,
          time: `${hourStr}:${minStr}`,
          count: tradeData.length,
          trades: tradeData
        }),
        ContentType: 'application/json'
      }));
      console.log(`S3 saved: ${s3Key}`);
      
      // === DynamoDB 저장 (체결별로) ===
      for (const trade of tradeData) {
        try {
          await dynamodb.send(new PutCommand({
            TableName: DYNAMODB_TABLE,
            Item: {
              pk: `TRADE#${symbol}#${dateStr}`,  // Partition Key
              sk: `${trade.t}`,                   // Sort Key (timestamp)
              symbol,
              price: trade.p,
              quantity: trade.q,
              buyer_id: trade.b,
              seller_id: trade.s,
              buyer_order: trade.bo,
              seller_order: trade.so,
              timestamp: trade.t,
              date: dateStr
            }
          }));
        } catch (dbErr) {
          console.warn(`DynamoDB put failed for ${symbol}:`, dbErr.message);
        }
      }
      
      backupResults.push({
        symbol,
        count: tradeData.length,
        s3Key
      });
      
      // 캐시에서 백업된 내역 삭제 (옵션: 보관하려면 주석 처리)
      // await valkey.del(key);
    }
    
    console.log(`Backup complete: ${totalTrades} trades from ${backupResults.length} symbols`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Trades backup complete',
        date: `${dateStr} ${hourStr}:${minStr}`,
        totalTrades,
        symbols: backupResults
      })
    };
    
  } catch (error) {
    console.error('Backup error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
