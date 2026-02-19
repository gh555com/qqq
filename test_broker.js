const net = require('net');
const fs = require('fs');
const path = require('path');

const cacheDir = 'C:\\Users\\q\\AppData\\Local\\vix_audio_broker';
const endpointPath = path.join(cacheDir, 'endpoint.json');
const tokenPath = path.join(cacheDir, 'token.txt');

console.log('Reading endpoint...');
const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
const token = fs.readFileSync(tokenPath, 'utf8').trim();

console.log('Endpoint:', endpoint);
console.log('Token:', token);

const pipePath = endpoint.name;
console.log('Connecting to:', pipePath);

const s = net.connect({ path: pipePath });

s.on('connect', () => {
    console.log('Connected!');
    const req = JSON.stringify({
        _id: 1,
        action: 'ping',
        client_id: 'test_client',
        token: token
    }) + '\n';
    console.log('Sending:', req);
    s.write(req);
});

s.on('data', (data) => {
    console.log('Received:', data.toString());
    s.destroy();
    process.exit(0);
});

s.on('error', (err) => {
    console.log('Error:', err.message);
    process.exit(1);
});

setTimeout(() => {
    console.log('Timeout!');
    process.exit(1);
}, 10000);
