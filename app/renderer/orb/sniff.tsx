import { createRoot } from 'react-dom/client';
import { SniffOrb } from './SniffOrb';
import './orb.css';

/**
 * 嗅探球窗口的入口。
 *
 * 不用 `StrictMode`：它会在开发模式下**故意双调用** effect，而球的每个 effect
 * 都在跟主进程/插件通信 —— 双调用意味着开两次面板、订阅两次事件、
 * 发两遍请求。生产构建里 StrictMode 不做这件事，所以这个代价只在开发时出现，
 * 而"开发时行为与生产不一致"本身就是最该避免的。
 */
const container = document.getElementById('root');
if (container) createRoot(container).render(<SniffOrb />);
