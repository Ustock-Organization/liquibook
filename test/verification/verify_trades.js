const https = require('https');

// Configuration
const API_BASE_URL = 'https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2';
const USER_ID = 'test-user-1';
const SYMBOL = 'TEST';

async function verifyTrades() {
    console.log(`Checking Trade History for user: ${USER_ID}, symbol: ${SYMBOL}`);
    console.log(`Endpoint: ${API_BASE_URL}/trades`);
    
    const url = `${API_BASE_URL}/trades?user_id=${USER_ID}&symbol=${SYMBOL}&limit=10`;
    
    const req = https.get(url, (res) => {
        let data = '';
        
        console.log(`Response Status: ${res.statusCode} ${res.statusMessage}`);
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    const json = JSON.parse(data);
                    console.log('✅ Trade History retrieved:');
                    if (json.trades && json.trades.length > 0) {
                        console.table(json.trades);
                    } else {
                        console.log('No trades found (empty array).');
                    }
                } catch (e) {
                    console.log('❌ Failed to parse JSON:', e.message);
                    console.log('Raw Body:', data);
                }
            } else {
                console.log('❌ Request failed.');
                console.log('Body:', data);
                if (res.statusCode === 403 || res.statusCode === 404) {
                    console.log('=> This indicates the /trades endpoint is NOT implemented or not accessible.');
                }
            }
        });
    });
    
    req.on('error', (e) => {
        console.error('Network Error:', e.message);
    });
}

verifyTrades();
