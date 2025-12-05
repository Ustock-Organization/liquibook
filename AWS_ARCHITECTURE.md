# AWS 핫 샤드 마이그레이션 아키텍처

핫 샤드 마이그레이션을 지원하는 AWS 기반 매칭 엔진 인프라의 기술 스택과 구현 방안입니다.

## 전체 아키텍처 개요

```
[Client] -> [API Gateway] -> [Order Router] -> [Kafka] -> [Matching Engine Cluster]
                                  |                              |
                                  v                              v
                              [Redis]                    [State Snapshot S3]
                                  |
                                  v
                         [CloudWatch / Step Functions]
```

---

## 1. 클라이언트 진입점 (Ingress Layer)

| 컴포넌트 | AWS 서비스 / 기술 스택 | 역할 |
|---|---|---|
| **WebSocket Gateway** | Amazon API Gateway (WebSocket API) | 클라이언트 영구 연결 관리, 호가/체결 푸시 |
| **REST API** | Amazon API Gateway (HTTP API) 또는 ALB | 주문 제출 REST 엔드포인트 |
| **인증** | Amazon Cognito 또는 자체 JWT | 사용자 인증 및 토큰 검증 |

### 구현 포인트
- API Gateway는 직접 Kafka로 쏘지 못하므로, Lambda 또는 Fargate로 구현된 **Order Router**를 붙입니다.
- WebSocket은 연결 ID를 DynamoDB/Redis에 저장하여 체결 시 푸시 대상을 식별합니다.

---

## 2. 주문 라우터 (Order Router / Traffic Controller)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **라우터 서비스** | Go 또는 Rust on ECS Fargate / EC2 | 종목코드 기반 라우팅 결정, 핫샤드 감지 시 주문 일시정지(Pause) |
| **라우팅 테이블** | Amazon ElastiCache (Redis) | 종목 -> 인스턴스 매핑 정보 저장, 실시간 조회 |
| **주문 큐** | Amazon MSK (Managed Kafka) 또는 Kinesis Data Streams | 종목별 파티셔닝, 주문 버퍼링 |

### 구현 포인트 (Order Router)
```go
// 의사 코드 (Go)
func RouteOrder(order Order) {
    // 1. Redis에서 종목 라우팅 정보 조회
    routeInfo := redis.Get("route:" + order.Symbol)

    // 2. 해당 종목이 마이그레이션 중(Paused)이면 Kafka에만 적재
    if routeInfo.Status == "MIGRATING" {
        kafka.Send("pending-orders", order.Symbol, order) // 파티션 키 = 종목
        return
    }

    // 3. 정상이면 해당 파티션(인스턴스)으로 라우팅
    kafka.Send("orders", order.Symbol, order)
}
```

- **파티션 키**를 종목 코드로 설정하면, 동일 종목 주문은 항상 같은 파티션으로 가서 순서 보장됩니다.
- Redis 라우팅 테이블 구조:
  - `route:SAMSUNG` -> `{ "target_instance": "i-0abc123", "status": "ACTIVE" | "MIGRATING" }`

---

## 3. 매칭 엔진 클러스터 (Matching Engine Layer)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **매칭 엔진** | Liquibook (C++) + 커스텀 래퍼 on EC2 (c6i.xlarge 이상) | 주문 매칭 핵심 로직 |
| **Kafka Consumer** | librdkafka (C++) 또는 Sarama (Go) | Kafka에서 주문 소비 |
| **gRPC/TCP Server** | gRPC (C++) 또는 Boost.Asio | 오케스트레이터(Step Functions)와 통신, 스냅샷 요청/응답 |
| **상태 스냅샷 저장소** | Amazon S3 (대용량) 또는 Redis (저지연) | 오더북 직렬화 데이터 저장 |

### Liquibook 추가 구현 필요 사항
1. **Kafka Consumer Thread**: Kafka에서 주문을 읽어 `OrderBook::add()` 호출.
2. **gRPC Server**:
   - `SnapshotOrderBook(symbol)`: 해당 종목 오더북 직렬화 후 반환.
   - `RestoreOrderBook(symbol, data)`: 직렬화 데이터로 오더북 복원.
   - `RemoveOrderBook(symbol)`: 해당 종목 오더북 메모리 해제.
3. **메트릭 리포터**: 종목별 TPS, CPU 사용률을 CloudWatch Agent 또는 Prometheus로 전송.

---

## 4. 마이그레이션 오케스트레이터 (Orchestrator)

| 컴포넌트 | AWS 서비스 / 기술 스택 | 역할 |
|---|---|---|
| **상태 머신** | AWS Step Functions | 마이그레이션 전체 플로우 제어 |
| **부하 감지** | Amazon CloudWatch Alarms | CPU > 85% 시 Step Functions 트리거 |
| **인스턴스 제어** | AWS Lambda + EC2 API / ASG | 새 인스턴스 프로비저닝, AMI 시작 |

### Step Functions 상태 머신 플로우
```
1. DetectHotSymbol     -> 가장 부하가 높은 종목 식별
2. ProvisionNewInstance -> Warm Pool에서 EC2 시작
3. PauseRouting        -> Redis 라우팅 status = MIGRATING
4. WaitForDrain        -> 기존 인스턴스 주문 처리 완료 대기
5. TransferSnapshot    -> gRPC로 스냅샷 요청 -> S3 -> 신규 인스턴스 복원
6. SwitchRouting       -> Redis 라우팅 target = 신규 인스턴스
7. ReplayPendingOrders -> pending-orders 토픽 재전송
8. Cleanup             -> 기존 인스턴스에서 오더북 제거
```

---

## 5. 체결 결과 및 시장 데이터 게시 (Egress Layer)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **체결 이벤트 발행** | Kafka (MSK) 또는 Kinesis | 체결 발생 시 `fills` 토픽으로 발행 |
| **시장 데이터 처리** | Flink on Kinesis Data Analytics 또는 Lambda Consumer | `fills`, `depth` 토픽 소비 후 가공 |
| **클라이언트 푸시** | API Gateway Management API (WebSocket) | 연결된 클라이언트에 JSON 푸시 |
| **호가 캐싱** | ElastiCache (Redis) | 최신 호가창 저장, 클라이언트 폴링 대응 |

---

## 6. Warm Pool 전략 (비용 최적화)

새 인스턴스 프로비저닝 시간을 줄이기 위해 **EC2 Auto Scaling Warm Pool**을 사용합니다.

- **Warm Pool**: 미리 부팅된(또는 최대 절전모드) EC2 인스턴스를 풀에 대기시킵니다.
- **마이그레이션 시**: Cold Start(수 분) 대신 Warm Start(수 초)로 인스턴스 확보.
- **비용**: Running 상태가 아닌 Stopped 상태로 두면 EBS 비용만 발생.

---

## 요약 기술 스택 테이블

| 레이어 | 주요 기술 |
|---|---|
| 클라이언트 진입 | API Gateway (HTTP/WebSocket), Cognito |
| 라우팅 | Go/Rust on Fargate, ElastiCache Redis |
| 메시지 큐 | Amazon MSK (Kafka) |
| 매칭 엔진 | Liquibook C++ + gRPC + librdkafka on EC2 |
| 오케스트레이션 | Step Functions, Lambda, CloudWatch Alarms |
| 스냅샷 저장 | S3 (또는 Redis for low latency) |
| 시장 데이터 | Kinesis/Kafka, Lambda, API Gateway Push |
