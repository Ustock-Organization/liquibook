# Supernoba 캐시 키(Key) 레퍼런스

## 1. 마켓 데이터 (C++ 엔진 생성)
*   **`depth:{symbol}`** (String)
    *   **설명**: 호가창 스냅샷 (매수/매도 리스트 + 시퀀스). 초기 로딩 및 종목 자동 발견용.
    *   **생성**: Engine
    *   **소비**: Streamer, Symbol Manager
*   **`ticker:{symbol}`** (String)
    *   **설명**: 24시간 티커 (OHLCV + 변동률). 상단 티커 바 표시용.
    *   **생성**: Engine
    *   **소비**: Streamer
*   **`trades:{symbol}`** (List)
    *   **설명**: 최근 체결 내역 버퍼 (최대 100,000개).
    *   **생성**: Engine
    *   **소비**: *(현재 미사용, 향후 스트리머 조회용)*
*   **`ohlc:{symbol}`** (String)
    *   **설명**: 현재 진행 중인 1분 캔들의 부분 데이터.
    *   **생성**: Engine
    *   **소비**: Engine (내부 상태용)
*   **`prev:{symbol}`** (String)
    *   **설명**: 전일 종가 데이터. 24시간 변동률 계산 기준.
    *   **생성**: Engine
    *   **소비**: Engine
*   **`candle:1m:{symbol}`** (Hash)
    *   **설명**: 실시간 캔들 상태 (`o`,`h`,`l`,`c`,`v`,`t`,`t_epoch`). 실시간 봉 업데이트용.
    *   **생성**: Engine
    *   **소비**: Engine, Streamer

## 2. 스트리밍 및 세션 관리
*   **`conn:{connId}:main`** (String)
    *   **설명**: 해당 유저가 보고 있는 '메인 종목' ID.
    *   **생성**: Subscribe Lambda
    *   **소비**: Streamer
*   **`ws:{connId}`** (String)
    *   **설명**: 연결 활성 상태 플래그.
    *   **생성**: Connect Lambda
    *   **소비**: Streamer
*   **`symbol:{symbol}:subscribers`** (Set)
    *   **설명**: 해당 종목 전체 구독자 (Main + Sub).
    *   **생성**: Subscribe Lambda
    *   **소비**: Streamer
*   **`symbol:{symbol}:main`** (Set)
    *   **설명**: 메인 시청자 목록 (호가 + 캔들 수신).
    *   **생성**: Subscribe Lambda
    *   **소비**: Streamer
*   **`symbol:{symbol}:sub`** (Set)
    *   **설명**: 서브 시청자 목록 (티커만 수신).
    *   **생성**: Subscribe Lambda
    *   **소비**: Streamer
*   **`realtime:connections`** (Set)
    *   **설명**: 로그인된(인증된) 세션 목록. 100ms 폴링 대상.
    *   **생성**: Login Lambda
    *   **소비**: Streamer

## 3. 시스템 관리
*   **`subscribed:symbols`** (Set)
    *   **설명**: 활성 구독 종목 목록 (구독자가 1명이라도 있는 종목).
    *   **생성**: Subscribe Lambda
    *   **소비**: Streamer
*   **`active:symbols`** (Set)
    *   **설명**: 공개 종목 목록 (구동 중인 종목).
    *   **생성**: Admin / Auto-Discovery
    *   **소비**: Frontend, Symbol Manager
