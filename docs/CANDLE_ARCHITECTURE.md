# 캔들 데이터 아키텍처

캔들(OHLCV) 데이터의 생성, 집계, 저장, 조회 전체 흐름을 설명합니다.

---

## 전체 흐름

```mermaid
sequenceDiagram
    participant Trade as 체결
    participant Engine as C++ Engine
    participant Valkey as Valkey (Redis)
    participant Streamer as Streamer
    participant WS as WebSocket
    participant Lambda as Backup Lambda
    participant DDB as DynamoDB
    participant Chart as Chart API

    Trade->>Engine: 체결 발생
    Engine->>Valkey: Lua Script (1분봉 업데이트)
    Valkey-->>Streamer: 100ms 폴링
    Streamer->>WS: candle 이벤트 브로드캐스트
    
    Note over Lambda: EventBridge 10분 주기
    Lambda->>Valkey: candle:closed:1m:* 조회
    Lambda->>Lambda: 상위 타임프레임 집계
    Lambda->>DDB: 1m~1w 캔들 저장
    
    Chart->>DDB: 완료된 캔들 조회
    Chart->>Valkey: 활성 캔들 조회
    Chart-->>WS: 병합된 데이터 반환
```

---

## 1. 1분봉 생성 (C++ Engine)

### 파일
- `wrapper/src/redis_client.cpp` → `updateCandle()` 함수

### Lua Script 로직

```lua
-- 키 정의
local key = KEYS[1]        -- candle:1m:SYMBOL (Hash)
local closedKey = KEYS[2]  -- candle:closed:1m:SYMBOL (List)

-- 분 경계 계산
local minute = math.floor(ts / 60) * 60

-- 이전 분과 다르면 봉 마감
if current_t and tonumber(current_t) < minute then
    -- 이전 봉을 closed 리스트에 저장
    redis.call("LPUSH", closedKey, cjson.encode(oldCandle))
    redis.call("LTRIM", closedKey, 0, 999)  -- 최대 1000개
    
    -- 새 봉 시작
    redis.call("HMSET", key, "o", price, "h", price, "l", price, "c", price, "v", qty, "t", minute)
else
    -- 같은 분: OHLCV 업데이트
    if price > h then HSET("h", price) end
    if price < l then HSET("l", price) end
    HSET("c", price)
    HINCRBY("v", qty)
end

-- TTL 설정
redis.call("EXPIRE", key, 300)        -- 활성: 5분
redis.call("EXPIRE", closedKey, 3600) -- 마감: 1시간
```

### Valkey 데이터 구조

| Key | Type | 내용 | TTL |
|-----|------|------|-----|
| `candle:1m:TEST` | Hash | `{o, h, l, c, v, t}` | 5분 |
| `candle:closed:1m:TEST` | List | 마감 캔들 JSON (max 1000) | 1시간 |

---

## 2. 상위 타임프레임 집계 (Lambda)

### 파일
- `lambda/Supernoba-trades-backup-handler/index.mjs`

### 지원 타임프레임

| Interval | Seconds | 설명 |
|----------|---------|------|
| 1m | 60 | 1분봉 (기본) |
| 3m | 180 | 3분봉 |
| 5m | 300 | 5분봉 |
| 15m | 900 | 15분봉 |
| 30m | 1800 | 30분봉 |
| 1h | 3600 | 1시간봉 |
| 4h | 14400 | 4시간봉 |
| 1d | 86400 | 일봉 |
| 1w | 604800 | 주봉 |

### 집계 알고리즘

```javascript
function aggregateCandles(oneMinCandles, intervalSeconds) {
    const grouped = new Map();
    
    for (const c of oneMinCandles) {
        // 타임프레임 경계로 정렬
        const alignedTime = Math.floor(c.t / intervalSeconds) * intervalSeconds;
        
        if (!grouped.has(alignedTime)) {
            grouped.set(alignedTime, {
                t: alignedTime,
                o: c.o,  // 첫 캔들의 시가
                h: c.h, l: c.l, c: c.c, v: c.v
            });
        } else {
            const existing = grouped.get(alignedTime);
            existing.h = Math.max(existing.h, c.h);  // 최고가
            existing.l = Math.min(existing.l, c.l);  // 최저가
            existing.c = c.c;                         // 마지막 종가
            existing.v += c.v;                        // 거래량 합계
        }
    }
    return Array.from(grouped.values());
}
```

### DynamoDB 스키마

| PK | SK | 필드 |
|----|-----|------|
| `CANDLE#TEST#1m` | 1702450000 | time, open, high, low, close, volume |
| `CANDLE#TEST#5m` | 1702450200 | time, open, high, low, close, volume |
| `CANDLE#TEST#1h` | 1702450800 | time, open, high, low, close, volume |

---

## 3. 데이터 조회 (Chart API)

### 파일
- `lambda/Supernoba-chart-data-handler/index.mjs`

### 조회 흐름

```
1. getCompletedCandles(symbol, interval)
   → DynamoDB: pk = CANDLE#SYMBOL#INTERVAL
   
2. computeActiveCandle(symbol, intervalSeconds)
   → Valkey: candle:closed:1m:SYMBOL + candle:1m:SYMBOL
   → 현재 기간 1분봉들을 선택 타임프레임으로 집계
   
3. 병합 및 반환
   → [...completed, { ...active, active: true }]
```

### API 사용법

```
GET /chart?symbol=TEST&interval=5m&limit=100

Response:
{
  "symbol": "TEST",
  "interval": "5m",
  "data": [
    { "time": 1702450200, "open": 150, "high": 155, "low": 148, "close": 152, "volume": 1000 },
    { "time": 1702450500, "open": 152, "high": 158, "low": 150, "close": 156, "volume": 1200, "active": true }
  ]
}
```

---

## 4. 실시간 스트리밍 (Streamer)

### 파일
- `streamer/node/index.mjs`

### 이벤트 타입

| Event | 설명 | Payload |
|-------|------|---------|
| `candle` | 현재 캔들 업데이트 | `{e:"candle", tf:"1m", s:"TEST", o, h, l, c, v, t}` |
| `candle_close` | 캔들 마감 | `{e:"candle_close", tf:"1m", s:"TEST", ...}` |

### 폴링 주기

| 사용자 타입 | 주기 | 소스 |
|------------|------|------|
| 로그인 (realtime) | 100ms | Valkey 직접 조회 |
| 익명 (anonymous) | 500ms | 캐시 사용 |

---

## 5. 클라이언트 집계

### 파일
- `test/web/index.html`

### 실시간 집계 로직

```javascript
// 1분봉 버퍼
let oneMinCandleBuffer = [];  // 최대 120개 (2시간)

// 타임프레임별 집계
function aggregateToTimeframe(oneMinCandles, intervalSeconds) {
    const grouped = new Map();
    for (const c of oneMinCandles) {
        const alignedTime = Math.floor(c.time / intervalSeconds) * intervalSeconds;
        // ... 서버와 동일한 집계 로직
    }
    return Array.from(grouped.values());
}

// TradingView 업데이트
candleSeries.update(aggregatedCandle);
```

---

## 데이터 일관성 보장

### Hot/Cold 데이터 병합

```
시간축: ────────────────────────────────────────────→
        │← DynamoDB (Cold) →│← Valkey (Hot) →│← Active →│
        │  09:00 ~ 09:50    │  09:50 ~ 10:02 │  10:03   │
        │  백업 완료         │  마감 버퍼      │  진행 중  │
```

### 중복 방지
- `time` 필드로 dedupe
- 같은 timestamp는 최신 데이터로 덮어쓰기

---

*최종 업데이트: 2025-12-15*
