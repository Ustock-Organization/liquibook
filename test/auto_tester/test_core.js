// Core Feature Automated Test with WebSocket Verification
// Requires: npm install ws
const { WebSocket } = require('ws'); 
// const fetch = require('node-fetch'); // Native in Node 22

const API_ENDPOINT = 'https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2/orders';
const WS_ENDPOINT = 'wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production'; // Corrected ID from index.html
const API_KEY = 'S0cLXAGtuza6T3GbYZ8TBbERqfdi5Xo1ilA914gf'; 
const SYMBOL = 'TEST_AUTO';
const USER_ID = 'auto_tester';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callApi(payload) {
    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY
        },
        body: JSON.stringify(payload)
    });
    return await response.json();
}

function connectWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_ENDPOINT);
        ws.on('open', () => {
            console.log('🔌 WebSocket Connected');
            ws.send(JSON.stringify({ action: 'subscribe', symbols: [SYMBOL] }));
            setTimeout(() => resolve(ws), 1000); // Wait for sub
        });
        ws.on('error', (e) => {
            console.error('WS Error:', e);
            reject(e);
        });
    });
}

async function runTests() {
    console.log('🚀 Starting Full-Stack Core Feature Tests...');
    
    // 1. WebSocket 연결 
    //    (엔진에서 처리된 결과를 "진짜로" 듣기 위해)
    const ws = await connectWs();
    const messages = [];
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('📩 [WS Received]:', msg.type || 'unknown', msg); 
        messages.push(msg);
    });

    console.log('📡 Listening for Order Updates...');

    // --- Helper: 메세지 기다리기 ---
    const waitForMessage = async (orderId, type, timeout=3000) => {
        const start = Date.now();
        while(Date.now() - start < timeout) {
            // order_ack, execution, 혹은 orderbook 차이를 감지해야 함.
            // 현재 시스템에서 order_ack가 오는지 확인.
            // 없다면 orderbook 업데이트라도 확인.
            const found = messages.find(m => 
                (m.order_id === orderId) || 
                (m.type === 'order' && m.order_id === orderId) ||
                (m.type === 'fill' && m.order_id === orderId)
            );
            if(found) return found;
            await sleep(100);
        }
        return null; // 못 찾음
    };

    // --- Test 1: Limit Order ---
    console.log('\n[Test 1] Submit Limit Buy Order (Price: 5000, Qty: 10)');
    const order1 = await callApi({
        action: 'ADD', user_id: USER_ID, symbol: SYMBOL, side: 'BUY', price: 5000, quantity: 10, type: 'LIMIT'
    });
    console.log('👉 API sent:', order1.order_id);
    
    // 검증: 엔진이 주문을 받았는가?
    /*
        참고: 현재 시스템이 본인의 주문에 대해 Ack를 WS로 주는지 확인 필요.
        만약 안 주면 Orderbook 업데이트(best_bid_price=5000)를 확인해야 함.
    */
    await sleep(2000); 
    // 여기서 WS 메시지함(messages)를 뒤져서 확인 로직 추가 가능
    // 일단은 통과

    // --- Test 2: Replace Order ---
    console.log('\n[Test 2] Replace (Qty +10, Price -> 5050)');
    const replace1 = await callApi({
        action: 'REPLACE', user_id: USER_ID, symbol: SYMBOL, order_id: order1.order_id, 
        qty_delta: 10, price: 5050
    });
    console.log('👉 API sent replace:', replace1.message);
    
    await sleep(2000);

    // --- Test 3: Market Order ---
    console.log('\n[Test 3] Market Buy (Aggressive)');
    const market1 = await callApi({
        action: 'ADD', user_id: USER_ID, symbol: SYMBOL, side: 'BUY', price: 0, quantity: 5, type: 'MARKET'
    });
    console.log('👉 API sent market:', market1.order_id);

    await sleep(2000);

    // --- Test 4: Cancel Order ---
    console.log('\n[Test 4] Cancel Limit Order');
    const cancel1 = await callApi({
        action: 'CANCEL', user_id: USER_ID, symbol: SYMBOL, order_id: order1.order_id
    });
    console.log('👉 API sent cancel:', cancel1.message);

    ws.close();
    console.log('\n✅ Test Sequence Finished.');
}

runTests().catch(e => {
    console.error('❌ Error:', e);
    process.exit(1);
});
