# AWS 콘솔 Lambda 배포 가이드

## 사전 준비

### Step 1: DynamoDB 테이블 생성

1. AWS 콘솔 → **DynamoDB** → **테이블 생성**

#### candle_history (신규)
| 항목 | 값 |
|------|---|
| 테이블 이름 | `candle_history` |
| 파티션 키 | `pk` (문자열) |
| 정렬 키 | `sk` (숫자) |
| 테이블 클래스 | 표준 |
| 용량 모드 | 온디맨드 |

2. **테이블 생성** 클릭

---

## Lambda 함수 설정

### Step 2: chart-data-handler 업데이트

1. AWS 콘솔 → **Lambda** → `chart-data-handler` 선택

#### 2-1. 코드 업데이트
- **코드** 탭 → 기존 코드 삭제
- `lambda/AWSchart-data-handler/index.mjs` 내용 붙여넣기
- **Deploy** 클릭

#### 2-2. 환경 변수
**구성** → **환경 변수** → **편집**

| 키 | 값 |
|---|---|
| `VALKEY_HOST` | `supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com` |
| `VALKEY_PORT` | `6379` |
| `DYNAMODB_TABLE` | `candle_history` |
| `AWS_REGION` | `ap-northeast-2` |

#### 2-3. 일반 구성
**구성** → **일반 구성** → **편집**

| 항목 | 값 |
|------|---|
| 메모리 | 256 MB |
| 제한 시간 | 10초 |

#### 2-4. VPC (필수!)
**구성** → **VPC** → **편집**

| 항목 | 값 |
|------|---|
| VPC | ElastiCache와 동일한 VPC |
| 서브넷 | 프라이빗 서브넷 선택 |
| 보안 그룹 | Valkey 접근 허용 (6379) |

---

### Step 3: trades-backup-handler 업데이트

1. AWS 콘솔 → **Lambda** → `trades-backup-handler` 선택

#### 3-1. 코드 업데이트
- `lambda/AWStrades-backup-handler/index.mjs` 내용 붙여넣기
- **Deploy** 클릭

#### 3-2. 환경 변수
| 키 | 값 |
|---|---|
| `VALKEY_HOST` | `supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com` |
| `VALKEY_PORT` | `6379` |
| `S3_BUCKET` | `supernoba-market-data` |
| `DYNAMODB_CANDLE_TABLE` | `candle_history` |
| `DYNAMODB_TRADE_TABLE` | `trade_history` |
| `AWS_REGION` | `ap-northeast-2` |

#### 3-3. 일반 구성
| 항목 | 값 |
|------|---|
| 메모리 | 512 MB |
| 제한 시간 | 60초 |

#### 3-4. IAM 권한 확인
**구성** → **권한** → 역할 이름 클릭

필요한 권한:
- `s3:PutObject` (supernoba-market-data)
- `dynamodb:PutItem` (candle_history, trade_history)

---

### Step 4: EventBridge 트리거 확인

1. AWS 콘솔 → **EventBridge** → **규칙**

#### trades-backup-10min 규칙
| 항목 | 값 |
|------|---|
| 이름 | `trades-backup-10min` |
| 스케줄 | `rate(10 minutes)` |
| 대상 | `trades-backup-handler` |

없으면 생성:
1. **규칙 생성** 클릭
2. 이름: `trades-backup-10min`
3. 규칙 유형: **일정**
4. 일정 패턴: `rate(10 minutes)`
5. 대상: Lambda `trades-backup-handler`

---

### Step 5: symbol-manager 생성 (신규)

1. AWS 콘솔 → **Lambda** → **함수 생성**

#### 5-1. 기본 설정
| 항목 | 값 |
|------|---|
| 함수 이름 | `symbol-manager` |
| 런타임 | Node.js 20.x |
| 아키텍처 | x86_64 |

2. **함수 생성** 클릭

#### 5-2. 코드 업로드
- `lambda/AWSsymbol-manager/index.mjs` 내용 붙여넣기
- **Deploy** 클릭

#### 5-3. 환경 변수
| 키 | 값 |
|---|---|
| `VALKEY_HOST` | `supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com` |
| `VALKEY_PORT` | `6379` |
| `ADMIN_API_KEY` | (보안 키 설정) |

#### 5-4. VPC 설정
ElastiCache와 동일하게 설정

---

### Step 6: API Gateway 라우트 추가

1. AWS 콘솔 → **API Gateway** → HTTP API 선택

#### symbol-manager 라우트
| 메서드 | 경로 | 통합 |
|--------|------|------|
| GET | `/symbols` | symbol-manager |
| GET | `/symbols/{symbol}` | symbol-manager |
| POST | `/symbols` | symbol-manager |
| DELETE | `/symbols/{symbol}` | symbol-manager |

---

## 확인 체크리스트

- [ ] DynamoDB `candle_history` 생성됨
- [ ] `chart-data-handler` 코드 배포됨
- [ ] `chart-data-handler` 환경변수 설정됨
- [ ] `chart-data-handler` VPC 연결됨
- [ ] `trades-backup-handler` 코드 배포됨
- [ ] `trades-backup-handler` 환경변수 설정됨
- [ ] EventBridge 10분 규칙 활성화됨
- [ ] `symbol-manager` 생성됨
- [ ] API Gateway 라우트 추가됨

---

## 테스트

```bash
# chart-data-handler 테스트
curl "https://YOUR_API.execute-api.ap-northeast-2.amazonaws.com/chart?symbol=TEST&interval=1m&limit=10"

# symbol-manager 테스트
curl "https://YOUR_API.execute-api.ap-northeast-2.amazonaws.com/symbols"
```
