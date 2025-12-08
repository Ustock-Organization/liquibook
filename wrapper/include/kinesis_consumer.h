#pragma once

#include <aws/kinesis/KinesisClient.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>

namespace aws_wrapper {

class KinesisConsumer {
public:
    using MessageCallback = std::function<void(const std::string& key,
                                                const std::string& value)>;
    
    KinesisConsumer(const std::string& stream_name,
                    const std::string& region = "ap-northeast-2");
    ~KinesisConsumer();
    
    void setCallback(MessageCallback callback) { callback_ = std::move(callback); }
    void start();
    void stop();
    bool isRunning() const { return running_; }
    
private:
    void consumeLoop();
    std::string getShardIterator(const std::string& shard_id);
    
    std::unique_ptr<Aws::Kinesis::KinesisClient> client_;
    std::string stream_name_;
    std::string region_;
    MessageCallback callback_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::string shard_iterator_;
};

} // namespace aws_wrapper
