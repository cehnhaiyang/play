import { createRoot } from 'react-dom/client';
import { AgentOrb } from './AgentOrb';
import './orb.css';

/** Agent 球窗口的入口。不用 StrictMode 的理由见 sniff.tsx */
const container = document.getElementById('root');
if (container) createRoot(container).render(<AgentOrb />);
