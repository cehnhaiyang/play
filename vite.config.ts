import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 必须是相对路径：打包后主进程用 BrowserWindow.loadFile() 以 file:// 打开
  // dist/index.html，而 Vite 默认的 base:'/' 会产出 /assets/index-xxx.js ——
  // 在 file:// 下解析成 file:///D:/assets/...（盘符根目录），必然 404。
  // 表现是打包版白屏、dev 版正常（dev 由 vite server 提供，根路径有效）。
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
});
