'use strict';

/**
 * 生成插件的签名密钥，并把扩展 id 定下来。
 *
 * ## 为什么必须钉住 id
 *
 * native messaging 的 host manifest 里要写 `allowed_origins`，形如
 * `chrome-extension://<id>/`。而**未打包扩展的 id 是由加载路径的绝对路径哈希出来的**
 * —— 换一台机器、换一个目录，id 就变了，host manifest 立刻失效，表现为
 * `connectNative` 报 "Specified native messaging host not found"，
 * 而真正的原因和那句话毫无关系。
 *
 * 把公钥写进 manifest.json 的 `key` 字段之后，id 就只由这把密钥决定，
 * 与路径无关。
 *
 * 这是**一次性**操作：密钥已经生成好了，结果直接写在下面的常量里，
 * 平时不需要再跑这个文件。留在这里是为了让"id 是怎么来的"可复查。
 *
 * 跑法：node test/e2e/genkey.js
 */

const crypto = require('node:crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Chrome 的 id 算法：SHA256(公钥 DER) 取前 16 字节，每个 nibble 映射到 a-p */
const idOf = (publicKeyDer) => {
    const hash = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
    let id = '';
    for (const byte of hash) {
        id += String.fromCharCode(97 + (byte >> 4));
        id += String.fromCharCode(97 + (byte & 0x0f));
    }
    return id;
};

const key = publicKey.toString('base64');
console.log('=== manifest.json 的 key 字段 ===');
console.log(key);
console.log('');
console.log('=== 扩展 id ===');
console.log(idOf(publicKey));
console.log('');
console.log('=== allowed_origins ===');
console.log(`chrome-extension://${idOf(publicKey)}/`);
console.log('');
console.log('=== 私钥（.pem，留档用，不要提交） ===');
console.log(privateKey);
