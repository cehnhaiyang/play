import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { TamperRule, HeaderRule, WebviewElement } from '../meta';
import { loadStr, saveStr } from '../utils/persist';

// 注入到页面的核心 Hook 脚本 (Ultimate Edition)
// 包含：JSON.parse Hook, Response.json Hook, XHR Hook, Fetch Hook, LocalStorage Hook
const INJECT_SCRIPT = `
(function(config) {
    // 1. Config Update Mechanism
    if (window.__interceptorInstalled) {
        window.__interceptorConfig = config;
        console.log('%c[Tamper] 🔄 Rules Updated', 'color: #0f0; background: #333; padding: 2px 4px; border-radius: 2px;');
        return;
    }
    window.__interceptorInstalled = true;
    window.__interceptorConfig = config;
    
    console.log('%c[Tamper] 🛡️ Interceptor v3.0 Activated', 'color: #fff; background: #e00; font-weight: bold; padding: 4px; border-radius: 4px;');

    // Helper: Hide Hook Traces (Basic Anti-Anti-Tamper)
    const maskFn = (fn, original) => {
        try {
            Object.defineProperty(fn, 'name', { value: original.name });
            Object.defineProperty(fn, 'length', { value: original.length });
            Object.defineProperty(fn, 'toString', { value: () => original.toString(), writable: true });
        } catch(e) {}
        return fn;
    };

    // Helper: Value Type Coercion
    const parseValue = (val) => {
        if (val === 'true') return true;
        if (val === 'false') return false;
        if (val === 'null') return null;
        if (val === 'undefined') return undefined;
        if (!isNaN(Number(val)) && val !== '' && val.trim() !== '') return Number(val);
        return val;
    };

    // Helper: Traverse and Modify Object (Deep Recursive)
    const traverseAndModify = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        
        // Prevent infinite recursion on circular objects
        const stack = new Set();
        
        const traverse = (target) => {
            if (!target || typeof target !== 'object') return;
            if (stack.has(target)) return;
            stack.add(target);

            const rules = window.__interceptorConfig.rules || [];
            const requestRules = window.__interceptorConfig.requestRules || [];
            // Merge rules based on context if possible, but here we apply all matching Key rules
            const allRules = [...rules, ...requestRules]; 

            for (const key in target) {
                if (Object.prototype.hasOwnProperty.call(target, key)) {
                    // Apply Rules
                    allRules.forEach(rule => {
                        if (!rule.enabled) return;
                        if (rule.urlPattern && window.location.href.indexOf(rule.urlPattern) === -1) return;

                        // Match key (end of path, e.g., "data.user.id" -> matches key "id")
                        // Logic: Simplistic Key Matching. 
                        // Enhanced: If rule.jsonPath contains dots, we could try exact path match, but that requires root context.
                        // Here we stick to the powerful "Key Match" strategy: if property name matches, replace it.
                        const ruleKey = rule.jsonPath.split('.').pop(); 
                        
                        if (ruleKey === key) {
                            const newVal = parseValue(rule.newValue);
                            
                            // Only log and modify if different (and not object comparison)
                            if (target[key] !== newVal && typeof target[key] !== 'object') {
                                console.log(\`%c[Tamper] ✏️ \${key} -> \${newVal}\`, 'color: cyan; background: #000;');
                                target[key] = newVal;
                            }
                        }
                    });

                    // Recursion
                    if (target[key] && typeof target[key] === 'object') {
                        traverse(target[key]);
                    }
                }
            }
        };
        
        traverse(obj);
        return obj;
    };

    // --- HOOKS ---

    // 1. JSON.parse (Global Response Tamper - XHR/Fetch text response)
    const originalParse = JSON.parse;
    JSON.parse = maskFn(function(text, reviver) {
        const data = originalParse.apply(this, arguments);
        try {
            if (data && typeof data === 'object') {
                traverseAndModify(data);
            }
        } catch (e) {}
        return data;
    }, originalParse);

    // 2. Response.prototype.json (Fetch Response Tamper)
    // Critical for modern React/Vue apps that use fetch().json() directly
    if (window.Response && Response.prototype.json) {
        const originalResponseJson = Response.prototype.json;
        Response.prototype.json = maskFn(async function() {
            const data = await originalResponseJson.apply(this, arguments);
            try {
                if (data && typeof data === 'object') {
                    traverseAndModify(data);
                }
            } catch (e) {}
            return data;
        }, originalResponseJson);
    }

    // 3. XMLHttpRequest (Request Body & Headers)
    const originalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = maskFn(function() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSetRequestHeader = xhr.setRequestHeader;
        const originalSend = xhr.send;
        
        xhr.open = maskFn(function(method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        }, originalOpen);

        // Hook Headers
        xhr.setRequestHeader = maskFn(function(header, value) {
            const headerRules = (window.__interceptorConfig.headerRules || []).filter(r => r.enabled);
            let shouldBlock = false;
            let newValue = value;

            for (const rule of headerRules) {
                const urlMatches = !rule.urlPattern || (this._url && this._url.includes(rule.urlPattern));
                if (urlMatches && rule.headerName.toLowerCase() === header.toLowerCase()) {
                    if (rule.headerValue === '') {
                         console.log(\`%c[Header] 🚫 Blocked: \${header}\`, 'color: red');
                         shouldBlock = true;
                    } else {
                         console.log(\`%c[Header] ✏️ Modified: \${header}\`, 'color: yellow');
                         newValue = rule.headerValue;
                    }
                }
            }
            
            if (!shouldBlock) {
                return originalSetRequestHeader.apply(this, [header, newValue]);
            }
        }, originalSetRequestHeader);

        // Hook Send (Request Body)
        xhr.send = maskFn(function(body) {
            if (body && typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) {
                try {
                    let jsonData = JSON.parse(body);
                    const originalStr = JSON.stringify(jsonData);
                    
                    // Apply modifications
                    traverseAndModify(jsonData); 
                    
                    const newStr = JSON.stringify(jsonData);
                    if (newStr !== originalStr) {
                         console.log('%c[Request] 💉 XHR Payload Injected', 'color: magenta');
                         body = newStr;
                    }
                } catch (e) {}
            }
            return originalSend.apply(this, [body]);
        }, originalSend);

        // Proxy props
        for (const prop in xhr) {
            if (typeof xhr[prop] === 'function') {
                xhr[prop] = xhr[prop].bind(xhr);
            }
        }
        
        return xhr;
    }, originalXHR);
    
    // Copy static props
    Object.assign(window.XMLHttpRequest, originalXHR);

    // 4. fetch (Request Body & Headers)
    const originalFetch = window.fetch;
    window.fetch = maskFn(async function(input, init) {
        let url = input;
        if (input instanceof Request) {
            url = input.url;
        }
        
        // Hook Headers
        if (init && init.headers) {
             const headerRules = (window.__interceptorConfig.headerRules || []).filter(r => r.enabled);
             // Try to handle Headers object or plain object
             let headers; 
             try { headers = new Headers(init.headers); } catch(e) { headers = new Headers(); }
             
             headerRules.forEach(rule => {
                 const urlMatches = !rule.urlPattern || (url && url.toString().includes(rule.urlPattern));
                 if (urlMatches && rule.headerName) {
                     if (rule.headerValue === '') {
                         headers.delete(rule.headerName);
                         console.log(\`%c[FetchHeader] 🚫 \${rule.headerName}\`, 'color: red');
                     } else {
                         headers.set(rule.headerName, rule.headerValue);
                         console.log(\`%c[FetchHeader] ✏️ \${rule.headerName}\`, 'color: yellow');
                     }
                 }
             });
             init.headers = headers;
        }

        // Hook Request Body
        if (init && init.body && typeof init.body === 'string' && (init.body.startsWith('{') || init.body.startsWith('['))) {
            try {
                 let jsonData = JSON.parse(init.body);
                 const originalStr = JSON.stringify(jsonData);
                 
                 traverseAndModify(jsonData);
                 
                 const newStr = JSON.stringify(jsonData);
                 if (newStr !== originalStr) {
                     console.log('%c[Fetch] 💉 Payload Injected', 'color: magenta');
                     init.body = newStr;
                 }
            } catch(e) {}
        }
        return originalFetch.apply(this, arguments);
    }, originalFetch);

    // 5. localStorage (Read Tamper)
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = maskFn(function(key) {
        const rules = window.__interceptorConfig.rules || [];
        for (const rule of rules) {
            if (rule.enabled && rule.jsonPath === key) {
                 // Exact match for storage keys
                 if (!rule.urlPattern || window.location.href.includes(rule.urlPattern)) {
                     const newVal = rule.newValue;
                     console.log(\`%c[Storage] 📖 Read \${key} -> \${newVal}\`, 'color: orange');
                     return newVal;
                 }
            }
        }
        return originalGetItem.apply(this, arguments);
    }, originalGetItem);

})(%CONFIG%);
`;

export const useTamper = () => {
    // 规则状态
    const [interceptRules, setInterceptRules] = useState<TamperRule[]>([]);
    const [requestRules, setRequestRules] = useState<TamperRule[]>([]);
    const [headerRules, setHeaderRules] = useState<HeaderRule[]>([]);

    // 绑定 Webview 引用 (使用 ref 避免 React DevTools 跨域错误)
    const activeWebviewRef = useRef<WebviewElement | null>(null);

    // 加载/保存规则 (持久化到 localStorage，坏缓存/配额异常都不崩)
    useEffect(() => {
        const saved = loadStr('tamper_rules', '', '');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                setInterceptRules(Array.isArray(parsed.intercept) ? parsed.intercept : []);
                setRequestRules(Array.isArray(parsed.request) ? parsed.request : []);
                setHeaderRules(Array.isArray(parsed.headers) ? parsed.headers : []);
            } catch (e) { }
        }
    }, []);

    // 注入规则到页面
    const injectRules = useCallback(() => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;

        const config = {
            rules: interceptRules,
            requestRules: requestRules,
            headerRules: headerRules
        };

        const script = INJECT_SCRIPT.replace('%CONFIG%', JSON.stringify(config));

        try {
            // executeJavaScript returns a Promise, but throws synchronously if webview is not attached/ready.
            // We ignore errors here because the 'dom-ready' listener will ensure it runs eventually.
            const promise = activeWebview.executeJavaScript(script);
            if (promise && typeof promise.catch === 'function') {
                promise.catch(() => { /* Ignore script execution errors (e.g. context destroyed) */ });
            }
        } catch (e: any) {
            // Only log errors unrelated to timing/readiness
            const msg = e.message || '';
            if (!msg.includes('dom-ready') && !msg.includes('attached to the DOM')) {
                console.error("Failed to inject tamper script", e);
            }
        }
    }, [interceptRules, requestRules, headerRules]);

    const saveRules = useCallback((intercept: TamperRule[], request: TamperRule[], headers: HeaderRule[]) => {
        setInterceptRules(intercept);
        setRequestRules(request);
        setHeaderRules(headers);
        saveStr('tamper_rules', JSON.stringify({ intercept, request, headers }), '');

        // 强制重新注入
        const activeWebview = activeWebviewRef.current;
        if (activeWebview) {
            const config = { rules: intercept, requestRules: request, headerRules: headers };
            const script = INJECT_SCRIPT.replace('%CONFIG%', JSON.stringify(config));
            try {
                activeWebview.executeJavaScript(script).catch(() => { });
            } catch (e) {
                // Ignore synchronous errors here too
            }
        }
    }, []);

    // 监听 Webview 导航，重新注入
    useEffect(() => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;

        const onDidFinishLoad = () => {
            injectRules();
        };

        // 尝试在 dom-ready 时注入，确保脚本在业务逻辑之前运行
        const onDomReady = () => {
            injectRules();
        };

        activeWebview.addEventListener('did-finish-load', onDidFinishLoad);
        activeWebview.addEventListener('dom-ready', onDomReady);

        // 初始注入 (针对已加载的页面)
        injectRules();

        return () => {
            activeWebview.removeEventListener('did-finish-load', onDidFinishLoad);
            activeWebview.removeEventListener('dom-ready', onDomReady);
        };
    }, [injectRules]);

    // 注册 Webview (由 BrowsePanel 调用)
    const registerWebview = useCallback((webview: WebviewElement | null) => {
        activeWebviewRef.current = webview;
    }, []);

    // --- 存储管理 API ---

    const getLocalStorage = useCallback(async () => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return "{}";
        try {
            return await activeWebview.executeJavaScript('JSON.stringify(localStorage)');
        } catch (e) {
            console.warn("Unable to access localStorage (WebView might be loading or restricted)");
            return "{}";
        }
    }, []);

    const getSessionStorage = useCallback(async () => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return "{}";
        try {
            return await activeWebview.executeJavaScript('JSON.stringify(sessionStorage)');
        } catch (e) {
            console.warn("Unable to access sessionStorage");
            return "{}";
        }
    }, []);

    const setLocalStorage = useCallback(async (key: string, val: string) => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;
        const safeVal = val.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        try {
            await activeWebview.executeJavaScript(`localStorage.setItem('${key}', '${safeVal}')`);
        } catch (e) { }
    }, []);

    const removeLocalStorage = useCallback(async (key: string) => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;
        try {
            await activeWebview.executeJavaScript(`localStorage.removeItem('${key}')`);
        } catch (e) { }
    }, []);

    const setSessionStorage = useCallback(async (key: string, val: string) => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;
        const safeVal = val.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        try {
            await activeWebview.executeJavaScript(`sessionStorage.setItem('${key}', '${safeVal}')`);
        } catch (e) { }
    }, []);

    const removeSessionStorage = useCallback(async (key: string) => {
        const activeWebview = activeWebviewRef.current;
        if (!activeWebview) return;
        try {
            await activeWebview.executeJavaScript(`sessionStorage.removeItem('${key}')`);
        } catch (e) { }
    }, []);

    const actions = useMemo(() => ({
        saveRules,
        registerWebview,
        getLocalStorage,
        getSessionStorage,
        setLocalStorage,
        removeLocalStorage,
        setSessionStorage,
        removeSessionStorage
    }), [saveRules, registerWebview, getLocalStorage, getSessionStorage, setLocalStorage, removeLocalStorage, setSessionStorage, removeSessionStorage]);

    return useMemo(() => ({
        state: {
            interceptRules,
            requestRules,
            headerRules
        },
        actions
    }), [interceptRules, requestRules, headerRules, actions]);
};
