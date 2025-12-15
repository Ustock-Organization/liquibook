# 캔들 데이터 테스트 및 검증 가이드

캔들 데이터 파이프라인 전체를 테스트하고 디버깅하는 방법입니다.

---

## 1. 데이터 흐름 테스트

### 1.1 C++ Engine → Valkey (1분봉 생성)

**테스트 방법**: 테스트 주문 제출 후 Valkey 확인

```bash
# EC2에서 Valkey CLI 접속
redis-cli -h supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com

# 현재 1분봉 확인
HGETALL candle:1m:TEST

# 출력 예시
# 1) "o"  2) "150"
# 3) "h"  4) "155"
# 5) "l"  6) "148"
# 7) "c"  8) "152"
# 9) "v"  10) "100"
# 11) "t" 12) "1702450200"

# 마감된 캔들 리스트 확인
LRANGE candle:closed:1m:TEST 0 5

# TTL 확인
TTL candle:1m:TEST
TTL candle:closed:1m:TEST
```

**예상 결과**:
- `candle:1m:TEST` 존재하고 최근 타임스탬프
- TTL: 활성 캔들 300초, 마감 캔들 3600초

---

### 1.2 분 마감 테스트

**테스트 방법**: 분 경계를 넘는 체결 발생시키기

```bash
# 현재 시간 확인 (분 경계 직전에 테스트)
date +%s

# 1분봉 모니터링 (새 터미널)
watch -n 1 "redis-cli -h supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com HGETALL candle:1m:TEST"

# 분 경계 넘어가면 확인
redis-cli LRANGE candle:closed:1m:TEST 0 0
```

**예상 결과**:
- 분 경계 후 `candle:closed:1m:TEST`에 이전 봉 추가됨
- `candle:1m:TEST`의 `t` 값이 새 분으로 변경됨

---

### 1.3 상위 타임프레임 집계 테스트

**테스트 방법**: Lambda 수동 실행

```bash
# AWS CLI로 Lambda 직접 호출
aws lambda invoke \
  --function-name Supernoba-trades-backup-handler \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  response.json

cat response.json
```

**DynamoDB 확인**:
```bash
# AWS CLI로 DynamoDB 조회
aws dynamodb query \
  --table-name candle_history \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk": {"S": "CANDLE#TEST#5m"}}' \
  --scan-index-forward false \
  --limit 5
```

---

### 1.4 Chart API 테스트

**테스트 방법**: HTTP 요청

```bash
# 1분봉 조회
curl "https://YOUR-API-GATEWAY/restV2/chart?symbol=TEST&interval=1m&limit=10"

# 5분봉 조회
curl "https://YOUR-API-GATEWAY/restV2/chart?symbol=TEST&interval=5m&limit=10"

# 1시간봉 조회
curl "https://YOUR-API-GATEWAY/restV2/chart?symbol=TEST&interval=1h&limit=10"
```

**예상 결과**:
```json
{
  "symbol": "TEST",
  "interval": "5m",
  "data": [
    { "time": 1702450200, "open": 150, "high": 155, "low": 148, "close": 152, "volume": 500 },
    { "time": 1702450500, "open": 152, "high": 160, "low": 150, "close": 158, "volume": 600, "active": true }
  ]
}
```

---

## 2. 실시간 스트리밍 테스트

### 2.1 WebSocket 연결 테스트

**테스트 방법**: wscat 또는 테스트 콘솔 사용

```bash
# wscat 설치
npm install -g wscat

# WebSocket 연결
wscat -c "wss://YOUR-WEBSOCKET-API.execute-api.ap-northeast-2.amazonaws.com/prod"

# 연결 후 구독 메시지 전송
{"action": "subscribe", "symbol": "TEST", "type": "main"}
```

**예상 메시지**:
```json
{"e":"candle","tf":"1m","s":"TEST","o":"150","h":"155","l":"148","c":"152","v":"100","t":"1702450200"}
```

### 2.2 봉 마감 이벤트 확인

**예상 메시지**: 분 경계 후
```json
{"e":"candle_close","tf":"1m","s":"TEST","o":"150","h":"155","l":"148","c":"152","v":"100","t":"1702450140"}
```

---

## 3. 통합 테스트 시나리오

### 3.1 테스트 콘솔 활용

1. `test/web/index.html` 열기
2. WebSocket 연결
3. **캔들 테스트 자동화** 섹션에서:
   - 기준가: 150
   - 범위: ±50
   - 주기: 5분
   - 주문 간격: 500ms
4. **시작** 클릭
5. TradingView 차트에서 실시간 캔들 확인

### 3.2 전체 파이프라인 체크리스트

| 단계 | 확인 항목 | 명령어/방법 |
|------|----------|-------------|
| 1 | C++ Engine 실행 중 | `ps aux \| grep liquibook` |
| 2 | Valkey 연결 | `redis-cli ping` |
| 3 | 1분봉 생성 | `HGETALL candle:1m:TEST` |
| 4 | 봉 마감 | `LRANGE candle:closed:1m:TEST 0 0` |
| 5 | Streamer 실행 중 | `ps aux \| grep node` |
| 6 | WebSocket 연결 | 테스트 콘솔 연결 상태 |
| 7 | 캔들 메시지 수신 | 콘솔 로그 확인 |
| 8 | Lambda 백업 | CloudWatch Logs |
| 9 | DynamoDB 저장 | AWS Console 또는 CLI |
| 10 | Chart API 응답 | curl 테스트 |

---

## 4. 디버깅 가이드

### 4.1 캔들이 생성되지 않을 때

**원인 1**: C++ Engine이 Valkey에 연결 안됨
```bash
# Engine 로그 확인
tail -f /path/to/engine.log | grep -i redis
tail -f /path/to/engine.log | grep -i candle
```

**원인 2**: Lua Script 오류
```bash
# Valkey에서 직접 테스트
redis-cli EVAL "return redis.call('HGETALL', KEYS[1])" 1 candle:1m:TEST
```

### 4.2 상위 타임프레임이 없을 때

**원인 1**: Lambda 실행 안됨
```bash
# EventBridge 규칙 확인
aws events list-rules --name-prefix Supernoba

# Lambda 실행 로그
aws logs tail /aws/lambda/Supernoba-trades-backup-handler --since 1h
```

**원인 2**: 완료 조건 미충족
```javascript
// isCompletedCandle 로직 확인
// 현재 시간이 캔들 종료 시간을 지나야 저장됨
```

### 4.3 Chart API가 빈 데이터 반환

**원인 1**: DynamoDB 파티션 키 확인
```bash
aws dynamodb scan \
  --table-name candle_history \
  --filter-expression "begins_with(pk, :prefix)" \
  --expression-attribute-values '{":prefix": {"S": "CANDLE#TEST"}}' \
  --limit 10
```

**원인 2**: Valkey 활성 캔들 없음
```bash
redis-cli HGETALL candle:1m:TEST
# 빈 결과면 체결 발생 필요
```

---

## 5. 성능 모니터링

### 5.1 CloudWatch 대시보드 메트릭

- `AWS/Lambda/Invocations`: Lambda 호출 횟수
- `AWS/Lambda/Duration`: 실행 시간
- `AWS/Lambda/Errors`: 오류 횟수
- `AWS/DynamoDB/ConsumedWriteCapacityUnits`: DynamoDB 쓰기 용량

### 5.2 Valkey 모니터링

```bash
# 메모리 사용량
redis-cli INFO memory

# 키 개수
redis-cli DBSIZE

# 캔들 관련 키 개수
redis-cli KEYS "candle:*" | wc -l
```

---

*작성일: 2025-12-15*
