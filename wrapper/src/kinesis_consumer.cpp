#include "kinesis_consumer.h"
#include "logger.h"
#include "config.h"
#include <aws/core/Aws.h>
#include <aws/kinesis/model/GetShardIteratorRequest.h>
#include <aws/kinesis/model/GetRecordsRequest.h>
#include <aws/kinesis/model/DescribeStreamRequest.h>
#include <chrono>
#include <thread>

namespace aws_wrapper {

KinesisConsumer::KinesisConsumer(const std::string& stream_name,
                                  const std::string& region)
    : stream_name_(stream_name), region_(region) {
    
    Aws::Client::ClientConfiguration config;
    config.region = region_;
    
    client_ = std::make_unique<Aws::Kinesis::KinesisClient>(config);
    
    Logger::info("KinesisConsumer created, stream:", stream_name_, "region:", region_);
}

KinesisConsumer::~KinesisConsumer() {
    stop();
}

std::string KinesisConsumer::getShardIterator(const std::string& shard_id) {
    Aws::Kinesis::Model::GetShardIteratorRequest request;
    request.SetStreamName(stream_name_);
    request.SetShardId(shard_id);
    request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::LATEST);
    
    auto outcome = client_->GetShardIterator(request);
    if (!outcome.IsSuccess()) {
        Logger::error("Failed to get shard iterator:", outcome.GetError().GetMessage());
        return "";
    }
    
    return outcome.GetResult().GetShardIterator();
}

void KinesisConsumer::start() {
    if (running_) return;
    
    // 스트림 정보 가져오기
    Aws::Kinesis::Model::DescribeStreamRequest desc_request;
    desc_request.SetStreamName(stream_name_);
    
    auto desc_outcome = client_->DescribeStream(desc_request);
    if (!desc_outcome.IsSuccess()) {
        Logger::error("Failed to describe stream:", desc_outcome.GetError().GetMessage());
        return;
    }
    
    // 첫 번째 샤드의 iterator 가져오기
    const auto& shards = desc_outcome.GetResult().GetStreamDescription().GetShards();
    if (shards.empty()) {
        Logger::error("No shards found in stream:", stream_name_);
        return;
    }
    
    shard_iterator_ = getShardIterator(shards[0].GetShardId());
    if (shard_iterator_.empty()) {
        return;
    }
    
    running_ = true;
    worker_ = std::thread(&KinesisConsumer::consumeLoop, this);
    
    Logger::info("KinesisConsumer started, stream:", stream_name_);
}

void KinesisConsumer::stop() {
    if (!running_) return;
    
    running_ = false;
    if (worker_.joinable()) {
        worker_.join();
    }
    
    Logger::info("KinesisConsumer stopped");
}

void KinesisConsumer::consumeLoop() {
    while (running_) {
        if (shard_iterator_.empty()) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            continue;
        }
        
        Aws::Kinesis::Model::GetRecordsRequest request;
        request.SetShardIterator(shard_iterator_);
        request.SetLimit(100);
        
        auto outcome = client_->GetRecords(request);
        if (!outcome.IsSuccess()) {
            Logger::error("GetRecords failed:", outcome.GetError().GetMessage());
            std::this_thread::sleep_for(std::chrono::seconds(1));
            continue;
        }
        
        const auto& result = outcome.GetResult();
        shard_iterator_ = result.GetNextShardIterator();
        
        for (const auto& record : result.GetRecords()) {
            const auto& data = record.GetData();
            std::string value(reinterpret_cast<const char*>(data.GetUnderlyingData()),
                              data.GetLength());
            std::string partition_key = record.GetPartitionKey();
            
            Logger::debug("Received Kinesis record, key:", partition_key, "len:", data.GetLength());
            
            if (callback_) {
                try {
                    callback_(partition_key, value);
                } catch (const std::exception& e) {
                    Logger::error("Callback error:", e.what());
                }
            }
        }
        
        // Kinesis는 최소 200ms 간격 권장
        if (result.GetRecords().empty()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }
}

} // namespace aws_wrapper
