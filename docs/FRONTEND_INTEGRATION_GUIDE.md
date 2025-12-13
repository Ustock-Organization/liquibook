# 프론트엔드 실시간 데이터 연동 가이드

> 최종 업데이트: 2025-12-13

## 1. WebSocket 연결

### 연결 URL

```
wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production
```

### 연결 예시

```javascript
// userId 전달 (선택) - 로그인 사용자는 세션 ID 전달
const userId = 'user_12345';  // 또는 'anonymous'
const ws = new WebSocket(`${WS_URL}?userId=${userId}`);

ws.onopen = () => {
  console.log('WebSocket connected');
};
```

---

## 2. 구독 요청

### Main + Sub 동시 구독 (권장)

```javascript
ws.send(JSON.stringify({
  action: 'subscribe',
  main: 'AAPL',           // 호가창용 (1개만)
  sub: ['MSFT', 'GOOG']   // 전광판용 (복수)
}));
```

### Main만 변경

```javascript
ws.send(JSON.stringify({
  action: 'subscribe',
  main: 'TSLA'  // 기존 Main 자동 해제, 새 Main 등록
}));
```

### Sub 추가

```javascript
ws.send(JSON.stringify({
  action: 'subscribe',
  sub: ['AMZN', 'META']  // 기존 Sub에 추가됨
}));
```

### 구독 해제

```javascript
ws.send(JSON.stringify({
  action: 'unsubscribe',
  sub: ['MSFT']  // 특정 Sub 해제
}));
```

---

## 3. 수신 메시지 형식

### Main: Depth (호가창)

```json
{
  "e": "d",
  "s": "AAPL",
  "t": 1702400000000,
  "b": [[150,100], [149,200], [148,150]],
  "a": [[151,100], [152,200], [153,150]]
}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("d" = depth) |
| `s` | 종목 심볼 |
| `t` | 타임스탬프 (Unix ms) |
| `b` | Bids `[[가격, 잔량], ...]` (최대 10개, 높은가격→낮은가격) |
| `a` | Asks `[[가격, 잔량], ...]` (최대 10개, 낮은가격→높은가격) |

### Sub: Ticker (전광판)

```json
{
  "e": "t",
  "s": "MSFT",
  "t": 1702400000000,
  "p": 380,
  "c": 2.5,
  "yc": -1.2
}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("t" = ticker) |
| `s` | 종목 심볼 |
| `t` | 타임스탬프 (Unix ms) |
| `p` | 현재가 (마지막 체결가) |
| `c` | 금일 등락률 (%) |
| `yc` | 전일 등락률 (%) |

### Fill (체결 알림)

> 로그인 사용자에게만 전송. 본인 주문 체결 시.

```json
{
  "e": "f",
  "s": "AAPL",
  "oid": "ord_abc123",
  "side": "buy",
  "p": 150,
  "q": 10,
  "filled": 10,
  "remaining": 0,
  "status": "filled",
  "t": 1702400000000
}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("f" = fill) |
| `oid` | 주문 ID |
| `side` | "buy" 또는 "sell" |
| `p` | 체결 가격 |
| `q` | 체결 수량 |
| `filled` | 총 체결 수량 |
| `remaining` | 미체결 잔량 |
| `status` | "partial" / "filled" |

---

## 4. 클라이언트 상태 관리

### TypeScript 인터페이스

```typescript
interface DepthData {
  e: 'd';
  s: string;
  t: number;
  b: [number, number][];  // [price, qty][]
  a: [number, number][];
}

interface TickerData {
  e: 't';
  s: string;
  t: number;
  p: number;      // 현재가
  c: number;      // 금일 등락률 (%)
  yc: number;     // 전일 등락률 (%)
}

interface MarketState {
  main: {
    symbol: string | null;
    depth: DepthData | null;
  };
  sub: Map<string, TickerData>;
}
```

### React 예시

```typescript
const [main, setMain] = useState<{ symbol: string | null; depth: DepthData | null }>({
  symbol: null,
  depth: null,
});
const [sub, setSub] = useState<Map<string, TickerData>>(new Map());

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.e === 'd') {
    setMain({ symbol: data.s, depth: data });
  } else if (data.e === 't') {
    setSub(prev => new Map(prev).set(data.s, data));
  } else if (data.e === 'f') {
    // 체결 알림 처리
    handleFill(data);
  }
};
```

---

## 5. 차트 데이터 API

### 요청

```
GET https://your-api-id.execute-api.ap-northeast-2.amazonaws.com/chart?symbol=AAPL&interval=15m
```

| 파라미터 | 설명 | 기본값 |
|----------|------|--------|
| `symbol` | 종목 심볼 | (필수) |
| `interval` | 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d | 1m |
| `date` | YYYYMMDD | 오늘 |

### 응답 (lightweight-charts 호환)

```json
{
  "symbol": "AAPL",
  "interval": "15m",
  "data": [
    {"time": 1702400000, "open": 150, "high": 155, "low": 148, "close": 152, "volume": 1200},
    {"time": 1702400900, "open": 152, "high": 156, "low": 151, "close": 154, "volume": 800}
  ]
}
```

---

## 6. 데이터 갱신 주기

| 데이터 타입 | 갱신 주기 | 비고 |
|-------------|----------|------|
| Main (depth) | 500ms | Streamer 폴링 주기 |
| Sub (ticker) | 500ms | Streamer 폴링 주기 |
| Fill (체결) | 즉시 | 체결 발생 시 푸시 |

---

## 7. 에러 처리 및 재연결

```javascript
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function connect() {
  const ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    console.log('Connected');
    reconnectAttempts = 0;
    // 구독 재등록
    ws.send(JSON.stringify({ action: 'subscribe', main: 'AAPL', sub: ['MSFT'] }));
  };
  
  ws.onclose = (event) => {
    console.log('Disconnected:', event.code);
    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      setTimeout(connect, 1000 * reconnectAttempts);  // 백오프
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  return ws;
}
```

---

## 8. 주문 API

### 주문 제출

```
POST /orders
Content-Type: application/json

{
  "symbol": "AAPL",
  "side": "buy",
  "price": 150,
  "quantity": 10
}
```

### 주문 취소

```
DELETE /orders/{orderId}
```

---

## 9. Valkey 캐시 키 참조 (디버깅용)

| 키 패턴 | 용도 |
|---------|------|
| `depth:SYMBOL` | 실시간 호가 데이터 |
| `ticker:SYMBOL` | 실시간 시세 데이터 |
| `active:symbols` | 구독 중인 심볼 목록 |
| `symbol:SYMBOL:main` | Main 구독자 connectionId Set |
| `symbol:SYMBOL:sub` | Sub 구독자 connectionId Set |
