# 데이터 시나리오 보고서

캔들 데이터 아키텍처 검증을 위한 상세 시나리오 분석

---

## 개요

```
C++ Engine → Valkey (Lua) → Streamer (50ms) → WebSocket → 클라이언트
                ↓
           candle:closed:* → Lambda (10분) → S3 + DynamoDB
```

---

## 시나리오 1: 실시간 캔들 업데이트

### 흐름
```
10:00:05 체결 발생 (TEST, price=150, qty=10)
→ C++ Engine: Valkey Lua Script 호출
→ Valkey: candle:1m:TEST 갱신 {o:150, h:150, l:150, c:150, v:10, t:1702450000}
→ Streamer: 50ms 폴링으로 감지
→ WebSocket: { e:"candle", tf:"1m", s:"TEST", o:150, h:150, ... }
→ 클라이언트: 차트 마지막 봉 업데이트
```

### 지연시간
| 단계 | 시간 |
|------|------|
| 체결 → Valkey | ~1ms |
| Valkey → Streamer 감지 | 0~50ms |
| Streamer → 클라이언트 | ~50ms |
| **총** | **~100ms** |

---

## 시나리오 2: 분 마감 (10:01:00)

### 흐름
```
10:01:02 새 체결 발생 (timestamp = 10:01)
→ Lua Script: timestamp / 60 계산 → 새 분(10:01) 감지
→ 이전 봉(10:00) → candle:closed:1m:TEST 에 LPUSH
→ candle:1m:TEST 삭제 후 새 봉으로 초기화
→ Streamer: lpop으로 closed 캔들 감지
→ WebSocket: { e:"candle_close", tf:"1m", s:"TEST", ... }
→ 클라이언트: 이전 봉 고정, 새 봉 시작
```

### 포인트
- **마감 트리거**: 체결 시 Lua Script가 자동 판단
- **거래 없는 분**: Streamer에서 시간 기반 Doji 생성 필요

---

## 시나리오 3: 과거 차트 데이터 요청

### 요청
```
GET /chart?symbol=TEST&interval=1m&limit=60  (최근 1시간)
```

### 처리
```
chart-data-handler Lambda 호출
→ 1. getHotCandles(): Valkey candle:closed:1m:TEST (최근 10분)
→ 2. getColdCandles(): DynamoDB CANDLE#TEST#1m (과거)
→ 3. getActiveCandle(): Valkey candle:1m:TEST (현재 진행)
→ 4. mergeCandles(): 중복 제거, 시간순 정렬
→ 반환: 60개 1분봉
```

### 데이터 소스
| 시간 범위 | 소스 |
|----------|------|
| 현재 진행 중 | Valkey `candle:1m:TEST` |
| 최근 10분 (백업 전) | Valkey `candle:closed:1m:TEST` |
| 10분 이전 | DynamoDB |

---

## 시나리오 4: 백업 갭 처리

### 문제
09:55 백업 완료 → 10:03 사용자가 차트 요청
= 09:55~10:03 데이터는 S3/DynamoDB에 없음

### 해결
```
chart-data-handler:
1. DynamoDB 조회 → 09:55 이전 데이터
2. Valkey candle:closed:1m:TEST → 09:55~10:02 마감 봉
3. Valkey candle:1m:TEST → 10:03 진행 중 봉
4. 병합 → 완전한 차트 데이터
```

### 보장
- **Hot 데이터 TTL**: 1시간 (충분한 버퍼)
- **중복 방지**: time 필드로 dedupe

---

## 시나리오 5: 상위 타임프레임 요청

### 요청
```
GET /chart?symbol=TEST&interval=5m&limit=12  (최근 1시간)
```

### 처리
```
1. 1분봉 60개 조회 (12 * 5 = 60)
2. aggregateCandles(candles, 5):
   - 5개씩 그룹핑
   - Open: 첫 번째 봉
   - High: 최고가
   - Low: 최저가
   - Close: 마지막 봉
   - Volume: 합계
3. 12개 5분봉 반환
```

---

## 시나리오 6: 익명 vs 실시간 사용자

### 50ms 폴링 (실시간 사용자)
- 로그인 유저
- depth + candle 동시 푸시
- 봉 마감 즉시 감지

### 500ms 폴링 (익명 사용자)
- 50ms 루프의 캐시 사용
- 지연 허용 (500ms)
- 서버 부하 감소

### 구분 방법
```javascript
// subscribe-handler에서 사용자 타입 저장
await valkey.hset(`ws:${connectionId}`, 'type', isLoggedIn ? 'realtime' : 'anonymous');
```

---

## Lambda 정리

| Lambda | 상태 | 역할 |
|--------|------|------|
| `chart-data-handler` | ✅ 수정됨 | Hot/Cold 하이브리드 조회 |
| `trades-backup-handler` | ✅ 수정됨 | 캔들 + 체결 백업 |
| `candle-aggregator` | ❌ 삭제 가능 | Valkey Lua로 대체 |
| 기타 | 유지 | 변경 없음 |

---

## 테스트 체크리스트

- [ ] C++ Engine Lua Script 테스트
- [ ] Streamer 50ms 폴링 테스트
- [ ] 봉 마감 CLOSE 이벤트 테스트
- [ ] chart-data-handler Hot/Cold 병합 테스트
- [ ] trades-backup-handler 캔들 백업 테스트
- [ ] 백업 갭 시나리오 테스트

---

*최종 업데이트: 2025-12-13*
