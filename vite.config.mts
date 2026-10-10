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
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
