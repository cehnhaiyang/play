import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './panel.css';

const host = document.getElementById('root');
if (!host) throw new Error('panel.html 缺少 #root 挂载点');

createRoot(host).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
