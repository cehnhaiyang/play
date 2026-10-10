import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

/**
 * content script 的独立构建。
 *
 * ## 为什么不能并进 vite.config.mts
 *
 * 两边的产物格式不同，而 Rollup 一次构建只能有一个 output.format：
 *
 *  - panel / service worker 是 ESM（manifest 里 `"type": "module"`）；
 *  - **content script 不能是 ESM**。manifest 的 `content_scripts` 没有
 *    `type` 字段，声明成 `.js` 就按传统脚本求值，出现 `import` 语句会直接
 *    语法错误。所以它必须是自包含的 IIFE。
 *
 * 合成一次构建会逼出一个 `output` 数组，两个 format 各自都要把三份入口
 * 全部产出（ESM 那份会多出一个没人引用的 content.js，IIFE 那份则因为
 * 代码分割直接构建失败），比拆成两次构建更难维护。
 *
 * ## emptyOutDir 必须关掉
 *
 * `ext:build` 先跑主构建（清空 dist），再跑这一份（追加）。
 * 这里若保持默认的 true，第二次构建会把 panel.js 与 service-worker.js 删掉，
 * 而脚本退出码仍是 0 —— 产物缺文件但构建"成功"。
 */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: `${here}src`,
    // 静态资源由主构建负责拷贝，这里再拷一次只会覆盖同一批文件
    publicDir: false,
    plugins: [react()],
    css: {
        postcss: {
            plugins: [tailwindcss(), autoprefixer()],
        },
    },
    build: {
        outDir: `${here}dist`,
        emptyOutDir: false,
        modulePreload: false,
        target: 'chrome116',
        // CSS 走 `?inline` 进 JS 字符串，不产出独立 .css 文件；
        // 关掉代码分割保证只有一个 content.js，manifest 里好写
        cssCodeSplit: false,
        rollupOptions: {
            input: `${here}src/content/main.tsx`,
            output: {
                format: 'iife',
                inlineDynamicImports: true,
                entryFileNames: 'content.js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
        },
    },
});
