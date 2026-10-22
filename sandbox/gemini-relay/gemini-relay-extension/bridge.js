// bridge.js —— 内容脚本(隔离世界), 负责与本地转发器通话
//
// 职责分离的原因:
//   page.js 在主世界, 受页面 CSP 管辖, 连不了 127.0.0.1(connect-src 白名单只有 Google 域名);
//   本文件在隔离世界, 不受页面 CSP 约束, 由 host_permissions 授权访问环回, 因此由它收发。
//   两者用 window.postMessage 通信(postMessage 不受 connect-src 管辖)。
//
// 用长轮询而非 EventSource: 长轮询无连接状态, 页面刷新/休眠后自动恢复,
//   也不会被 MV3 Service Worker 生命周期影响。
//
// 视频下载为何要经 service worker(background.js): 内容脚本跨源 fetch 按页面来源处理,
//   仍受 CORS 限制(目标域不回 CORS 头); 只有 worker 凭 host_permissions 能带登录 cookie 取数。
(function () {
    // 端口自适应: relay 默认 8787, 被占则顺延 8788/8789/8790。
    //   旧版把地址写死成 8788, relay 跑在 8787 时扩展就检测不到 —— 这就是端口写死的 bug。
    //   改为按与 relay 相同的候选表探测 /status(应答 JSON 里 agent 为布尔值者即 relay),
    //   命中即缓存; 请求失败清缓存重探, relay 换端口/重启后无需重载扩展。
    var PORT_CANDIDATES = [8787, 8788, 8789, 8790];
    var localBase = null;   // 探测到的 relay 基址, 如 http://127.0.0.1:8787
    var LOG = '[gemini-relay]';
    // 构建号: 每次改动本文件或 page.js 都必须手动 +1。
    // 用途: 它随轮询上报, relay 在 /doctor 里回显, 于是"扩展是否已重载"成为可查事实 ——
    //   此前多次在用户重载前就发测试, 跑的是旧码却把结果当成新码的结论, 结论因此作废。
    var BUILD = 22;
    var polling = false;
    var pendingResult = null;   // {id, thinking, text, served} 等待回传
    var videoWaiters = {};      // id -> resolve, 等待 page.js 回捞视频结果
    var pageBuild = null;       // page.js 上报的版本号, 用于确认它是否也重载了

    // 所有外发消息带 from 标记: 同窗口 postMessage 的 ev.source === window,
    //   不加标记的话本监听器会把自己发出的请求当成回包收下(用请求回显解析掉等待中的 Promise)。
    function post(msg) { msg.from = 'bridge'; window.postMessage(msg, '*'); }

    function getJSON(url, ms) { return fetchJSON(url, null, ms); }

    function fetchJSON(url, body, ms) {
        var opt = { method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store' };
        if (body) { opt.headers = { 'content-type': 'application/json' }; opt.body = JSON.stringify(body); }
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (ctl) opt.signal = ctl.signal;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 40000);
        return fetch(url, opt).then(function (r) {
            clearTimeout(timer);
            if (r.status === 204 || r.status === 205) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            // 依 Content-Type 决定是否解析: relay 的 /result 回的是纯文本 "ok",
            // 一律 JSON.parse 会抛 "ok is not valid JSON"(实测踩过)。
            var ct = r.headers.get('content-type') || '';
            if (ct.indexOf('json') < 0) return r.text();
            return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
        }).catch(function (e) { clearTimeout(timer); throw e; });
    }
    // ── relay 端口探测 ──────────────────────────────────────────────────────
    // 判据: GET /status 回 JSON 且含布尔字段 agent —— relay 的 /status 正是此形状,
    //   用它把 relay 与恰好占着同一端口的别的服务区分开, 避免误连。
    function probePort(port, ms) {
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var opt = { method: 'GET', credentials: 'omit', cache: 'no-store' };
        if (ctl) opt.signal = ctl.signal;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 1000);
        return fetch('http://127.0.0.1:' + port + '/status', opt).then(function (r) {
            clearTimeout(timer);
            if (!r.ok) return null;
            return r.text().then(function (t) {
                try {
                    var j = JSON.parse(t);
                    return (j && typeof j.agent === 'boolean') ? 'http://127.0.0.1:' + port : null;
                } catch (e) { return null; }
            }, function () { return null; });
        }, function () { clearTimeout(timer); return null; });
    }
    function discoverBase() {
        var i = 0;
        return new Promise(function (resolve) {
            (function next() {
                if (i >= PORT_CANDIDATES.length) return resolve(null);
                probePort(PORT_CANDIDATES[i++]).then(function (bb) {
                    if (bb) { localBase = bb; resolve(bb); } else next();
                });
            })();
        });
    }
    function baseOrDiscover() {
        if (localBase) return Promise.resolve(localBase);
        return discoverBase();
    }
    // 带基址的 API 调用: 首次用前先探测; 任何失败都清缓存, 让下一次重新探测。
    function apiJSON(p, body, ms) {
        return baseOrDiscover().then(function (bb) {
            if (!bb) throw new Error('relay 未找到: 8787-8790 的 /status 均无应答(relay 是否已启动?)');
            return fetchJSON(bb + p, body, ms);
        }).catch(function (e) {
            localBase = null;   // 清缓存重探: relay 可能换了端口或刚重启
            throw e;
        });
    }

    // 视频回捞: 向 page.js 要一次只读的 DOM 扫描结果。
    //   超时即返回 available:false, 不能挂着不响应 —— 回捞方会轮询重试。
    function readVideos(ms, convId) {
        return new Promise(function (resolve) {
            var id = 'v' + Date.now() + Math.floor(Math.random() * 1000);
            var timer = setTimeout(function () {
                if (videoWaiters[id]) { delete videoWaiters[id]; resolve({ available: false, note: '页面未在时限内响应' }); }
            }, ms || 8000);
            videoWaiters[id] = function (r) { clearTimeout(timer); resolve(r); };
            post({ __ga: 'videos', id: id, convId: convId || '' });
        });
    }

    // 先探活: worker 没注册时 sendMessage 不会有任何回调, 若直接等下载超时就要白等两分钟。
    //   先 ping(同步立即回)拿到确定结论, 错误信息也能指向真正原因。
    function pingWorker() {
        return new Promise(function (resolve) {
            var done = false;
            function fin(r) { if (!done) { done = true; resolve(r); } }
            var t = setTimeout(function () { fin({ ok: false, err: 'ping 超时: service worker 未注册或未启动' }); }, 3000);
            try {
                chrome.runtime.sendMessage({ type: 'ping' }, function (res) {
                    clearTimeout(t);
                    if (chrome.runtime.lastError) { fin({ ok: false, err: 'ping 失败: ' + chrome.runtime.lastError.message }); return; }
                    fin(res || { ok: false, err: 'ping 无回复' });
                });
            } catch (e) {
                clearTimeout(t);
                fin({ ok: false, err: 'ping 抛错: ' + e.message + '(chrome.runtime 不可用?)' });
            }
        });
    }

    // 请 service worker 代下载: 只有它凭 host_permissions 能带登录 cookie 跨源取数。
    //   失败要响亮报出 —— 静默兜底会把"没下到"伪装成成功。
    function askWorker(url, id, name) {
        return pingWorker().then(function (p) {
            if (!p.ok) return { ok: false, err: p.err, stage: 'ping' };
            return new Promise(function (resolve) {
                var done = false;
                function fin(r) { if (!done) { done = true; resolve(r); } }
                // worker 现在收到消息就立即回执, 所以这里只等回执本身;
                //   真正的下载进度由 worker 直接上报给 relay, 成败也由 relay 判定并回应 /download。
                var timer = setTimeout(function () { fin({ ok: false, err: 'sendMessage 无回执(10s)', stage: 'send' }); }, 10000);
                try {
                    chrome.runtime.sendMessage({ type: 'dl', url: url, id: id, name: name || 'video.mp4', relay: localBase || '' }, function (res) {
                        clearTimeout(timer);
                        if (chrome.runtime.lastError) { fin({ ok: false, err: 'sendMessage: ' + chrome.runtime.lastError.message, stage: 'send' }); return; }
                        fin(res || { ok: false, err: 'worker 无回执', stage: 'send' });
                    });
                } catch (e) {
                    clearTimeout(timer);
                    fin({ ok: false, err: 'sendMessage 抛错: ' + e.message, stage: 'send' });
                }
            });
        });
    }

    // 结果回传: 失败(如转发器未开)则暂存, 下次轮询时重试
    function flushResult() {
        if (!pendingResult) return Promise.resolve();
        var payload = pendingResult;
        return apiJSON('/result', payload, 15000).then(function () {
            if (pendingResult === payload) pendingResult = null;
        });
    }

    function pollLoop() {
        if (polling) return;
        polling = true;
        (function next() {
            flushResult()
                .catch(function () { })
                .then(function () { return apiJSON('/agent/poll?build=' + BUILD + '&pb=' + (pageBuild || ''), null, 40000); })
                .then(function (task) {
                    if (task && task.id) {
                        if (task.download) {
                            // 下载: 先问 page.js 要当前会话的视频直链, 再交给 service worker 带登录态取。
                            //   为什么不在本文件直接 fetch: MV3 起内容脚本跨源 fetch 按页面来源处理,
                            //   仍受 CORS 限制(该域不回 CORS 头), 只有 service worker 能取。
                            console.log(LOG, '下载视频', task.id, task.conv || '(当前会话)');
                            readVideos(20000, task.conv).then(function (r) {
                                var rep = (r && r.report) || {};
                                var vids = rep.videos || [];
                                var pick = null;
                                for (var i = 0; i < vids.length; i++) {
                                    if (vids[i].fetchable) { pick = vids[i]; break; }
                                }
                                if (!pick) {
                                    pendingResult = { id: task.id, text: JSON.stringify({ ok: false, err: '未找到可下载的视频', report: rep }), videos: true };
                                    return flushResult().catch(function () { });
                                }
                                return askWorker(pick.url, task.id, task.name).then(function (res) {
                                    // 只在"派发失败"时回报并结束; 派发成功后真正的成败由 worker
                                    //   经 /dlstage + /upload 直接告诉 relay, 并由 relay 回应 /download。
                                    //   两边都回报会造成重复响应(relay 的 done 标志能挡, 但语义混乱)。
                                    if (res && res.ok) {
                                        console.log(LOG, '下载已派发', task.id, '=> 进度由 worker 上报 relay');
                                        return;
                                    }
                                    pendingResult = { id: task.id, text: JSON.stringify({ ok: false, worker: res, url: pick.url, report: { conv: rep.conv, generating: rep.generating } }), videos: true };
                                    return flushResult().catch(function () { });
                                });
                            }).catch(function (e) {
                                pendingResult = { id: task.id, text: JSON.stringify({ ok: false, err: '派发失败: ' + e.message }), videos: true };
                                flushResult().catch(function () { });
                            });
                        } else if (task.videos) {
                            // 视频回捞是独立通道: 不进 runTask, 不触发生成, 结果走 /result 复用同一回传路径
                            console.log(LOG, '回捞视频', task.id, task.conv || '(当前会话)');
                            readVideos(20000, task.conv).then(function (r) {
                                pendingResult = { id: task.id, text: JSON.stringify(r), videos: true };
                                flushResult().catch(function () { });
                            });
                        } else if (task.probe) {
                            console.log(LOG, '派发探针', task.id);
                            post({ __ga: 'probe', id: task.id, prompt: task.prompt || '' });
                        } else {
                            console.log(LOG, '派发任务', task.id, task.model, task.level, task.tool);
                            post({ __ga: 'task', task: task });
                        }
                    }
                    next();
                })
                .catch(function (e) {
                    // 转发器未启动时静默退避重试, 不刷屏
                    setTimeout(next, 3000);
                });
        })();
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || typeof d !== 'object') return;

        // 必须丢弃自己发出的消息: 本文件用 window.postMessage 发请求, 而同窗口 postMessage 的
        //   ev.source === window, 因此本监听器会把请求本身当成回包收下 —— 匹配到等待中的 id,
        //   用"请求回显"(没有 report 字段)解析掉 Promise。
        //   这曾被我误判成"旧版 page.js 抢答", 其实是自己收自己的包。用方向标记根治。
        if (d.from === 'bridge') return;

        if (d.__ga === 'page-ready') {
            console.log(LOG, '页面代理就绪, 开始轮询 127.0.0.1:8787-8790 (bridge build ' + BUILD + ', page build ' + (d.pb || '?') + ')');
            pageBuild = d.pb || null;
            pollLoop();
            return;
        }
        if (d.__ga === 'videos' && d.id) {
            var w = videoWaiters[d.id];
            if (w) {
                delete videoWaiters[d.id];
                if (!d.report) {
                    w({ available: true, report: { error: 'page.js 未回传 report', keys: Object.keys(d).join(','), pb: d.pb || null } });
                } else {
                    w({ available: true, report: d.report, pb: d.pb || null });
                }
            }
            return;
        }
        if (d.__ga === 'result' && d.id) {
            pendingResult = { id: d.id, thinking: d.thinking, text: d.text, served: d.served, rpc: d.rpc, conv: d.conv, sctx: d.sctx };
            flushResult().then(function () {
                console.log(LOG, '已回传', d.id, 'served=' + d.served, '| rpc: ' + (d.rpc || 'n/a'));
            }).catch(function (e) {
                console.warn(LOG, '回传失败, 已暂存待重试:', e.message);
            });
        }
    });

    // 内容脚本可能晚于 page.js 执行(它是异步注入的), 若错过 page-ready 就主动问一次
    setTimeout(function () { post({ __ga: 'bridge-ready' }); }, 0);
    pollLoop();
    console.log(LOG, 'bridge 已加载, 目标 127.0.0.1:8787-8790 自适应 (build ' + BUILD + ')');
})();
