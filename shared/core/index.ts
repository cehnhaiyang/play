/**
 * shared/core —— 两边共用的纯逻辑。
 *
 * ## 准入判据：**求值期**不能碰宿主
 *
 * 这里的东西被三种运行环境同时使用：
 *   · Electron 渲染层（有 DOM）
 *   · 插件 service worker（**没有 DOM**）
 *   · Node 回归测试（没有 DOM）
 *
 * 关键区分是**求值期**与**调用期**：
 *
 *   · 求值期碰宿主 —— 模块顶层就 `localStorage.getItem(...)` 或 `new AudioContext()`。
 *     这种文件一旦被 service worker import，装上就崩，且崩在模块顶层、
 *     没有任何指向性错误。**严禁**。
 *   · 调用期碰宿主 —— 函数体里用 `document.createElement`。
 *     求值它无害（只是定义一个函数），在 service worker 里调用它才是错的。
 *     这类可以放，但每个文件头部都注明了"需要 DOM"。
 *
 * 目前全部模块都是安全的，唯一例外是 `gallery`：
 *
 *   **`gallery` 刻意不在这里导出。** 它 import 了 JSZip —— 那是几百 KB 的包，
 *   而插件侧根本不需要打包/解包 .gallery。放进索引会让任何 `from 'shared/core'`
 *   的 service worker 代码把它整包拖进 SW bundle。要用请按具体路径 import：
 *   `import { unpackGalleryPack } from 'shared/core/gallery'`。
 *
 * 需要 DOM 的（调用期）：
 *   storage（localStorage）· images（FileReader）· files（Blob URL / document）
 */

export * from './media';
export * from './playback';
export * from './cookies';
export * from './jwt';
export * from './tamper-rules';
export * from './sniff';
export * from './acg';
export * from './ids';
export * from './names';
export * from './aibook';
export * from './agent-export';
export * from './storage';
export * from './images';
export * from './files';
