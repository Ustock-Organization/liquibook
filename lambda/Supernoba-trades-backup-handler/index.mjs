// trades-backup-handler Lambda v2
// 10분마다: candle:closed:* + trades:* → S3 + DynamoDB 백업

import Redis from 'ioredis';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_HOST = process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// 디버그 로그 헬퍼 함수
const debug = (...args) => { if (DEBUG_MODE) console.log(...args); };

console.log('[INIT] trades-backup-handler starting...');
console.log(`[INIT] DEBUG_MODE: ${DEBUG_MODE}`);
debug(`[INIT] VALKEY_HOST: ${VALKEY_HOST}`);
debug(`[INIT] VALKEY_PORT: ${VALKEY_PORT}`);
debug(`[INIT] VALKEY_TLS: ${VALKEY_TLS}`);
debug(`[INIT] S3_BUCKET: ${process.env.S3_BUCKET || 'supernoba-market-data'}`);
debug(`[INIT] DYNAMODB_CANDLE_TABLE: ${process.env.DYNAMODB_CANDLE_TABLE || 'candle_history'}`);

const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  commandTimeout: 10000,
});

valkey.on('connect', () => console.log('[REDIS] Connected to Valkey'));
valkey.on('error', (err) => console.error('[REDIS] Connection error:', err.message));
valkey.on('close', () => console.log('[REDIS] Connection closed'));

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';
const DYNAMODB_CANDLE_TABLE = process.env.DYNAMODB_CANDLE_TABLE || 'candle_history';
const DYNAMODB_TRADE_TABLE = process.env.DYNAMODB_TRADE_TABLE || 'trade_history';

export const handler = async (event) => {
  console.log('[HANDLER] Lambda invoked');
  debug('[HANDLER] Event:', JSON.stringify(event));
  
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hourStr = now.toISOString().slice(11, 13);
  const minStr = now.toISOString().slice(14, 16);
  
  console.log(`[HANDLER] Backup started: ${dateStr} ${hourStr}:${minStr}`);
  
  try {
    // Redis 연결 상태 확인
    debug('[REDIS] Checking connection...');
    const pingResult = await valkey.ping();
    debug(`[REDIS] Ping result: ${pingResult}`);
    
    const results = {
      candles: { count: 0, symbols: [] },
      trades: { count: 0, symbols: [] }
    };
    
    // === 1. 캔들 백업 ===
    debug('[CANDLE] Searching for closed candle keys...');
    const candleKeys = await valkey.keys('candle:closed:1m:*');
    console.log(`[CANDLE] Found ${candleKeys.length} symbols with closed candles`);
    debug(`[CANDLE] Keys: ${JSON.stringify(candleKeys)}`);
    
    for (const key of candleKeys) {
      const symbol = key.replace('candle:closed:1m:', '');
      debug(`[CANDLE] Processing symbol: ${symbol}`);
      
      // 모든 마감 캔들 조회
      const closedCandles = await valkey.lrange(key, 0, -1);
      debug(`[CANDLE] ${symbol}: Found ${closedCandles.length} candles in list`);
      
      if (closedCandles.length === 0) {
        debug(`[CANDLE] ${symbol}: Skipping - no candles`);
        continue;
      }
      
      // 첫 번째 캔들 샘플 출력
      debug(`[CANDLE] ${symbol}: First candle sample: ${closedCandles[0]}`);
      
      const candleData = closedCandles.map(c => {
        try { return JSON.parse(c); } catch (e) { return null; }
      }).filter(c => c !== null);
      
      debug(`[CANDLE] ${symbol}: Parsed ${candleData.length} valid candles`);
      
      if (candleData.length === 0) {
        debug(`[CANDLE] ${symbol}: Skipping - no valid parsed candles`);
        continue;
      }
      
      // S3 저장
      const s3Key = `candles/timeframe=1m/symbol=${symbol}/year=${dateStr.slice(0,4)}/month=${dateStr.slice(4,6)}/day=${dateStr.slice(6,8)}/${hourStr}${minStr}.json`;
      debug(`[S3] ${symbol}: Saving to ${s3Key}`);
      try {
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: JSON.stringify({ symbol, candles: candleData }),
          ContentType: 'application/json'
        }));
        debug(`[S3] ${symbol}: Save successful`);
      } catch (s3Err) {
        console.error(`[S3] ${symbol}: Save failed - ${s3Err.message}`);
      }
      
      // DynamoDB 저장
      debug(`[DYNAMO] ${symbol}: Saving ${candleData.length} candles to DynamoDB`);
      let dynamoSuccess = 0, dynamoFail = 0;
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
          dynamoSuccess++;
        } catch (dbErr) {
          dynamoFail++;
          console.warn(`[DYNAMO] ${symbol}: Put failed - ${dbErr.message}`);
        }
      }
      debug(`[DYNAMO] ${symbol}: Completed - ${dynamoSuccess} success, ${dynamoFail} failed`);
      
      // Valkey에서 백업된 캔들 삭제
      debug(`[REDIS] ${symbol}: Deleting backup key ${key}`);
      await valkey.del(key);
      
      results.candles.count += candleData.length;
      results.candles.symbols.push({ symbol, count: candleData.length });
      debug(`[CANDLE] ${symbol}: Backup complete - ${candleData.length} candles`);
    }
    
    // === 2. 체결 백업 (배치 처리) ===
    const tradeKeys = await valkey.keys('trades:*');
    console.log(`[TRADE] Found ${tradeKeys.length} symbols with trades`);
    debug(`[TRADE] Keys: ${JSON.stringify(tradeKeys)}`);
    
    const BATCH_SIZE = 500;  // 메모리 효율을 위한 배치 크기
    
    for (const key of tradeKeys) {
      const symbol = key.replace('trades:', '');
      debug(`[TRADE] Processing symbol: ${symbol}`);
      
      // 전체 개수 먼저 확인
      const totalCount = await valkey.llen(key);
      debug(`[TRADE] ${symbol}: Total ${totalCount} trades in list`);
      
      if (totalCount === 0) {
        debug(`[TRADE] ${symbol}: Skipping - no trades`);
        continue;
      }
      
      let processedCount = 0;
      let allTradeData = [];
      let sampleLogged = false;
      
      // 배치 단위로 처리
      for (let start = 0; start < totalCount; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, totalCount - 1);
        debug(`[TRADE] ${symbol}: Fetching batch ${start}-${end}`);
        
        const batch = await valkey.lrange(key, start, end);
        
        const batchData = batch.map(t => {
          try { return JSON.parse(t); } catch (e) { return null; }
        }).filter(t => t !== null);
        
        // 첫 번째 아이템 샘플 로그
        if (!sampleLogged && batchData.length > 0) {
          debug(`[TRADE] ${symbol}: Sample trade item:`, JSON.stringify(batchData[0]));
          sampleLogged = true;
        }
        
        allTradeData = allTradeData.concat(batchData);
        processedCount += batchData.length;
        debug(`[TRADE] ${symbol}: Batch processed, ${processedCount}/${totalCount} trades`);
      }
      
      debug(`[TRADE] ${symbol}: Total ${allTradeData.length} valid trades parsed`);
      
      if (allTradeData.length === 0) {
        debug(`[TRADE] ${symbol}: Skipping - no valid trades`);
        continue;
      }
      
      // S3 저장 (청크 분할)
      const S3_CHUNK_SIZE = 10000;  // 청크당 최대 10,000개
      const totalChunks = Math.ceil(allTradeData.length / S3_CHUNK_SIZE);
      
      let s3Success = 0, s3Fail = 0;
      for (let i = 0; i < allTradeData.length; i += S3_CHUNK_SIZE) {
        const chunk = allTradeData.slice(i, i + S3_CHUNK_SIZE);
        const chunkIndex = Math.floor(i / S3_CHUNK_SIZE);
        const s3Key = totalChunks === 1 
          ? `trades/${symbol}/${dateStr}/${hourStr}/${minStr}.json`
          : `trades/${symbol}/${dateStr}/${hourStr}/${minStr}_part${chunkIndex}.json`;
        
        debug(`[S3] ${symbol}: Uploading chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} trades) to ${s3Key}`);
        try {
          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            Body: JSON.stringify({ 
              symbol, 
              date: dateStr, 
              chunkIndex,
              totalChunks,
              trades: chunk 
            }),
            ContentType: 'application/json'
          }));
          s3Success++;
          debug(`[S3] ${symbol}: Chunk ${chunkIndex + 1} uploaded successfully`);
        } catch (s3Err) {
          s3Fail++;
          console.error(`[S3] ${symbol}: Chunk ${chunkIndex + 1} failed - ${s3Err.message}`);
        }
      }
      console.log(`[S3] ${symbol}: Upload complete - ${s3Success}/${totalChunks} chunks succeeded`);
      
      // DynamoDB 저장 (BatchWrite - 25개씩)
      const DYNAMO_BATCH_SIZE = 25;  // DynamoDB BatchWrite 최대 25개
      const dynamoBatches = Math.ceil(allTradeData.length / DYNAMO_BATCH_SIZE);
      
      let dynamoSuccess = 0, dynamoFail = 0;
      
      for (let i = 0; i < allTradeData.length; i += DYNAMO_BATCH_SIZE) {
        const batch = allTradeData.slice(i, i + DYNAMO_BATCH_SIZE);
        const batchNum = Math.floor(i / DYNAMO_BATCH_SIZE) + 1;
        
        const putRequests = batch.map(trade => ({
          PutRequest: {
            Item: {
              pk: `TRADE#${symbol}#${dateStr}`,
              sk: parseInt(trade.t),
              symbol,
              price: trade.p,
              quantity: trade.q,
              timestamp: trade.t,
              date: dateStr
            }
          }
        }));
        
        try {
          await dynamodb.send(new BatchWriteCommand({
            RequestItems: {
              [DYNAMODB_TRADE_TABLE]: putRequests
            }
          }));
          dynamoSuccess += batch.length;
          
          // 진행률 로그 (10% 단위)
          if (batchNum % Math.ceil(dynamoBatches / 10) === 0 || batchNum === dynamoBatches) {
            debug(`[DYNAMO] ${symbol}: Progress ${batchNum}/${dynamoBatches} batches (${dynamoSuccess} items)`);
          }
        } catch (dbErr) {
          dynamoFail += batch.length;
          console.warn(`[DYNAMO] ${symbol}: Batch ${batchNum} failed - ${dbErr.message}`);
        }
      }
      console.log(`[DYNAMO] ${symbol}: Completed - ${dynamoSuccess} success, ${dynamoFail} failed`);
      
      // 백업 완료 후 Valkey에서 삭제
      debug(`[REDIS] ${symbol}: Deleting trades key ${key}`);
      await valkey.del(key);
      
      results.trades.count += allTradeData.length;
      results.trades.symbols.push({ symbol, count: allTradeData.length });
      debug(`[TRADE] ${symbol}: Backup complete - ${allTradeData.length} trades`);
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
