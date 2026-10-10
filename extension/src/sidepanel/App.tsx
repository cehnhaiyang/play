import { useEffect, useState } from 'react';

/**
 * 骨架自检：列出本扩展实际拿到的 chrome.* 能力。
 *
 * 存在的意义是让"骨架立起来了"这件事**可验证**而不是靠肉眼——权限名写错、
 * manifest 没被加载、service worker 没起来，都会在这里表现为一行 missing。
 * 真实功能（嗅探、Agent、篡改、与本机应用的桥）接上来之后，这个面板会被替换。
 */

/** 计划要用到的 API。缺任何一项都说明 manifest 的 permissions 没生效。 */
const REQUIRED_APIS = [
    'sidePanel',
    'storage',
    'tabs',
    'scripting',
    'webRequest',
    'cookies',
    'downloads',
    'runtime',
] as const;

type ApiName = (typeof REQUIRED_APIS)[number];

const probeApis = (): { name: ApiName; ok: boolean }[] =>
    REQUIRED_APIS.map((name) => ({ name, ok: Boolean(chrome?.[name]) }));

export const App = () => {
    const [apis, setApis] = useState<{ name: ApiName; ok: boolean }[]>([]);
    const [version, setVersion] = useState('');

    useEffect(() => {
        setApis(probeApis());
        setVersion(chrome.runtime.getManifest().version);
    }, []);

    const missing = apis.filter((item) => !item.ok);

    return (
        <div className="flex h-full w-full flex-col gap-4 p-4">
            <header className="flex items-baseline gap-2">
                <h1 className="text-sm font-bold text-slate-100">The Play</h1>
                <span className="font-mono text-[10px] text-slate-500">v{version}</span>
            </header>

            <section className="rounded-lg border border-white/10 bg-white/3 p-3">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    扩展能力
                </div>
                <ul className="space-y-0.5">
                    {apis.map((item) => (
                        <li key={item.name} className="flex items-center gap-2 text-[11px]">
                            <span className={item.ok ? 'text-emerald-400' : 'text-rose-400'}>
                                {item.ok ? '✓' : '✗'}
                            </span>
                            <span className="font-mono text-slate-300">chrome.{item.name}</span>
                        </li>
                    ))}
                </ul>
                {missing.length > 0 && (
                    <p className="mt-2 text-[10px] text-rose-300">
                        缺 {missing.map((item) => item.name).join('、')} —— 检查 manifest 的 permissions。
                    </p>
                )}
            </section>

            <section className="rounded-lg border border-dashed border-white/10 p-3 text-[10px] text-slate-500">
                本机应用桥（native messaging）尚未接入。播放、BT、ffmpeg 与落盘仍在 The Play 应用里。
            </section>
        </div>
    );
};
