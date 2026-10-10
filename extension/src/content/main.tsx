import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentOrb } from './AgentOrb';
import { SniffOrb } from './SniffOrb';
import shadowCss from './shadow.css?inline';

/**
 * content script 入口：把两个悬浮球挂进当前页面。
 *
 * ## Shadow DOM 是必需的，不是讲究
 *
 * 隔离是**双向**的，两个方向都会坏：
 *
 * - **页面 → 球**：站点自己的 CSS 里有 `div { ... }`、`* { box-sizing }` 这类
 *   全局规则，直接挂在 document 上会被它们命中。表现是"在某些站上球变形了"，
 *   而且只在部分站点复现 —— 最难查的一类。
 * - **球 → 页面**：Tailwind 的 preflight 会重置 `html`/`body`/`button` 的样式。
 *   不隔离的话，注入球等于**改掉用户正在看的页面**。
 *
 * Shadow Root 同时挡住两者。样式表以字符串注入（`?inline`）而不是 link：
 * 后者要经过 `web_accessible_resources`，多一层配置且会被页面观察到。
 *
 * ## 宿主元素本身也要挡住页面
 *
 * Shadow Root 的隔离从宿主元素**内部**开始 —— 宿主自己的 `position`、`z-index`、
 * `display` 仍由页面 CSS 决定。所以宿主用内联样式写死这几项，并加上
 * `all: initial` 的等效做法：内联样式优先级高于页面的大多数选择器
 * （除非页面用了 `!important`，那种情况只能靠 `!important` 对冲）。
 *
 * ## 两个球各自一个 Shadow Root
 *
 * 不共用一个容器：共容器意味着"收起 A 球"要碰共同父节点，而两个球本来就该
 * 互不相干。代价是两个 Shadow Root，收益是它们之间**没有任何共享状态**。
 */

/** 宿主元素的内联样式。逐条都有理由，见文件头 */
const HOST_STYLE = [
    'all: initial',
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    // 最高的常规层。用 2147483647（int 上限）会与浏览器自己的 UI 打架
    'z-index: 2147483646',
    'pointer-events: none',
].join('; ');

const mountOrb = (id: string, render: () => React.ReactElement): void => {
    // 幂等：SPA 里 history 变化可能让脚本重复注入，重复挂会得到两个一模一样的球
    if (document.getElementById(id)) return;

    const host = document.createElement('div');
    host.id = id;
    host.setAttribute('style', HOST_STYLE);

    /*
     * `mode: 'closed'` 还是 `'open'`？
     *
     * 用 open：闭模式挡不住有心人（`Element.prototype.attachShadow` 可以被改写），
     * 而它会让调试变成噩梦 —— 用户在 DevTools 里看不到球，我们自己也看不到。
     * 这里的目标是样式隔离，不是防篡改。
     */
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = shadowCss;
    shadow.appendChild(style);

    /*
     * 球挂在一个铺满视口的容器里。
     *
     * 宿主是 0×0 的，球用 `position: fixed` 定位 —— 但 `pointer-events: none`
     * 在宿主上，所以容器要显式把球那一块恢复成 auto，否则球点不动。
     * OrbShell 里每个可交互元素自带 pointer-events-auto（见其根节点类名）。
     */
    const container = document.createElement('div');
    container.style.cssText = 'position: fixed; inset: 0; pointer-events: none;';
    shadow.appendChild(container);

    document.documentElement.appendChild(host);
    createRoot(container).render(<StrictMode>{render()}</StrictMode>);
};

/*
 * 两个球各自挂载，互不引用。
 *
 * 顺序即 z-index 顺序（后者画在上面），但两者位置不同、默认就错开，
 * 所以这里的顺序不影响可用性。
 */
mountOrb('the-play-sniff-orb', () => <SniffOrb />);
mountOrb('the-play-agent-orb', () => <AgentOrb />);
