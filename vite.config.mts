import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * 应用渲染层的构建。
 *
 * root 指向 app/renderer/ —— 与插件的构建（extension/vite.config.mts）各自独立，
 * 产物也分开：这里是 dist/（由 BrowserWindow.loadFile 以 file:// 打开），
 * 插件是 extension/dist/（由 chrome-extension:// 加载）。
 *
 * 源码在 app/renderer/ 下，但它 import 的 shared/ 在仓库根 —— vite 允许
 * root 之外的 import，只要在 fs.allow 里（默认已包含工作区根）。
 *
 * ## 三个入口，不是一个
 *
 * 主窗口之外还有两个**悬浮球窗口**（见 app/main/orbs.js）。三个页面共用
 * 一份渲染层源码树，但各自是独立入口：
 *
 *   · `index.html`      主窗口
 *   · `orb/sniff.html`  嗅探球
 *   · `orb/agent.html`  Agent 球
 *
 * 拆成独立入口而不是"一个页面靠 query 参数区分形态"，是因为球的窗口尺寸与
 * 主窗口完全不同（64×64 / 380×520 / 1280×800），共用一份 bundle 会让每个球
 * 都把另外两个页面的代码一起加载 —— 而球是常驻窗口，那份浪费一直在。
 */
export default defineConfig({
  root: `${here}app/renderer`,
  plugins: [react()],
  // 必须是相对路径：打包后主进程用 BrowserWindow.loadFile() 以 file:// 打开
  // dist/index.html，而 Vite 默认的 base:'/' 会产出 /assets/index-xxx.js ——
  // 在 file:// 下解析成 file:///D:/assets/...（盘符根目录），必然 404。
  // 表现是打包版白屏、dev 版正常（dev 由 vite server 提供，根路径有效）。
  base: './',
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: `${here}app/renderer/index.html`,
        'orb/sniff': `${here}app/renderer/orb/sniff.html`,
        'orb/agent': `${here}app/renderer/orb/agent.html`,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
