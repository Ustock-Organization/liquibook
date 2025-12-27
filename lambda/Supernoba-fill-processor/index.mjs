// Supernoba-fill-processor
// Trigger: Kinesis Stream (supernoba-fills)
// Logic: 
//   1. Update DynamoDB orders (filled_qty, status)
//   2. Update Supabase wallets via process_fill_wallets RPC

import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);

// Supabase Client (for wallets only)
let supabase = null;
function getSupabase() {
    if (!supabase && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }
        });
    }
    return supabase;
}

export const handler = async (event) => {
    const records = event.Records || [];
    console.log(`Processing ${records.length} records...`);

    const results = await Promise.allSettled(records.map(async (record) => {
        try {
            // 1. Parse Data (Base64 -> JSON)
            const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payload);
            
            // Filter only FILL events
            if (data.event !== 'FILL') {
                return; // Skip TRADE or other events
            }

            console.log(`Processing FILL: ${data.trade_id} (${data.symbol})`);

            // 2. Update DynamoDB Orders (Buyer)
            const buyerFullyFilled = data.buyer?.fully_filled === true;
            await updateOrderInDynamoDB(
                data.buyer.user_id, 
                data.buyer.order_id, 
                data.quantity,
                buyerFullyFilled
            );
            console.log(`[DynamoDB] Updated buyer order: ${data.buyer.order_id} (fully_filled: ${buyerFullyFilled})`);

            // 3. Update DynamoDB Orders (Seller)
            const sellerFullyFilled = data.seller?.fully_filled === true;
            await updateOrderInDynamoDB(
                data.seller.user_id, 
                data.seller.order_id, 
                data.quantity,
                sellerFullyFilled
            );
            console.log(`[DynamoDB] Updated seller order: ${data.seller.order_id} (fully_filled: ${sellerFullyFilled})`);

            // 4. Update DynamoDB Holdings (Buyer: 매수 → 수량 증가)
            await updateHoldings(
                data.buyer.user_id,
                data.symbol,
                data.quantity,
                data.price,
                'BUY'
            );
            console.log(`[DynamoDB] Updated buyer holdings: ${data.buyer.user_id} +${data.quantity} ${data.symbol}`);

            // 5. Update DynamoDB Holdings (Seller: 매도 → 수량 감소)
            await updateHoldings(
                data.seller.user_id,
                data.symbol,
                data.quantity,
                data.price,
                'SELL'
            );
            console.log(`[DynamoDB] Updated seller holdings: ${data.seller.user_id} -${data.quantity} ${data.symbol}`);

            // 6. Update Supabase Wallets (balance transfer)
            const client = getSupabase();
            if (client) {
                const { data: rpcData, error } = await client.rpc('process_fill_wallets', {
                    p_symbol: data.symbol,
                    p_buyer_id: data.buyer.user_id,
                    p_seller_id: data.seller.user_id,
                    p_price: data.price,
                    p_quantity: data.quantity,
                    p_timestamp: data.timestamp
                });

                if (error) {
                    console.error(`RPC Fail [${data.trade_id}]:`, error.message);
                    throw error;
                }
                console.log(`[Supabase] Wallets updated: ${JSON.stringify(rpcData)}`);
            }

        } catch (e) {
            console.error("Record Processing Error:", e.message);
            throw e; // Kinesis will retry the batch if we throw
        }
    }));

    // Check failures
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`Batch completed with ${failures.length} errors.`);
    } else {
        console.log("Batch processed successfully.");
    }

    return { statusCode: 200, body: 'Processed' };
};

// Helper: Update order in DynamoDB
async function updateOrderInDynamoDB(userId, orderId, fillQuantity, isFullyFilled = false) {
    // DynamoDB: increment filled_qty
    // 전량 체결 시 status를 FILLED로, 부분 체결 시 PARTIAL로 설정
    const status = isFullyFilled ? 'FILLED' : 'PARTIAL';
    
    try {
        await ddb.send(new UpdateCommand({
            TableName: ORDERS_TABLE,
            Key: { user_id: userId, order_id: orderId },
            UpdateExpression: 'SET filled_qty = if_not_exists(filled_qty, :zero) + :qty, #status = :status, updated_at = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':qty': fillQuantity,
                ':zero': 0,
                ':status': status,
                ':now': new Date().toISOString()
            }
        }));
    } catch (err) {
        console.error(`DynamoDB update failed for ${orderId}:`, err.message);
        throw err;
    }
}

// Helper: Update holdings in DynamoDB
async function updateHoldings(userId, symbol, quantity, price, side) {
    try {
        // 기존 holdings 조회
        const existing = await ddb.send(new GetCommand({
            TableName: HOLDINGS_TABLE,
            Key: { user_id: userId, symbol: symbol.toUpperCase() }
        }));

        const currentQty = existing.Item?.quantity || 0;
        const currentAvgPrice = existing.Item?.avgPrice || 0;
        const currentTotalCost = currentQty * currentAvgPrice;

        let newQty, newAvgPrice;

        if (side === 'BUY') {
            // 매수: 수량 증가, 평균 단가 재계산
            const fillCost = quantity * price;
            newQty = currentQty + quantity;
            newAvgPrice = newQty > 0 ? (currentTotalCost + fillCost) / newQty : price;
        } else {
            // 매도: 수량 감소 (FIFO 방식으로 평균 단가는 유지)
            newQty = Math.max(0, currentQty - quantity);
            newAvgPrice = newQty > 0 ? currentAvgPrice : 0;
        }

        if (newQty <= 0) {
            // 수량이 0 이하면 holdings 삭제
            try {
                await ddb.send(new DeleteCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: userId, symbol: symbol.toUpperCase() }
                }));
            } catch (deleteErr) {
                // 이미 삭제되었거나 없는 경우 무시
                if (deleteErr.name !== 'ResourceNotFoundException') {
                    throw deleteErr;
                }
            }
        } else {
            // holdings 업데이트 또는 생성
            await ddb.send(new PutCommand({
                TableName: HOLDINGS_TABLE,
                Item: {
                    user_id: userId,
                    symbol: symbol.toUpperCase(),
                    quantity: newQty,
                    avgPrice: newAvgPrice,
                    updated_at: new Date().toISOString()
                }
            }));
        }
    } catch (err) {
        console.error(`[Holdings] Update failed for ${userId}/${symbol}:`, err.message);
        // Holdings 업데이트 실패는 치명적이지 않으므로 throw하지 않음
    }
}

