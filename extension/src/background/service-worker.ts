/**
 * MV3 service worker 入口。
 *
 * 生命周期是这里的核心约束：空闲约 30 秒即被终止，任何"留在内存里的状态"
 * 都不可依赖。所以这个文件只做**幂等的注册**，不做长任务——下载、BT、
 * Agent 循环这类跨越分钟级的工作必须落 chrome.storage 或交给本机应用。
 */

/**
 * 点扩展图标直接开侧边栏，而不是弹 popup。
 *
 * Agent 与篡改工具的语义都是"对当前标签页做事"，需要一个常驻且跟随标签页的
 * 面板；popup 一失焦就销毁，做不到。
 */
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => {
        console.error('设置侧边栏行为失败：', error);
    });
