# 프론트엔드 실시간 데이터 연동 가이드

## 1. WebSocket 연결

### 연결 URL

```
wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/prod
```

### 연결 옵션 (인증 시)

```javascript
const ws = new WebSocket(url);
ws.onopen = () => {
  // 인증 (선택)
  ws.send(JSON.stringify({
    action: 'auth',
    token: 'JWT_TOKEN'
  }));
};
```

---

## 2. 구독 요청

### Main 구독 (호가창용, 1개만)

```javascript
ws.send(JSON.stringify({
  action: 'subscribe',
  main: 'AAPL'
}));
```

### Sub 구독 (전광판/즐겨찾기용, 복수)

```javascript
ws.send(JSON.stringify({
  action: 'subscribe',
  sub: ['MSFT', 'GOOG', 'AMZN']
}));
```

### 구독 해제

```javascript
ws.send(JSON.stringify({
  action: 'unsubscribe',
  sub: ['MSFT']
}));
```

---

## 3. 수신 메시지 형식

### Main (depth)

```json
{
  "e": "d",
  "s": "AAPL",
  "n": "Apple Inc.",
  "p": 150,
  "pc": 148,
  "o": 149,
  "h": 152,
  "l": 147,
  "v": 10000,
  "b": [[150,100], [149,200], ...],
  "a": [[151,100], [152,200], ...],
  "t": 1702400000
}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("d" = depth) |
| `s` | 종목 티커 |
| `n` | 종목명 |
| `p` | 현재가 |
| `pc` | 전일 종가 |
| `o` | 당일 시가 |
| `h` | 당일 고가 |
| `l` | 당일 저가 |
| `v` | 거래량 |
| `b` | 매수 호가 [[가격, 잔량], ...] |
| `a` | 매도 호가 [[가격, 잔량], ...] |
| `t` | 타임스탬프 (Unix 초) |

### Sub (ticker)

```json
{
  "e": "t",
  "s": "MSFT",
  "n": "Microsoft Corp.",
  "p": 380,
  "pc": 375,
  "o": 376,
  "t": 1702400000
}
```

### Fill (체결 알림)

> 로그인 사용자에게만 전송됨. 본인 주문 체결 시.

```json
{
  "e": "f",
  "s": "AAPL",
  "oid": "order-001",
  "side": "buy",
  "p": 150,
  "q": 10,
  "filled": 10,
  "remaining": 0,
  "status": "filled",
  "t": 1702400000
}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("f" = fill) |
| `s` | 종목 티커 |
| `oid` | 주문 ID |
| `side` | "buy" 또는 "sell" |
| `p` | 체결 가격 |
| `q` | 체결 수량 |
| `filled` | 총 체결 수량 |
| `remaining` | 미체결 잔량 |
| `status` | "partial" (부분체결) / "filled" (전량체결) |
| `t` | 타임스탬프 |

---

## 4. 변동률 계산 (클라이언트)

```typescript
// 등락률 (%)
const changeRate = ((price - prevClose) / prevClose) * 100;

// 등락폭
const change = price - prevClose;

// 예시
const price = 150;
const prevClose = 148;
const changeRate = ((150 - 148) / 148) * 100;  // 1.35%
const change = 150 - 148;  // +2
```

---

## 5. 차트 데이터 API

### 요청

```
GET /chart?symbol=AAPL&interval=15m&date=20251213
```

| 파라미터 | 설명 |
|----------|------|
| `symbol` | 종목 티커 |
| `interval` | 1m, 3m, 5m, 10m, 15m, 30m, 1h, 3h, 1d, 1w |
| `date` | YYYYMMDD (선택, 기본: 오늘) |

### 응답

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

> lightweight-charts 호환 형식

---

## 6. 데이터 갱신 주기

| 사용자 유형 | Main | Sub |
|-------------|------|-----|
| 로그인 | 50ms | 100ms |
| 비로그인 | 500ms | 500ms |

---

## 7. 에러 처리

```javascript
ws.onclose = (event) => {
  console.log('연결 종료:', event.code);
  // 재연결 로직
};

ws.onerror = (error) => {
  console.error('WebSocket 에러:', error);
};
```

---

## 8. 상태 관리 예시 (React)

```typescript
interface MarketState {
  main: {
    symbol: string | null;
    data: MainData | null;
  };
  sub: Map<string, SubData>;
}

// 변동률은 컴포넌트에서 계산
const changeRate = useMemo(() => {
  if (!main.data) return 0;
  return ((main.data.p - main.data.pc) / main.data.pc) * 100;
}, [main.data?.p, main.data?.pc]);
```
