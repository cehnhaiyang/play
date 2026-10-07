// 本地请求头抓取服务：把收到的完整头（含顺序）按 client 标签写进 hdr.log
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LOG = path.join(__dirname, 'hdr.log');
const PORT = 8791;

const srv = http.createServer((req, res) => {
    fs.appendFileSync(LOG, JSON.stringify({
        at: new Date().toISOString(),
        url: req.url,
        httpVersion: req.httpVersion,
        headers: req.headers,   // Node 保留到达顺序
    }) + '\n');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>hdr</title></head><body>hdr probe</body></html>');
});

srv.listen(PORT, '127.0.0.1', () => {
    fs.writeFileSync(LOG, '');
    console.log('listening on http://127.0.0.1:' + PORT + '/');
});
