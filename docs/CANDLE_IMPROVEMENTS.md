# 캔들 데이터 시스템 개선 제안

현재 구현의 문제점과 개선 방안을 제안합니다.

---

## 1. 성능 최적화

### 1.1 DynamoDB BatchWrite 활용

**현재 문제**: 1분봉 저장 시 개별 PutCommand 사용 (N번 API 호출)

```javascript
// 현재 코드 (비효율적)
for (const candle of candleData) {
    await dynamodb.send(new PutCommand({ ... }));
}
```

**개선 제안**: BatchWriteCommand로 25개씩 묶어서 처리

```javascript
// 개선된 코드
const BATCH_SIZE = 25;
for (let i = 0; i < candleData.length; i += BATCH_SIZE) {
    const batch = candleData.slice(i, i + BATCH_SIZE);
    await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
            [DYNAMODB_CANDLE_TABLE]: batch.map(c => ({
                PutRequest: { Item: { pk: `CANDLE#${symbol}#1m`, sk: c.t, ... } }
            }))
        }
    }));
}
```

**효과**: API 호출 횟수 96% 감소 (100개 캔들 기준: 100회 → 4회)

---

### 1.2 Valkey SCAN 대신 KEYS 패턴 개선

**현재 문제**: `valkey.keys('candle:closed:1m:*')` - 대규모 환경에서 블로킹

**개선 제안**: SCAN 커서 기반 반복

```javascript
async function* scanKeys(pattern) {
    let cursor = '0';
    do {
        const [nextCursor, keys] = await valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) yield key;
    } while (cursor !== '0');
}

// 사용
for await (const key of scanKeys('candle:closed:1m:*')) {
    // 처리
}
```

---

### 1.3 상위 타임프레임 점진적 저장

**현재 문제**: 10분마다 모든 타임프레임 재계산

**개선 제안**: 타임프레임별 독립 저장 주기

| Interval | 저장 주기 | 트리거 조건 |
|----------|----------|-------------|
| 1m, 3m, 5m | 10분 | 현재 유지 |
| 15m, 30m | 30분 | EventBridge 별도 |
| 1h, 4h | 1시간 | EventBridge 별도 |
| 1d, 1w | 일간 | Daily backup Lambda |

---

## 2. 데이터 정합성

### 2.1 거래 없는 분(Doji) 처리

**현재 문제**: 체결 없으면 캔들 생성 안됨 → 차트에 빈 구간

**개선 제안**: Streamer에서 시간 기반 Doji 생성

```javascript
// streamer/node/index.mjs에 추가
async function generateMissingCandles(symbol) {
    const lastCandle = await valkey.hgetall(`candle:1m:${symbol}`);
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(now / 60) * 60;
    
    if (lastCandle?.t && parseInt(lastCandle.t) < currentMinute - 60) {
        // 빈 분에 대해 Doji 생성 (이전 종가 = 현재 OHLC)
        const prevClose = parseFloat(lastCandle.c);
        await valkey.hmset(`candle:1m:${symbol}`, {
            o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0, t: currentMinute
        });
    }
}
```

---

### 2.2 Lua Script 분산 락

**현재 문제**: 동시 체결 시 Race Condition 가능성

**개선 제안**: WATCH/MULTI 대신 Lua Script 내부에서 원자적 처리 (현재 구현됨 ✅)

> 현재 Lua Script는 원자적으로 동작하므로 추가 개선 불필요

---

### 2.3 TTL 조정

**현재 설정**:
- `candle:1m:SYMBOL`: 5분 (너무 짧음)
- `candle:closed:1m:SYMBOL`: 1시간

**개선 제안**:
- `candle:1m:SYMBOL`: 10분 (백업 주기의 2배)
- `candle:closed:1m:SYMBOL`: 2시간 (더 안전한 버퍼)

```cpp
// redis_client.cpp 수정
redis.call("EXPIRE", key, 600)        // 5분 → 10분
redis.call("EXPIRE", closedKey, 7200) // 1시간 → 2시간
```

---

## 3. 모니터링 & 알림

### 3.1 CloudWatch 메트릭 추가

```javascript
// trades-backup-handler에 추가
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatchClient({});

await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'Supernoba/Candles',
    MetricData: [
        { MetricName: 'CandlesBackedUp', Value: candleCount, Unit: 'Count' },
        { MetricName: 'BackupLatency', Value: elapsedMs, Unit: 'Milliseconds' },
        { MetricName: 'SymbolsProcessed', Value: symbolCount, Unit: 'Count' }
    ]
}));
```

### 3.2 백업 실패 알림

```javascript
// SNS 알림 추가
if (dynamoFail > 0) {
    await sns.send(new PublishCommand({
        TopicArn: process.env.ALERT_TOPIC_ARN,
        Subject: '[ALERT] Candle Backup Failed',
        Message: `${dynamoFail} candles failed to save for ${symbol}`
    }));
}
```

---

## 4. 코드 구조 개선

### 4.1 공통 집계 함수 모듈화

**현재 문제**: 동일한 집계 로직이 3곳에 중복
- `trades-backup-handler/index.mjs`
- `chart-data-handler/index.mjs`
- `test/web/index.html`

**개선 제안**: Lambda Layer로 공통 모듈 분리

```javascript
// layer/candle-utils/index.mjs
export function aggregateCandles(oneMinCandles, intervalSeconds) {
    // 공통 로직
}

export function isCompletedCandle(startTime, intervalSeconds) {
    // 공통 로직
}

export const TIMEFRAMES = [
    { interval: '1m', seconds: 60 },
    // ...
];
```

---

## 5. 우선순위 정리

| 개선 항목 | 난이도 | 영향도 | 우선순위 |
|----------|--------|--------|----------|
| BatchWrite 활용 | 낮음 | 높음 | ⭐⭐⭐ 1순위 |
| TTL 조정 | 낮음 | 중간 | ⭐⭐⭐ 1순위 |
| Doji 처리 | 중간 | 높음 | ⭐⭐ 2순위 |
| 공통 모듈화 | 중간 | 중간 | ⭐⭐ 2순위 |
| SCAN 사용 | 낮음 | 낮음 | ⭐ 3순위 |
| CloudWatch 메트릭 | 낮음 | 중간 | ⭐ 3순위 |

---

*작성일: 2025-12-15*
