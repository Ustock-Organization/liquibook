// Candle Aggregator - Main Entry Point
// 실시간 타임프레임 집계 서비스

#include "config.h"
#include "logger.h"
#include "valkey_client.h"
#include "aggregator.h"
#include "dynamodb_client.h"
#include "s3_client.h"

#include <iostream>
#include <thread>
#include <chrono>
#include <csignal>
#include <atomic>
#include <map>

#include <aws/core/Aws.h>

using namespace aggregator;

std::atomic<bool> running{true};

void signal_handler(int signal) {
    Logger::info("Received signal", signal, "- shutting down...");
    running = false;
}

void print_banner() {
    std::cout << "\n";
    std::cout << "╔═══════════════════════════════════════════════════════════╗\n";
    std::cout << "║           Candle Aggregator Service                       ║\n";
    std::cout << "║      Real-time Timeframe Processing                       ║\n";
    std::cout << "╚═══════════════════════════════════════════════════════════╝\n";
    std::cout << "\n";
}

int main(int argc, char* argv[]) {
    print_banner();
    
    // 시그널 핸들러 등록
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);
    
    // 설정 로드
    Config cfg = Config::from_env();
    Logger::set_level(cfg.log_level);

    // 커맨드라인 인자 파싱 (--debug)
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--debug") {
            Logger::set_level("DEBUG");
            Logger::info("Debug mode enabled via command line flag");
        }
    }
    
    Logger::info("=== Configuration ===");
    Logger::info("Valkey Host:", cfg.valkey_host);
    Logger::info("Valkey Port:", cfg.valkey_port);
    Logger::info("DynamoDB Table:", cfg.dynamodb_table);
    Logger::info("S3 Bucket:", cfg.s3_bucket);
    Logger::info("Poll Interval:", cfg.poll_interval_ms, "ms");
    Logger::info("=====================");
    
    // AWS SDK 초기화
    Aws::SDKOptions options;
    Aws::InitAPI(options);
    
    // 클라이언트 초기화
    ValkeyClient valkey(cfg.valkey_host, cfg.valkey_port);
    if (!valkey.connect()) {
        Logger::error("Failed to connect to Valkey");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Valkey");
    
    DynamoDBClient dynamodb(cfg.dynamodb_table, cfg.aws_region);
    if (!dynamodb.connect()) {
        Logger::error("Failed to connect to DynamoDB");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to DynamoDB");
    
    S3Client s3(cfg.s3_bucket, cfg.aws_region);
    if (!s3.connect()) {
        Logger::error("Failed to connect to S3");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to S3");
    
    Aggregator aggregator;
    
    Logger::info("=== Aggregator Running ===");
    Logger::info("Polling for closed candles every", cfg.poll_interval_ms, "ms");
    
    // 마지막으로 처리한 캔들 개수 (중복 로그/처리 방지)
    std::map<std::string, size_t> last_processed_counts;
    
    while (running) {
        try {
            // 1. closed 캔들이 있는 심볼 목록 조회
            auto symbols = valkey.get_closed_symbols();
            
            // 심볼이 발견될 때만 로그
            static size_t last_symbol_count = 0;
            if (!symbols.empty() && symbols.size() != last_symbol_count) {
                Logger::info("Found", symbols.size(), "symbols with closed candles");
                last_symbol_count = symbols.size();
            }

            for (const auto& symbol : symbols) {
                // 2. 마감된 1분봉 가져오기
                auto closed_candles = valkey.get_closed_candles(symbol);
                
                if (closed_candles.empty()) {
                    last_processed_counts[symbol] = 0; // 비어있으면 카운트 리셋
                    continue;
                }
                
                // 변경 사항이 없으면 스킵 (고속 폴링 방지)
                if (last_processed_counts.find(symbol) != last_processed_counts.end() && 
                    last_processed_counts[symbol] == closed_candles.size()) {
                    continue;
                }
                
                // 상태 업데이트
                last_processed_counts[symbol] = closed_candles.size();
                
                Logger::info("Processing", symbol, "-", closed_candles.size(), "1m closed candles from Valkey");
                
                // 디버깅: 가져온 캔들 정보 일부 출력
                if (!closed_candles.empty()) {
                     const auto& first = closed_candles.front();
                     Logger::debug("  First candle:", first.time, "O:", first.open, "C:", first.close);
                }

                // 3. 타임프레임별 집계
                auto aggregated = aggregator.aggregate(closed_candles);
                Logger::info("  Aggregated into", aggregated.size(), "timeframes");
                
                // 4. DynamoDB 저장 (모든 캔들 즉시 저장)
                for (const auto& [interval, candles] : aggregated) {
                    if (candles.empty()) continue;
                    
                    Logger::info("  Saving", candles.size(), "candles for interval", interval, "to DynamoDB...");
                    int saved = dynamodb.batch_put_candles(symbol, interval, candles);
                    if (saved > 0) {
                        Logger::info("  [SUCCESS] DynamoDB:", symbol, interval, "-", saved, "candles saved");
                    } else {
                        Logger::error("  [FAILURE] DynamoDB save failed for", symbol, interval);
                    }
                }
                
                    // 5. S3 백업 (60개 이상일 때만 - 1시간치)
                    // 시간 단위로 그룹핑: YYYYMMDDHHmm에서 YYYYMMDDHHxx 기준
                    size_t processed_count = 0;
                    
                    if (closed_candles.size() >= 60) {
                        // 시간별로 그룹화
                        std::map<std::string, std::vector<Candle>> hourly_groups;
                        for (const auto& c : closed_candles) {
                            // time = YYYYMMDDHHmm → YYYYMMDDHH (시간 단위)
                            std::string hour_key = c.time.substr(0, 10);  // 10자리: YYYYMMDDHH
                            hourly_groups[hour_key].push_back(c);
                        }
                        
                        for (const auto& [hour, hour_candles] : hourly_groups) {
                            // 60개가 모인 시간만 저장 (정시 마감된 시간)
                            if (hour_candles.size() >= 60) {
                                if (s3.put_candles(symbol, "1m", hour_candles)) {
                                    Logger::info("[S3]", symbol, "1m:", hour_candles.size(), "candles saved for hour", hour);
                                    processed_count += hour_candles.size();
                                }
                            }
                        }
                        
                        // 6. [FIX] 저장된 캔들만 Valkey에서 제거 (Trim)
                        // 전체 삭제(DEL) 대신 처리된 개수만큼 앞에서부터 제거하여 데이터 유실 방지
                        if (processed_count > 0) {
                            if (valkey.trim_closed_candles(symbol, processed_count)) {
                                Logger::debug("[VALKEY]", symbol, "trimmed", processed_count, "candles");
                            }
                        }
                        
                        // 처리 후 상태 업데이트 (남은 개수로 갱신)
                        last_processed_counts[symbol] = closed_candles.size() - processed_count;
                    } else {
                        Logger::debug("[S3] Waiting for 60 candles, current:", closed_candles.size());
                        // 아직 60개 미만이면 Valkey에서 삭제하지 않음
                    }
            }
            
        } catch (const std::exception& e) {
            Logger::error("Processing error:", e.what());
        }
        
        // 폴링 간격 대기
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg.poll_interval_ms));
    }
    
    Logger::info("Aggregator stopped");
    Aws::ShutdownAPI(options);
    
    return 0;
}
