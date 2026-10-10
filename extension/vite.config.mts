import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

/**
 * 插件独立构建，与 app 的 dist/ 互不干扰。
 *
 * 两边产物形态不同，不能共用一份配置：
 *  - app 由 BrowserWindow.loadFile() 以 file:// 打开，必须 base:'./'；
 *  - 插件由 chrome-extension:// 加载，路径天然是绝对根，且 service worker
 *    必须是**固定文件名**的 ESM（manifest 里写死了 service-worker.js），
 *    不能带 hash。
 *
 * 所有路径都从本文件位置推导，不用相对路径：`--config extension/…` 从仓库根
 * 调用时，vite 的 root/publicDir/outDir 是按 **CWD** 解析的，相对写法会指到
 * 仓库根的 src/ 与 dist/ 上去，表现是 "Cannot resolve entry module"。
 */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: `${here}src`,
  publicDir: `${here}public`,
  plugins: [react()],
  css: {
    // 内联而不是放 postcss.config.js：本包的 vite root 是 src/，
    // 配置查找从 root 出发，extension/ 下那份不会被读到。
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  build: {
    outDir: `${here}dist`,
    emptyOutDir: true,
    // service worker 不支持代码分割出的动态 import 图，关掉可以让产物更可预测
    modulePreload: false,
    target: 'chrome116',
    /*
     * const.ts 顶层 `import JSZip from 'jszip'`（供 .gallery 打包用）。
     * 插件只取它的纯常量与纯函数，用不到 JSZip，但那个顶层 import 是
     * **有副作用的 UMD 包装**，打包器不敢删 —— 结果是 103KB 的
     * zip 库连同它的 document/MutationObserver polyfill 被塞进
     * service worker（一个没有 DOM、且每次唤醒都要重新求值的环境）。
     *
     * 声明 jszip 无副作用，让 tree-shaking 在"没人用它的导出"时丢掉整包。
     * 这不是把它 stub 掉：一旦真有代码用到 JSZip，它的导出会被保留，
     * 只是不再无条件进包。
     */
    rollupOptions: {
      treeshake: {
        moduleSideEffects: (id) => !id.includes('jszip'),
      },
      input: {
        panel: `${here}src/panel.html`,
        'service-worker': `${here}src/background/service-worker.ts`,
      },
      output: {
        // 固定名：manifest.json 与 panel.html 里引用的路径不能带 hash
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
