#pragma once

#include <hiredis/hiredis.h>
#include <string>
#include <memory>
#include <optional>
#include <vector>
#include <map>

namespace aws_wrapper {

class RedisClient {
public:
    RedisClient(const std::string& host, int port);
    ~RedisClient();
    
    bool connect();
    bool isConnected() const { return context_ != nullptr; }
    
    // 기본 연산
    bool set(const std::string& key, const std::string& value);
    bool setEx(const std::string& key, const std::string& value, int ttl_seconds);
    std::optional<std::string> get(const std::string& key);
    bool del(const std::string& key);
    bool exists(const std::string& key);
    std::vector<std::string> keys(const std::string& pattern);
    
    // 리스트 연산 (체결 내역용)
    bool lpush(const std::string& key, const std::string& value);
    bool ltrim(const std::string& key, long start, long stop);
    std::vector<std::string> lrange(const std::string& key, long start, long stop);
    
    // 해시 연산 (캔들용)
    bool hset(const std::string& key, const std::string& field, const std::string& value);
    std::optional<std::string> hget(const std::string& key, const std::string& field);
    std::map<std::string, std::string> hgetall(const std::string& key);
    
    // Lua Script (EVAL)
    std::string eval(const std::string& script, int numKeys, 
                     const std::vector<std::string>& keys,
                     const std::vector<std::string>& args);
    
    // 캔들 집계 (Lua Script 사용)
    bool updateCandle(const std::string& symbol, uint64_t price, uint64_t qty, int64_t timestamp);
    
    // 스냅샷 전용
    bool saveSnapshot(const std::string& symbol, const std::string& data);
    std::optional<std::string> loadSnapshot(const std::string& symbol);
    
private:
    std::string host_;
    int port_;
    redisContext* context_ = nullptr;
};

} // namespace aws_wrapper
