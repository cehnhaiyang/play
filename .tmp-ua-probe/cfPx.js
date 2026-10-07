// 量一下截图里组件的真实位置（DPR=1，所以图像像素 = CSS 像素）。
// 目的：核对 CDP 报的 iframe 盒 (16,304,300x65) 与"眼睛看到的复选框"是不是同一个地方。
const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.on('window-all-closed', () => { });
app.whenReady().then(() => {
    const OUT = path.join(__dirname, 'cfPx.txt');
    const lines = [];
    for (const name of ['cfD-8.png', 'cfD-20.png', 'cfD-32.png']) {
        const p = path.join(__dirname, name);
        if (!fs.existsSync(p)) continue;
        const img = nativeImage.createFromPath(p);
        const { width, height } = img.getSize();
        const bmp = img.getBitmap();
        const at = (x, y) => {
            const i = (y * width + x) * 4;
            return [bmp[i], bmp[i + 1], bmp[i + 2]];
        };
        const grey = (x, y) => {
            const [r, g, b] = at(x, y);
            // 组件底色是浅灰（约 #F8F8F8~#EDEDED），页面是纯白
            return Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r >= 225 && r <= 250;
        };
        const dark = (x, y) => {
            const [r, g, b] = at(x, y);
            return r < 120 && g < 120 && b < 120;
        };
        // 只在 CDP 报的组件盒范围内找（x 16..316, y 304..369），深色像素 = 复选框边框
        let dx = [1e9, -1], dy = [1e9, -1], dn = 0;
        for (let y = 304; y <= 369; y++) {
            for (let x = 16; x <= 316; x++) {
                if (!dark(x, y)) continue;
                dn += 1;
                if (x < dx[0]) dx[0] = x;
                if (x > dx[1]) dx[1] = x;
                if (y < dy[0]) dy[0] = y;
                if (y > dy[1]) dy[1] = y;
            }
        }
        lines.push(`${name} 尺寸=${width}x${height}`);
        lines.push(`  组件盒内深色像素(边框/文字) = x[${dx[0]}..${dx[1]}] y[${dy[0]}..${dy[1]}] 像素=${dn}`
            + ` 中心=(${Math.round((dx[0] + dx[1]) / 2)},${Math.round((dy[0] + dy[1]) / 2)})`);
        // 逐行统计，定位复选框那个空心方框（左右两条竖线）
        for (let y = 304; y <= 369; y += 4) {
            const row = [];
            for (let x = 16; x <= 316; x++) if (dark(x, y)) row.push(x);
            if (row.length) lines.push(`    y=${y} 深色x = ${row.slice(0, 14).join(',')}`);
        }
    }
    fs.writeFileSync(OUT, lines.join('\n') + '\n');
    app.exit(0);
});
