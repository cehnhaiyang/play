// 首个 import：日志拦截必须在所有模块之前安装，否则各模块 import 阶段的
// 顶层日志（以及之后的一切 console.*）都进不了运行日志页。LogService 在
// 浏览器里 import 即自动安装，这次显式调用是双保险（幂等）+ 宣示意图。
import { installLogCapture } from './services/LogService';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

installLogCapture();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
