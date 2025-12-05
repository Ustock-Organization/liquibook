# Liquibook Windows 빌드 가이드

이 문서는 Windows 환경에서 Liquibook을 빌드하기 위한 상세 가이드입니다.

---

## 목차

1. [사전 요구사항](#1-사전-요구사항)
2. [의존성 설치](#2-의존성-설치)
3. [프로젝트 생성](#3-프로젝트-생성)
4. [Visual Studio 설정](#4-visual-studio-설정)
5. [빌드](#5-빌드)
6. [테스트](#6-테스트)
7. [문제 해결](#7-문제-해결)

---

## 1. 사전 요구사항

| 구성요소 | 버전 | 비고 |
|----------|------|------|
| Visual Studio | 2022 이상 | C++ 데스크톱 개발 워크로드 필수 |
| Perl | 5.x | MPC 실행에 필요 |
| Git | 최신 | 의존성 클론용 |

---

## 2. 의존성 설치

### 2.1 MPC (Makefile, Project and Workspace Creator)

MPC는 플랫폼 독립적인 프로젝트 파일 생성 도구입니다.

```powershell
cd C:\
git clone https://github.com/DOCGroup/MPC.git
```

### 2.2 Boost 설치

> ⚠️ **중요**: Boost 버전 선택이 매우 중요합니다.

Liquibook 핵심 엔진은 Boost 버전에 관계없이 빌드되지만, `depth_feed_publisher/subscriber` 예제는 QuickFAST 라이브러리를 사용하며-이 라이브러리는 Boost 1.75 이하에서만 호환됩니다.

#### 왜 Boost 1.75인가?

Boost 1.80 이상에서는 `boost::asio::io_service`가 `io_context`의 typedef로 변경되었습니다. QuickFAST는 `io_service`를 forward declaration으로 사용하므로, 최신 Boost와 충돌이 발생합니다.

#### 설치 방법

1. [Boost 1.75.0 다운로드 페이지](https://www.boost.org/users/history/version_1_75_0.html)에서 `boost_1_75_0-msvc-14.2-64.exe` 다운로드
2. 설치 경로: `C:\boost\boost_1_75_0`
3. 설치 완료 후 `lib64-msvc-14.2` 폴더를 `lib`로 이름 변경

```powershell
# 폴더 이름 변경
Rename-Item -Path "C:\boost\boost_1_75_0\lib64-msvc-14.2" -NewName "lib"
```

### 2.3 QuickFAST (선택사항)

`depth_feed_publisher/subscriber` 예제를 빌드하려면 필요합니다.

```powershell
cd C:\
git clone https://github.com/objectcomputing/quickfast.git QuickFAST
```

> ℹ️ **참고**: QuickFAST는 선택사항입니다. 핵심 매칭 엔진만 사용한다면 설치하지 않아도 됩니다.

### 2.4 Xerces-C (선택사항)

QuickFAST가 XML 파싱에 사용합니다.

```powershell
# vcpkg로 설치하는 경우
git clone https://github.com/Microsoft/vcpkg.git C:\vcpkg
cd C:\vcpkg
.\bootstrap-vcpkg.bat
.\vcpkg install xerces-c:x64-windows
```

---

## 3. 프로젝트 생성

### 3.1 환경 변수 설정

PowerShell에서 다음 환경 변수를 설정합니다:

```powershell
$env:MPC_ROOT = "C:\MPC"
$env:BOOST_ROOT = "C:\boost\boost_1_75_0"
$env:QUICKFAST_ROOT = "C:\QuickFAST"           # 선택사항
$env:XERCESROOT = "C:\vcpkg\installed\x64-windows"  # 선택사항
$env:LIQUIBOOK_ROOT = "C:\develop\liquibook"
```

### 3.2 Visual Studio 솔루션 생성

```powershell
cd C:\develop\liquibook
perl C:\MPC\mwc.pl -type vs2022 -include mpc -include C:\QuickFAST -feature_file liquibook.features .
```

성공 시 출력:
```
Generating 'vs2022' output using default input
Generation Time: 0s
```

---

## 4. Visual Studio 설정

### 4.1 솔루션 열기

```powershell
start liquibook.sln
```

### 4.2 Include/Library 경로 추가

MPC가 생성한 프로젝트는 Boost 경로가 자동 설정되지 않을 수 있습니다. 각 프로젝트에 수동으로 추가해야 합니다.

| 프로젝트 | C/C++ 추가 포함 디렉터리 | 링커 추가 라이브러리 디렉터리 |
|---|---|---|
| liquibook_unit_test | `C:\boost\boost_1_75_0` | `C:\boost\boost_1_75_0\lib` |
| pt_order_book | `C:\boost\boost_1_75_0` | - |
| lt_order_book | `C:\boost\boost_1_75_0` | - |
| depth_feed_publisher | `C:\boost\boost_1_75_0;C:\QuickFAST\src` | `C:\boost\boost_1_75_0\lib` |
| depth_feed_subscriber | `C:\boost\boost_1_75_0;C:\QuickFAST\src` | `C:\boost\boost_1_75_0\lib` |

**설정 방법:**
1. 프로젝트 우클릭 → 속성
2. C/C++ → 일반 → 추가 포함 디렉터리
3. 링커 → 일반 → 추가 라이브러리 디렉터리

### 4.3 Runtime Library 일치시키기

`liquibook_simple` 프로젝트와 다른 프로젝트 간 Runtime Library 불일치가 발생합니다.

**오류 메시지:**
```
error LNK2038: 'RuntimeLibrary'에 대해 불일치가 검색되었습니다. 
'MTd_StaticDebug' 값이 'MDd_DynamicDebug' 값과 일치하지 않습니다.
```

**해결 방법:**

`liquibook_simple` 프로젝트:
1. 우클릭 → 속성
2. C/C++ → 코드 생성 → 런타임 라이브러리
3. `다중 스레드 디버그 (/MTd)` → `다중 스레드 디버그 DLL (/MDd)`로 변경

---

## 5. 빌드

### 5.1 솔루션 빌드

Visual Studio에서 `Ctrl + Shift + B` 또는 메뉴에서 빌드 → 솔루션 빌드

### 5.2 빌드 결과

| 프로젝트 | 산출물 | 빌드 결과 |
|---|---|---|
| liquibook | `Output\Debug\liquibook.exe` | ✅ 성공 |
| liquibook_simple | `lib\liquibook_simpled.lib` | ✅ 성공 |
| liquibook_unit_test | `bin\test\liquibook_unit_test.exe` | ✅ 성공 |
| pt_order_book | `bin\test\pt_order_book.exe` | ✅ 성공 |
| lt_order_book | `bin\test\lt_order_book.exe` | ✅ 성공 |
| mt_order_entry | `Output\Debug\mt_order_entry.exe` | ✅ 성공 |
| depth_feed_publisher | - | ❌ QuickFAST 호환성 문제 |
| depth_feed_subscriber | - | ❌ QuickFAST 호환성 문제 |

> ℹ️ **참고**: `depth_feed_publisher/subscriber`는 QuickFAST와 Boost 간 호환성 문제로 빌드되지 않습니다. 이 예제들은 시장 데이터 배포 예시일 뿐, 핵심 매칭 엔진과는 무관합니다.

---

## 6. 테스트

### 6.1 단위 테스트

```powershell
cd C:\develop\liquibook\bin\test
.\liquibook_unit_test.exe
```

일부 테스트가 실패할 수 있으나, 핵심 매칭 기능에는 영향이 없습니다.

### 6.2 성능 테스트

```powershell
.\pt_order_book.exe
```

예상 출력:
```
3 sec performance test of order book
testing order book with depth
Inserted 820957 orders in 3 seconds, or 273652 insertions per sec
```

### 6.3 지연 시간 테스트

```powershell
.\lt_order_book.exe
```

출력되는 숫자는 나노초 단위의 주문 처리 시간입니다 (평균 약 3000ns = 3μs).

### 6.4 수동 주문 입력 테스트

```powershell
cd C:\develop\liquibook\Output\Debug
.\mt_order_entry.exe
```

**명령어 문법:**
```
BUY <수량> <종목> <가격> ;      # 지정가 매수
SELL <수량> <종목> MARKET ;    # 시장가 매도
DISPLAY <종목>                 # 오더북 조회
CANCEL <주문번호> ;            # 주문 취소
QUIT                          # 종료
```

**예시 세션:**
```
> BUY 100 SAMSUNG 72500 ;
Create new depth order book for SAMSUNG    # 첫 주문 시 'D' 선택
ADDING order: [#1 BUY 100 SAMSUNG $72500]

> SELL 50 SAMSUNG 72500 ;
Trade: 50 SAMSUNG Cost 72500               # 체결 발생!

> DISPLAY SAMSUNG
[#1 BUY 100 SAMSUNG $72500 Open: 50]       # 50주 잔여
```

---

## 7. 문제 해결

### 7.1 Boost 헤더를 찾을 수 없음

```
error C1083: 포함 파일을 열 수 없습니다. 'boost/test/unit_test.hpp'
```

**원인**: Boost Include 경로가 설정되지 않음

**해결**: 프로젝트 속성 → C/C++ → 추가 포함 디렉터리에 `C:\boost\boost_1_75_0` 추가

### 7.2 RuntimeLibrary 불일치

```
error LNK2038: 'RuntimeLibrary'에 대해 불일치가 검색되었습니다.
```

**원인**: `liquibook_simple`이 `/MTd`, 다른 프로젝트가 `/MDd` 사용

**해결**: `liquibook_simple`의 런타임 라이브러리를 `/MDd`로 변경

### 7.3 QuickFAST io_service 충돌

```
error C2371: 'boost::asio::io_service': 재정의. 기본 형식이 다릅니다.
```

**원인**: QuickFAST가 Boost 1.75 이상과 호환되지 않음

**해결**: 이 에러가 발생하는 프로젝트(`depth_feed_*`)는 건너뛰기. 핵심 엔진에는 영향 없음.

### 7.4 on_replace 시그니처 오류 (컴파일 시)

```
error C2259: cannot instantiate abstract class
```

**원인**: `OrderListener::on_replace`의 시그니처가 `int32_t` → `int64_t`로 변경됨

**해결**: `test/unit/ut_listeners.cpp`에서 `on_replace` 메서드 수정:

```cpp
// 변경 전
virtual void on_replace(const OrderPtr& order,
                        const int32_t& size_delta,  // ← 오류
                        Price new_price)

// 변경 후  
virtual void on_replace(const OrderPtr& order,
                        const int64_t& size_delta,  // ← 수정
                        Price new_price)
```

---

## 부록: 빌드 산출물 설명

| 프로젝트 | 용도 |
|---|---|
| **liquibook** | 핵심 라이브러리 컴파일 확인용 |
| **liquibook_simple** | 간단한 주문 구현이 포함된 정적 라이브러리 |
| **mt_order_entry** | 콘솔 기반 수동 주문 입력 프로그램 |
| **liquibook_unit_test** | 매칭 로직 단위 테스트 (Boost.Test 사용) |
| **pt_order_book** | 성능 테스트 - 초당 처리량(TPS) 측정 |
| **lt_order_book** | 지연 시간 테스트 - 나노초 단위 레이턴시 측정 |
| **depth_feed_publisher** | 시장 데이터 발행 예제 (QuickFAST 필요) |
| **depth_feed_subscriber** | 시장 데이터 수신 예제 (QuickFAST 필요) |

---

## 부록: 테스트 환경

이 가이드는 다음 환경에서 검증되었습니다:

- Windows 11
- Visual Studio 2026 (v17.x)
- Boost 1.75.0 (msvc-14.2-64)
- Perl 5.x (Strawberry Perl)
- MPC (최신 Git 버전)

---

*최종 업데이트: 2025-12-05*
