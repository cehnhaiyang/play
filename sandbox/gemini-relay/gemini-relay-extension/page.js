// page.js —— 注入 gemini.google.com 的「主世界」(MAIN world)
//
// 为什么必须在主世界: XHR 钩子要挂到页面自己的 XMLHttpRequest 上, 隔离世界挂不到。
// 为什么不能在这里连 127.0.0.1: 主世界受页面 CSP 管辖, connect-src 只允许 Google 域名,
//   连本地端口会被浏览器直接拒绝(实测报 "violates the following Content Security Policy directive")。
// 所以本文件只做 DOM 与抓包, 结果经 window.postMessage 交给 bridge.js(隔离世界)转发。
//
// 相对原控制台脚本的改动: 任务来源由 EventSource 改为 postMessage; 逻辑本身未变。
(function () {
    // page.js 的独立版本号: bridge 的 BUILD 只证明 bridge 重载了, 证明不了本文件也重载了
    //   —— 两者是分开注入的 content script, 实测出现过 bridge 已是新码而 page.js 仍是旧码。
    //   每个回传都带上它, 于是"跑的是哪版 page.js"成为可查事实。
    var PB = 30;
    // 守卫改为"版本比较"而非"存在即退出"。
    //   旧写法 `if (window.__GA_PAGE) return;` 的代价是: 重载扩展后旧实例仍在页面里占着标记,
    //   新实例一进来就被挡掉, 于是新代码永远跑不起来(实测: 消息收到了却回不出 report)。
    //   XHR 钩子只能挂一次(否则重复记录), 故用 ___HOOKED 单独守; 消息监听则允许新版接管。
    if (window.__GA_PAGE && window.__GA_PAGE >= PB) return;
    window.__GA_PAGE = PB;
    var NL = String.fromCharCode(10);
    var W = window.WIZ_global_data;

    // XHR 钩子: 记录数据面请求(batchexecute/StreamGenerate)的请求体与响应体
    // 同时顺带抓取页面自己发出的 at(CSRF) —— 服务端渲染的 HTML 里没有 SNlM0e,
    // 但页面运行期的每个 batchexecute/StreamGenerate 请求体里都带着它。
    var AT = '';
    function captureAt(body) {
        if (AT || !body) return;
        var m = /(?:^|&)at=([^&]+)/.exec(body);
        if (m) { try { AT = decodeURIComponent(m[1]); } catch (e) { AT = m[1]; } }
    }
    // ── 跨 realm 装钩 ────────────────────────────────────────────────────────
    // 为什么不能只挂顶层: 实测(文档 137-139)顶层 __GAF 里 batchexecute=28 而 StreamGenerate=0,
    //   而同源 iframe /_/bscframe 的 XMLHttpRequest.prototype 与顶层不是同一个对象(sameProto=false)
    //   —— 生成请求跑在独立 JS realm 里, 顶层挂的钩子按 JS 语义碰不到它。后果是完成判据永不成立:
    //   页面照常出内容, 我们干等 120s 报 TIMEOUT。这是纯采集中断, 不是风控。
    // 为什么不用 manifest 的 all_frames: 那会让本文件在每个 realm 各跑一份, 版本守卫与代次(GEN)
    //   逻辑互相打架; 而 iframe 同源, 顶层脚本可直接改写子 realm 的 prototype, 更稳。
    // 为什么要持续补装: iframe 是异步挂进来的(document_idle 时可能还不存在), 装一次必然漏。
    function readBlobFallback(x) {
        // 跨 realm 读 responseText 可能抛 InvalidStateError, 退回 response / arraybuffer
        try { if (x.responseType === '' || x.responseType === 'text') return String(x.response || ''); } catch (e) { }
        try { if (x.responseType === 'arraybuffer') return new TextDecoder('utf-8').decode(x.response); } catch (e) { }
        return '';
    }
    // 原始函数只存一份, 归 realm 自己所有。
    // 为什么必须存: 版本升级时若把新包装直接套在"上一版的包装"外面, 每升一版就多包一层,
    //   同一个请求被记录多次 —— 这正是"补丁越打越多、失败面越来越大"的形态。
    //   存下原函数后, 每次(重)装都从同一份原始函数派生, 层数恒为 1。
    // 为什么还认 legacy: 在没有 __GAF_ORIG 的那一版之后首次升级时, 它留在 prototype 上的包装
    //   无法还原成原生函数, 只能被当作底层调用 —— 这一次升级会多出一层。不掩盖这个事实, 只记录它;
    //   正确性不依赖它: 记录按 pb 归属, 旧层写的记录不被采信(见 isOurs)。
    //   从有 __GAF_ORIG 的版本起, 层数恒为 1, legacy 不会再出现。
    function looksOurs(fn) { return typeof fn === 'function' && String(fn).indexOf('__GAF') >= 0; }
    function originals(win) {
        if (!win.__GAF_ORIG) {
            var cur = {
                open: win.XMLHttpRequest.prototype.open,
                send: win.XMLHttpRequest.prototype.send,
                fetch: win.fetch,
            };
            cur.legacy = looksOurs(cur.open) || looksOurs(cur.send) || looksOurs(cur.fetch);
            win.__GAF_ORIG = cur;
        }
        return win.__GAF_ORIG;
    }
    // 记录归属: 只有本版写的记录才算数。
    // 为什么必须有: 重载扩展后新旧两版会同时活在页面里, 且都往同一个 __GAF 写。
    //   消费者若默认"数组里的都是我的", 就会把上一版的记录当成本次结果 —— 那是用无效判据下结论。
    function isOurs(x) { return !!x && x.pb === PB; }
    function installHooks(win, rid) {
        try {
            // 判据是"装钩的版本", 不是"装过没有": 旧实例装的钩子缺 __ts(跨 realm 后按时间戳
            //   取新记录的必需字段), 只比存在与否会让新码永远接不上手 —— 钩子在、却一条也取不到。
            //   版本号记在队列自己身上(一个事实一个归属), 不再另设 __GAF_HOOKED 双份状态。
            if (win.__GAF && win.__GAF.__pb >= PB) { win.__GA_RID = rid; return 'skip'; }
            if (!win.__GAF) win.__GAF = [];
            win.__GAF.__pb = PB;
            win.__GAF.push = Array.prototype.push;      // 钉住原始 push, 防被页面改写
            var O = originals(win);
            win.XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return O.open.apply(this, arguments); };
            win.XMLHttpRequest.prototype.send = function (b) {
                var self = this;
                var rec = { pb: PB, rid: rid, u: String(this.__u || ''), req: b ? String(b) : '', rb: '', done: false, __ts: Date.now() };
                captureAt(rec.req);
                win.__GAF.push(rec);
                this.addEventListener('load', function () { try { rec.rb = String(self.responseText || ''); } catch (e) { rec.rb = readBlobFallback(self); } rec.done = true; });
                this.addEventListener('error', function () { rec.done = true; rec.rb = ''; rec.netErr = 1; });
                return O.send.apply(this, arguments);
            };
            // fetch 分支必须采响应, 且不能按 batchexecute 过滤 —— StreamGenerate 的 URL 不含它,
            //   旧写法既不入队、也从不回填 rb/done, 于是钩子看着在、其实什么都采不到。
            win.fetch = function (input, init) {
                var u = String((input && input.url) || input || '');
                var b = init && init.body ? String(init.body) : '';
                captureAt(b);
                var p = O.fetch.apply(this, arguments);
                try {
                    if (u.indexOf('/_/') >= 0) {            // 只采自家数据面, 不吞 gstatic/图片
                        var rec = { pb: PB, rid: rid, u: u, req: b, rb: '', done: false, viaFetch: true, __ts: Date.now() };
                        win.__GAF.push(rec);
                        p.then(function (r) {
                            try {
                                r.clone().text().then(
                                    function (t) { rec.rb = String(t || ''); rec.done = true; },
                                    function () { rec.done = true; });
                            } catch (e) { rec.done = true; }
                        }, function () { rec.done = true; rec.netErr = 1; });
                    }
                } catch (e) { }
                return p;
            };
            return 'ok';
        } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 50); }
    }
    function installAll(tag) {
        var res = [tag + ':top=' + installHooks(window, 'top')];
        for (var k = 0; k < window.frames.length; k++) {
            try {
                var w = window.frames[k];
                var href = String(w.location.href).replace('https://gemini.google.com', '').slice(0, 20);
                res.push(tag + ':f' + k + '=' + installHooks(w, 'f' + k + ':' + href));
            } catch (e) { res.push(tag + ':f' + k + '=CROSS'); }
        }
        return res.join(' ');
    }
    // 持续补装: iframe 是异步挂进来的(document_idle 时可能还不存在), 装一次必然漏。
    // 定时器也要按"当前代"唯一 —— 重载扩展会让本文件在新实例里再跑一次, 不清理就每代多一个
    //   定时器永久打转(每个都在做同样的守卫检查, 纯浪费)。
    installAll('i0');
    if (window.__GA_HOOKTIMER) clearInterval(window.__GA_HOOKTIMER);
    window.__GA_HOOKTIMER = setInterval(function () { installAll('tick'); }, 1500);
    // 只读的装钩覆盖报告。为什么要有它: "哪个 realm 装上了钩子"必须成为服务端可查的事实,
    //   否则每次采不到包都得让人去控制台跑自查脚本 —— 排障成本高且依赖人。
    //   MISSING/CROSS 直接指向"下次改版又换 realm 了", 不必再从"超时"倒推。
    // 格式 <realm>=hooked(本版记录数/队列总数,sg=StreamGenerate条数[,legacy]):
    //   记录数两者不等 → 该 realm 里压着旧版写的记录, 或旧包装还在写(legacy)。
    //   sg 是文档 §三 自查脚本的判据 —— 它直接回答"生成请求到底落在哪个 realm",
    //   没有它就只能看到"总数 56 但没采到 StreamGenerate", 判断不了请求去了哪。
    function hookReport() {
        function one(w) {
            var total = -1, mine = -1, sg = -1, legacy = false;
            try {
                var q = w.__GAF || null;
                if (q) {
                    total = q.length; mine = 0; sg = 0;
                    for (var i = 0; i < q.length; i++) {
                        if (!isOurs(q[i])) continue;
                        mine++;
                        if (String(q[i].u || '').indexOf('StreamGenerate') >= 0) sg++;
                    }
                    legacy = !!(w.__GAF_ORIG && w.__GAF_ORIG.legacy);
                }
            } catch (e) { }
            var hooked = total >= 0 && w.__GAF.__pb >= PB;
            return (hooked ? 'hooked' : 'MISSING') + '(' + mine + '/' + total + ',sg=' + sg + (legacy ? ',legacy' : '') + ')';
        }
        var res = ['top=' + one(window)];
        for (var k = 0; k < window.frames.length; k++) {
            try {
                var w = window.frames[k];
                var href = String(w.location.href).replace('https://gemini.google.com', '').slice(0, 18);
                res.push('f' + k + href + '=' + one(w));
            } catch (e) { res.push('f' + k + '=CROSS'); }
        }
        return res.join(' ');
    }

    // at 三源兜底, 返回空串表示都没拿到
    function getAt() {
        if (AT) return AT;
        try { if (W.SNlM0e) { AT = String(W.SNlM0e); return AT; } } catch (e) { }
        try {
            var m = /"SNlM0e"\s*:\s*"([^"]+)"/.exec(document.documentElement.innerHTML);
            if (m) { AT = m[1]; return AT; }
        } catch (e) { }
        // 从已记录的任一请求体里捞(任何 realm 的报文都带 at)
        var all = allGaf();
        for (var i = all.length - 1; i >= 0; i--) { captureAt(all[i].req); if (AT) return AT; }
        return '';
    }

    // 汇总所有 realm 的抓包队列 —— 只收本版写的记录。
    //   为什么要跨 realm: 生成请求在子 realm 里(见 installHooks 注释), 只看顶层必然为空。
    //   为什么按 pb 过滤: 重载扩展后上一版的包装仍在跑, 它写的记录混在同一数组里;
    //     收进来会让"本次有没有发出请求"这个判断被旧数据污染(见 isOurs)。
    function allGaf() {
        var out = [];
        function take(w) {
            var q = null;
            try { q = w.__GAF || null; } catch (e) { return; }
            if (!q) return;
            for (var i = 0; i < q.length; i++) if (isOurs(q[i])) out.push(q[i]);
        }
        take(window);
        for (var k = 0; k < window.frames.length; k++) {
            try { take(window.frames[k]); } catch (e) { }
        }
        return out;
    }
    // 按「时间戳基线」取本次新产生的数据面请求。
    //   为什么不用下标基线: 多 realm 的数组下标不再是全局单调序(每个 realm 各有一份队列),
    //   下标法会漏掉或错取。故每条记录带 __ts, 基线用 Date.now()。
    //   用它替代在正文里插 @@GEM 标记: 标记会真实进入用户的会话历史(可见且不可去除)。
    // 判据变更(本次修复核心): 旧版写死 u.indexOf('StreamGenerate')>=0, 但实测新版生成请求
    //   已改走 /_/BardChatUi/data/batchexecute + 不透明 rpcid(ESY5D/CNgdBe/whPPme 等),
    //   URL 里没有 StreamGenerate 字面量 —— 钩子明明采到了正文, 判据却恒为假, 对外表现
    //   就是「LLM 吐了字、插件永远超时」。现在改为认「数据面端点」而非某个固定路径。
    // 返回值三态, 必须分开:
    //   rec   = 找到且已回完
    //   null  = 通道找到了(请求已发出)但还没回 -> 继续等
    //   false = 压根没找到通道 -> 钩子又瞎了, 立刻报 NO_CHANNEL, 不要干等到超时
    function isDataRec(x) {
        var u = String((x && x.u) || '');
        return u.indexOf('StreamGenerate') >= 0 || u.indexOf('/_/BardChatUi/data/') >= 0;
    }
    function sgDoneSince(ts) {
        var a = allGaf(), hit = null;
        for (var i = 0; i < a.length; i++) {
            var x = a[i];
            if (!isDataRec(x)) continue;
            if ((x.__ts || 0) < ts) continue;
            if (x.done && x.rb && x.rb.length > 80) return x;
            hit = hit || x;
        }
        return hit ? null : false;
    }
    function leaves(v, acc) {
        if (typeof v === 'string') { if (v.length) acc.push(v); return; }
        if (Array.isArray(v)) for (var i = 0; i < v.length; i++) leaves(v[i], acc);
    }
    function parseBlocks(raw) {
        var L = raw.split(NL), out = [];
        for (var i = 0; i < L.length; i++) {
            var t = L[i].trim(); var n = Number(t);
            if (t !== '' && Number.isInteger(n) && n >= 0) {
                var nx = L[i + 1];
                if (nx && nx[0] === '[') { try { out.push(JSON.parse(nx)); i++; } catch (e) { } }
            }
        }
        return out;
    }
    // 实测: 正文=payload[26] 按叶子顺序拼接; 思考=payload[4]; payload[42]=实际生效模型名
    // 同时取 payload[1]=会话id(用于判定 New chat 是否真的换了会话), 以及 36..46 的字符串位,
    // 用于核对 [42] 到底是不是"实际服务的模型"——文档对该位的语义只有推断, 没有对照实验。
    function scan(raw) {
        var served = null, tx = [], th = [], conv = null, sctx = [];
        parseBlocks(raw).forEach(function (arr) {
            arr.forEach(function (f) {
                if (f[0] !== 'wrb.fr') return;
                var p; try { p = JSON.parse(f[2]); } catch (e) { return; }
                if (!Array.isArray(p)) return;
                if (typeof p[42] === 'string') served = p[42];
                if (!conv && p[1] != null) { var c = []; leaves(p[1], c); if (c.length) conv = c[0]; }
                if (p[26] != null) { var a = []; leaves(p[26], a); if (a.length >= tx.length) tx = a; }
                if (p[4] != null) { var b = []; leaves(p[4], b); if (b.length >= th.length) th = b; }
                if (!sctx.length) for (var k = 36; k <= 46; k++) if (typeof p[k] === 'string') sctx.push(k + '=' + p[k].slice(0, 20));
            });
        });
        return { text: tx.join(NL), thinking: th.join(NL + NL), served: served, conv: conv, sctx: sctx.join(',') };
    }

    var MODE = { '3.5 Flash-Lite': '8c46e95b1a07cecc', '3.8 Flash': '56fdd199312815e2', '3.1 Pro': 'e6fa609c3fa255c0', '4 Argon': '95a4c0abcba24364' };
    var LVL = { Low: 1, Medium: 4, High: 2 };
    var TOOL = { none: null, Canvas: 2, 'Create image': 14, 'Create video': 11, 'Create music': 21 };
    var IDX = '/u/0';

    // L5adhe 必须带 at: 实测缺 at 直接 HTTP 400, at 过期则回 [7] —— 两者是不同的失败码。
    // at 只能从页面运行期取得(SSR HTML 里没有), 由 getAt() 三源兜底。
    function rpc(a0) {
        var at = getAt();
        if (!at) return Promise.reject(new Error('未能取得 at(CSRF): 请先在页面上随便发一条消息, 让页面产生一次请求'));
        var u = 'https://gemini.google.com' + IDX + '/_/BardChatUi/data/batchexecute?rpcids=L5adhe&source-path=%2Fu%2F0%2Fapp&bl=' + W.cfb2h + '&f.sid=' + W.FdrFJe + '&hl=en&_reqid=' + Math.floor(Math.random() * 1e6) + '&rt=c';
        var body = 'f.req=' + encodeURIComponent(JSON.stringify([[['L5adhe', JSON.stringify([a0, null, [a0.length]]), null, 'generic']]])) + '&at=' + encodeURIComponent(at) + '&';
        // 标记"我方发出"的报文: 我方 rpc() 也走 fetch, 因此同样会被钩子记录。
        // 不标记的话, l5Traffic 会把我们自己的注入误报成"页面自己发起的写态" —— 那正是
        //   "用无效判据下结论"的老毛病(会把注入成功误读成页面生效)。
        // 用时间戳而不是队列下标: 记录分散在多个 realm 的队列里, 下标无法跨队列比较。
        var before = Date.now();
        return fetch(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' }, body: body, credentials: 'include' }).then(function (r) {
            allGaf().forEach(function (x) { if ((x.__ts || 0) >= before) x.__ours = true; });
            return r.text().then(function (t) { return { status: r.status, text: t }; });
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // 一次 RPC 只写一个字段: a0 的长度本身就是报文类型标识, 不是"数组开多大都行"。
    //   实测真机切模型发出的报文 = a0len=100 / a2=[100] / 只 set{99}。
    //   把 a0[99] 塞进 a0len=265 的报文里, 服务端按"等级报文"解析, 那里没有 99 号字段,
    //   于是模型写入被静默丢弃、兜底到 3.5 Flash-Lite —— 这正是长期控不住模型的根因。
    // 三种字段的权威形态(文档实测): 模型 100/[99]、等级 265/[264]、工具 45/[44]。
    function rpcOne(tag, len, idx, val) {
        var a0 = new Array(len).fill(null);
        a0[idx] = val;
        return rpc(a0).then(
            function (r) { r.tag = tag + len + '.' + idx; return r; },
            function (e) { return { tag: tag + len + '.' + idx, status: 'ERR', text: String((e && e.message) || e) }; }
        );
    }
    function setModelAndSession(model, level, tool) {
        var out = [];
        var chain = Promise.resolve();
        function add(tag, len, idx, val) {
            chain = chain.then(function () {
                return rpcOne(tag, len, idx, val).then(function (r) { out.push(r); });
            });
        }
        add('model', 100, 99, MODE[model] || model);                 // 模型: 账号级
        add('level', 265, 264, LVL[level] == null ? 1 : LVL[level]); // 等级: 会话级
        add('tool', 45, 44, TOOL[tool] == null ? null : TOOL[tool]); // 工具: 会话级, 标量单选
        return chain.then(function () { return out; });
    }
    // ── UI 预言机 ───────────────────────────────────────────────────────────
    // 文档记录 85/86 的硬结论: wrb.fr 的 "[1]" 只代表 RPC 被处理, 不代表字段落库
    //   (越界长度 a0len=44、空掩码 a2=[] 都能返回 OK)。
    // 唯一被 reload 对照实验证明有效的判据是 UI 渲染态 —— 模型 pill 的 aria-label
    //   与工具 chip 的 aria-checked。UI 由同一状态源渲染, 读它即等于读服务端会话态。
    function uiPill() {
        var bs = document.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
            var al = bs[i].getAttribute('aria-label') || '';
            if (al.indexOf('Open mode picker') >= 0) return al.replace('Open mode picker, currently ', '').trim();
        }
        return '-';
    }
    // ── served/conv 兜底来源(方案B: 绕开易变的私有响应字段) ────────────────
    // 为什么不再只靠 scan(): 新版生成响应走 batchexecute + 不透明 rpcid, 旧版固定字段位
    //   (p[42]=模型 / p[1]=会话id)已对不上, 实测这两个字段恒为 null。
    //   改从两个「给人看、改版也在」的来源取:
    //     conv   <- 页面 URL 的会话段(/u/0/app/<convId>), 浏览器地址栏就是它
    //     served <- 模型 pill 的 aria-label(由同一状态源渲染, 即当前实际选择)
    //   仅在 scan() 没给到时兜底, 不覆盖已有值。
    function convFromUrl() {
        try {
            var parts = (location.pathname || '').split('/');
            for (var i = 0; i < parts.length; i++) {
                if (parts[i] === 'app' && parts[i + 1]) return parts[i + 1];
            }
            return null;
        } catch (e) { return null; }
    }
    // 侧栏最新会话 id 兜底: 新建会话刚发出时地址栏可能还没带上会话段(草稿态),
    //   此时从会话列表里取最新一条的 href 会话 id —— 否则 conv 会采成 null,
    //   让调用方无法确认「本轮是不是新会话」。
    function convFromSidebar() {
        try {
            var as = document.querySelectorAll('gem-nav-list-item[data-test-id="conversation"] a[href], conversations-list a[href]');
            for (var i = 0; i < as.length; i++) {
                var h = as[i].getAttribute('href') || '';
                var m = /\/app\/([0-9a-zA-Z_-]{6,})/.exec(h);
                if (m) return m[1];
            }
        } catch (e) { }
        return null;
    }
    // 把 pill 文案反查回 MODE 的内部名(如 Gemini Pro -> 3.1 Pro)。
    //   按「最后一段词」匹配: Pro / Argon / Flash / Flash-Lite 彼此可区分;
    //   匹配不到就原样返回 pill 文案 —— 宁可给出可读实况, 也不编一个假模型名。
    function servedFromUI() {
        var p = uiPill();
        if (!p || p === '-') return null;
        var pl = p.toLowerCase();
        for (var k in MODE) {
            var tail = k.split(' ').pop().toLowerCase();
            if (tail && pl.indexOf(tail) >= 0) return k;
        }
        return p;
    }
    function fillServedConv(sc) {
        if (!sc || typeof sc !== 'object') return sc;
        try { if (!sc.conv) sc.conv = convFromUrl() || convFromSidebar(); } catch (e) { }
        try { if (!sc.served) sc.served = servedFromUI(); } catch (e) { }
        return sc;
    }
    // 工具 chip 只在抽屉展开时存在/可见; 未展开读不到, 故区分 CLOSED 并支持主动展开。
    //   真机结构(文档 2316): toolbox-drawer-item 内 <button role=menuitemcheckbox aria-checked>。
    function toolDrawerButton() {
        var bs = document.querySelectorAll('button,[aria-label]');
        for (var i = 0; i < bs.length; i++) {
            if ((bs[i].getAttribute('aria-label') || '').indexOf('Upload & tools') >= 0) return bs[i];
        }
        return null;
    }
    function uiChips() {
        var cs = document.querySelectorAll('toolbox-drawer-item');
        if (!cs.length) return 'CLOSED';
        var out = [];
        for (var i = 0; i < cs.length; i++) {
            var b = cs[i].querySelector('[role=menuitemcheckbox]') || cs[i];
            var t = (cs[i].textContent || '').trim().slice(0, 12);
            if (b.getAttribute('aria-checked') === 'true') out.push(t);
        }
        return out.length ? out.join('+') : 'none-checked';
    }
    // 展开工具抽屉后再读 —— 否则永远是 CLOSED, 等于没有判据
    function uiChipsExpanded() {
        var b = toolDrawerButton();
        if (!b) return Promise.resolve('NO_DRAWER_BTN(' + uiChips() + ')');
        var wasOpen = b.getAttribute('aria-expanded') === 'true';
        if (!wasOpen) {
            try { b.click(); } catch (e) { }
            return waitFor(function () { return document.querySelectorAll('toolbox-drawer-item').length ? true : null; }, 2500)
                .then(function () { return uiChips(); });
        }
        return Promise.resolve(uiChips());
    }

    // 解出页面自己发出的 L5adhe 请求体形状 —— 这是权威, 用来对照我们自己拼的那条。
    // 关键看 a2: 我方一直是 [a0.length], 而真实抓包里 a2 的条目数可能严格等于"被写入字段数"。
    function decodeL5(body) {
        try {
            var o = JSON.parse(new URLSearchParams(body).get('f.req'));
            var inner = JSON.parse(o[0][0][1]);
            var a0 = inner[0], a2 = inner[2], set = [];
            for (var i = 0; i < a0.length; i++) {
                if (a0[i] !== null && a0[i] !== undefined) set.push(i + '=' + JSON.stringify(a0[i]));
            }
            return 'a0len=' + a0.length + ' a2=' + JSON.stringify(a2) + ' set{' + set.join(',') + '}';
        } catch (e) { return 'DECODE_ERR:' + String(e).slice(0, 50); }
    }
    // ── DOM 主判据族(方案2) ────────────────────────────────────────────────
    // 为什么把 DOM 提为主判据: 实测新版生成请求的 URL 里没有 StreamGenerate
    //   (改走 /_/BardChatUi/data/batchexecute + 不透明 rpcid), 包络判据已失效;
    //   而 DOM 是给人看的, 改版也一定在 —— 页面渲染出回答就能读到。
    function replyEls() {
        return document.querySelectorAll('.model-response, model-response, [data-test-id*=model-response i], conversation-turn .response-container');
    }
    // 取一条回答的正文。为什么不能直接用 el.innerText:
    //   实测 model-response 内含屏幕阅读器标签 <h6 class=cdk-visually-hidden>「Gemini said」,
    //   它用 clip 隐藏而非 display:none, innerText 仍会带上, 正文于是变成「Gemini said + 正文」。
    //   真正正文在 model-response-content / structured-content-container / message-content / .markdown。
    function replyText(el) {
        if (!el) return '';
        var sels = ['model-response-content', 'structured-content-container', 'message-content', '.markdown'];
        for (var i = 0; i < sels.length; i++) {
            var c = el.querySelector(sels[i]);
            if (c) { var t = String(c.innerText || '').trim(); if (t) return t; }
        }
        var t2 = String(el.innerText || '').trim();
        return t2.replace(/^(Gemini said|You said)\s*/i, '').trim();
    }
    function domSnapshot() {
        var rs = replyEls();
        if (!rs.length) return { n: 0, last: '', el: null };
        var last = rs[rs.length - 1];
        return { n: rs.length, last: replyText(last), el: last };
    }
    // 生成中判据: 停止按钮可见即认为还在生成(选择器失配时退化为纯文本稳定性判据)
    function generatingNow() {
        try {
            var sels = ['button[aria-label*="Stop" i]', 'gem-icon-button[aria-label*="Stop" i]', '[data-test-id*="stop" i]'];
            for (var i = 0; i < sels.length; i++) {
                var es = document.querySelectorAll(sels[i]);
                for (var j = 0; j < es.length; j++) {
                    var b = es[j].getBoundingClientRect();
                    if (b.width > 0 && b.height > 0) return true;
                }
            }
        } catch (e) { }
        return false;
    }
    // DOM 兜底: 取最后一个回答的正文、最长的思考块。
    //   注意它读的是「整个页面最后一个回答」, 多轮会话里须配合基线判断(见 turnCheck)。
    function domFallback() {
        var rs = replyEls();
        if (!rs.length) return null;
        var text = replyText(rs[rs.length - 1]);
        if (!text) return null;
        var th = document.querySelectorAll('[class*=thinking i], [class*=reason i], .thought-chain, details');
        var best = '';
        for (var i = 0; i < th.length; i++) { var t = String(th[i].innerText || '').trim(); if (t.length > best.length) best = t; }
        return { text: text, thinking: best };
    }
    // 包络采到但正文为空时用 DOM 补(保留旧入口, 供其他路径复用)
    function withDomFallback(sc) {
        if (sc.text && sc.text.length >= 8) return Promise.resolve(sc);
        return sleep(1200).then(function () {
            var d = null;
            try { d = domFallback(); } catch (e) { }
            if (!d) return sc;
            sc.text = d.text;
            sc.via = 'dom';
            if (!sc.thinking) sc.thinking = d.thinking;
            return sc;
        });
    }
    // 合并基线后所有数据面记录: 取最长正文/思考, 补齐 served/conv/sctx。
    //   为什么要合并而不是只认一条: 新版正文、思考、结构字段可能落在不同 rpcid 的响应里。
    function bestPacketSince(ts) {
        var a = allGaf(), text = '', thinking = '', served = null, conv = null, sctx = '';
        for (var i = 0; i < a.length; i++) {
            var x = a[i];
            if (!isDataRec(x) || !x.done || !x.rb) continue;
            if ((x.__ts || 0) < ts) continue;
            var sc = scan(x.rb);
            if (sc.text.length > text.length) text = sc.text;
            if (sc.thinking.length > thinking.length) thinking = sc.thinking;
            if (!served && sc.served) served = sc.served;
            if (!conv && sc.conv) conv = sc.conv;
            if (!sctx && sc.sctx) sctx = sc.sctx;
        }
        if (!text && !thinking && !served && !conv) return null;
        return { text: text, thinking: thinking, served: served, conv: conv, sctx: sctx };
    }
    // 本轮是否完成: DOM 主判据 + 包络补充。st 为跨轮询的会话态对象。
    //   返回 null=继续等; 否则返回结果对象。
    function turnCheck(sgBaseline, domBase, st) {
        st.t0 = st.t0 || Date.now();
        if (st.base === undefined) st.base = domBase || null;
        var snap = null;
        try { snap = domSnapshot(); } catch (e) { }
        if (!st.base && snap) st.base = snap;
        if (snap) {
            var cur = snap.last || '';
            if (st.base && (snap.n > st.base.n || (cur && cur !== st.base.last))) st.changed = true;
            if (cur !== st.prev) { st.prev = cur; st.stable = 0; }
            else if (cur) st.stable++;
            var busy = false;
            try { busy = generatingNow(); } catch (e) { }
            // 完成 = 相比基线有变化 + 正文非空 + 连续 3 次轮询(约 2.1s)不再增长 + 停止按钮不可见。
            //   停止按钮若误报(选择器匹配到常驻元素), 则不会在这里判完 —— 由调用方到点
            //   collectTurn 兜底交出 DOM 全文, 宁可慢, 不交半截。
            if (st.changed && cur && st.stable >= 3 && !busy) {
                var pkt = bestPacketSince(sgBaseline) || { text: '', thinking: '', served: null, conv: null, sctx: '' };
                var out = { text: cur, thinking: pkt.thinking || '', served: pkt.served, conv: pkt.conv, sctx: pkt.sctx, via: 'dom' };
                if (!out.thinking) {
                    try { var d = domFallback(); if (d && d.thinking) out.thinking = d.thinking; } catch (e) { }
                }
                return fillServedConv(out);
            }
            // DOM 完全不可用(基线与当前都没有任何应答节点)时的包络独立完成判据:
            //   15s 宽限 + 必须解出正文, 防止把后台心跳/回显记录误判成本轮回答。
            if (!snap.n && st.base && !st.base.n && (Date.now() - st.t0) > 15000) {
                var bp = bestPacketSince(sgBaseline);
                if (bp && bp.text && bp.text.length >= 8) { bp.via = 'pkt'; return fillServedConv(bp); }
            }
        }
        return null;
    }
    // 到点收集: 优先「相比基线已变化的 DOM 正文」, 其次包络; 都没有则 null 由调用方报空。
    function collectTurn(sgBaseline, domBase) {
        var pkt = bestPacketSince(sgBaseline);
        var snap = null;
        try { snap = domSnapshot(); } catch (e) { }
        var domText = (snap && snap.last) || '';
        var changed = true;
        if (domText && domBase && snap.n <= (domBase.n || 0) && domText === (domBase.last || '')) changed = false;
        if (domText && changed) {
            return fillServedConv({
                text: domText,
                thinking: (pkt && pkt.thinking) || '',
                served: pkt ? pkt.served : null,
                conv: pkt ? pkt.conv : null,
                sctx: pkt ? pkt.sctx : '',
                via: 'dom',
            });
        }
        if (pkt && (pkt.text || pkt.served || pkt.conv)) { pkt.via = 'pkt'; return fillServedConv(pkt); }
        return null;
    }
    // 等待本轮完成并解析; 供 runTask 与探针共用。
    //   判据已从「URL 含 StreamGenerate」改为 DOM 主判据 + 包络补充(见 turnCheck)。
    function awaitResponse(sgBaseline, ms, domBase) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            var st = {};
            var poll = setInterval(function () {
                var done = turnCheck(sgBaseline, domBase || null, st);
                if (done) {
                    clearInterval(poll);
                    resolve(done);
                    return;
                }
                if (Date.now() - t0 > ms) {
                    clearInterval(poll);
                    var col = collectTurn(sgBaseline, domBase || null);
                    if (col) { resolve(col); return; }
                    var rq = sgDoneSince(sgBaseline);
                    resolve({
                        text: '', thinking: '',
                        served: (rq === false) ? 'NO_CHANNEL' : 'TIMEOUT',
                        conv: null, sctx: '', rpc: hookReport(),
                    });
                }
            }, 700);
        });
    }

    // ── 探针: 用真实 UI 选模型, 然后不注入任何 L5adhe 直接原生发送 ────────────
    // 目的: 把"L5adhe 注入是否生效"与"served 这个判据是否可信"两个变量分开。
    //   若 served 变成 3.1 Pro → served 可信, 问题在注入;
    //   若 served 仍是 Flash-Lite → served 不是模型判据(或账号侧另有约束)。
    function runUiModelProbe(prompt) {
        var log = [];
        log.push('pillBefore:' + uiPill());
        var target = MODE['3.1 Pro'];
        var base = Date.now();
        var picker = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
        if (!picker) {
            var bs = document.querySelectorAll('button');
            for (var i = 0; i < bs.length; i++) {
                if ((bs[i].getAttribute('aria-label') || '').indexOf('Open mode picker') >= 0) { picker = bs[i]; break; }
            }
        }
        if (!picker) { log.push('picker:NONE'); return Promise.resolve({ log: log.join(' | ') }); }
        log.push('picker:OK');
        try { picker.click(); } catch (e) { }
        // 菜单项选择器取自文档实证: gem-menu-item 同时带 data-mode-id 与
        //   data-test-id="bard-mode-option-<modeId>"(记录 486 的真机 HTML)。
        //   两个都收, 任一命中即可, 避免只认一个属性而在改版后失配。
        var itemSel = '[data-test-id^="bard-mode-option-"],gem-menu-item[data-mode-id],[data-mode-id]';
        return waitFor(function () { return document.querySelectorAll(itemSel).length ? true : null; }, 4000)
            .then(function (ok) {
                var items = document.querySelectorAll(itemSel);
                var names = [], tgt = null;
                for (var j = 0; j < items.length; j++) {
                    var tst = items[j].getAttribute('data-test-id') || '';
                    var mid = items[j].getAttribute('data-mode-id') || (/^bard-mode-option-(.+)$/.exec(tst) || [])[1] || '';
                    names.push((mid ? mid.slice(0, 6) : '?') + ':' + (items[j].textContent || '').trim().slice(0, 12));
                    if (mid === target) tgt = items[j];
                }
                log.push('items[' + items.length + ']=' + names.join(' '));
                if (!tgt) { log.push('target:NONE'); return null; }
                var clickable = tgt.querySelector('button,[role="menuitem"]') || tgt;
                try { clickable.click(); } catch (e) { }
                log.push('clicked=3.1 Pro');
                return sleep(1800);
            })
            .then(function () {
                log.push('pillAfter:' + uiPill());
                var all = allGaf();
                var found = false;
                for (var k = 0; k < all.length; k++) {
                    if ((all[k].__ts || 0) < base) continue;
                    if (all[k].u.indexOf('L5adhe') >= 0) { log.push('REAL_L5=' + decodeL5(all[k].req)); found = true; break; }
                }
                if (!found) log.push('REAL_L5=NOT_CAPTURED');
                if (!prompt) return null;
                // 关键: 不做 L5adhe 注入、不新建会话, 直接用当前 UI 状态发送
                var sgB = Date.now();
                var domB = null;
                try { domB = domSnapshot(); } catch (e) { }
                return typeAndSend(prompt).then(function (s) {
                    log.push('send:' + (s.ok ? 'OK' : 'FAILED') + '[' + s.diag + ']');
                    if (!s.ok) return { served: 'SEND_FAILED', text: '', thinking: '', conv: null, sctx: '' };
                    return awaitResponse(sgB, 120000, domB);
                });
            })
            .then(function (r) {
                if (!r) return { log: log.join(' | ') };
                return { log: log.join(' | '), text: r.text, thinking: r.thinking, served: r.served, conv: r.conv, sctx: r.sctx };
            });
    }

    // 新建会话: 逐个策略尝试, 命中即返回。
    // 不能只查 <button>: 实测候选里只有 Temporary chat / Search chats, 没有 New chat,
    // 说明它在当前 DOM 里可能是 <a>、自定义元素, 或文案不同。
    // ── 真实 UI 设态 ────────────────────────────────────────────────────────
    // 为什么模型/等级必须走 UI 点击, 而不是 L5adhe 注入:
    //   实测注入 a0len=100 set{99} 与真机报文形状逐位一致、同样返回 [1], 但 served 不变
    //   (请求 4 Argon 实得 3.1 Pro); 而合成 click 走真实 UI 后 pill 与 served 立即变
    //   (探针实测: 点击 3.1 Pro -> pill 变 Gemini Pro -> served=3.1 Pro)。
    // 机制: 本地 Angular 状态才是"当前选择"的真源, New chat 等动作会按本地状态回写服务端,
    //   纯 RPC 注入会被随后的一次回写覆盖。走 UI 则本地态与服务端一致, 天然免疫覆盖。
    var MODE_ITEM_SEL = '[data-test-id^="bard-mode-option-"],gem-menu-item[data-mode-id],[data-mode-id]';
    function pickerButton() {
        var p = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
        if (p) return p;
        var bs = document.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
            if ((bs[i].getAttribute('aria-label') || '').indexOf('Open mode picker') >= 0) return bs[i];
        }
        return null;
    }
    // 菜单开合是 toggle, 已开时再点会关掉, 故先探测是否已展开
    function ensurePickerOpen() {
        if (document.querySelectorAll(MODE_ITEM_SEL).length) return Promise.resolve(true);
        var p = pickerButton();
        if (!p) return Promise.resolve(false);
        try { p.click(); } catch (e) { }
        return waitFor(function () { return document.querySelectorAll(MODE_ITEM_SEL).length ? true : null; }, 4000);
    }
    function menuItems() { return document.querySelectorAll('[role="menuitem"],gem-menu-item'); }
    function closeMenu() {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        } catch (e) { }
    }
    // 模型: 按 data-mode-id 精确点击, 属性缺失时回退解析 data-test-id 后缀
    function clickModeItem(modeId) {
        return ensurePickerOpen().then(function (open) {
            if (!open) return 'modeUI:pickerNONE';
            var items = document.querySelectorAll(MODE_ITEM_SEL), tgt = null, seen = [];
            for (var j = 0; j < items.length; j++) {
                var tst = items[j].getAttribute('data-test-id') || '';
                var mid = items[j].getAttribute('data-mode-id') || (/^bard-mode-option-(.+)$/.exec(tst) || [])[1] || '';
                seen.push((mid || '?').slice(0, 6));
                if (mid === modeId) tgt = items[j];
            }
            if (!tgt) return 'modeUI:NONE[' + seen.join(',') + ']';
            var clickable = tgt.querySelector('button,[role="menuitem"]') || tgt;
            try { clickable.click(); } catch (e) { }
            closeMenu();
            return sleep(1200).then(function () { return 'modeUI:' + uiPill(); });
        });
    }
    // 等级: 菜单里先点 "Thinking level" 展开子菜单, 再点 Low/Medium/High
    function clickLevelItem(levelName) {
        return ensurePickerOpen().then(function (open) {
            if (!open) return 'lvlUI:pickerNONE';
            var all = menuItems(), tl = null;
            for (var i = 0; i < all.length; i++) {
                if (/thinking\s*level/i.test((all[i].textContent || '').trim())) { tl = all[i]; break; }
            }
            if (!tl) return 'lvlUI:noThinkingMenu';
            try { tl.click(); } catch (e) { }
            return sleep(700).then(function () {
                var opts = menuItems(), tgt = null, seen = [];
                var re = new RegExp('^\\s*' + levelName, 'i');
                for (var k = 0; k < opts.length; k++) {
                    var t = (opts[k].textContent || '').trim();
                    if (!t || /thinking\s*level/i.test(t)) continue;
                    if (re.test(t)) {
                        seen.push(t.slice(0, 20));
                        if (!tgt) tgt = opts[k];
                    }
                }
                if (!tgt) return 'lvlUI:NONE[' + seen.join('|') + ']';
                var clickable = tgt.querySelector('button,[role="menuitem"]') || tgt;
                try { clickable.click(); } catch (e) { }
                closeMenu();
                return sleep(900).then(function () { return 'lvlUI:' + uiPill(); });
            });
        });
    }
    // 工具: 先试真实 UI 点击(chip 是 role=menuitemcheckbox)。
    //   文档记录 2243/2352 实测合成 click 打不动 chip(CDK 过滤非可信手势), 但模型菜单的
    //   合成 click 是有效的, 两者机制不同 —— 故这里实测而非照搬结论, 失败再退回 RPC 注入。
    //   成功判据必须是"目标 chip 最终被选中", 不能是"找到了元素" ——
    //   实测第一版就栽在这: 找到了 chip、点了、aria-checked 没变, 却因为返回值不含 NONE
    //   而没触发回退, 把"点了没反应"错当成成功。
    var TOOL_LABEL = { Canvas: /canvas/i, 'Create image': /create\s*image/i, 'Create video': /create\s*video/i, 'Create music': /create\s*music/i };
    function clickToolItem(tool) {
        if (!tool || tool === 'none') return Promise.resolve('toolUI:skip(none)');
        var re = TOOL_LABEL[tool] || new RegExp(tool, 'i');
        return uiChipsExpanded().then(function (before) {
            var items = document.querySelectorAll('toolbox-drawer-item'), tgt = null, seen = [];
            for (var i = 0; i < items.length; i++) {
                var t = (items[i].textContent || '').trim();
                seen.push(t.slice(0, 10));
                if (re.test(t)) tgt = items[i];
            }
            if (!tgt) return 'toolUI:NONE[' + before + '|' + seen.join(',') + ']';
            // 文档记录 1975 说当时点到的是"没接上事件流的占位", 故这里对多个候选元素依次尝试,
            //   每试一个就读一次 aria-checked, 命中即停 —— 免得在错的节点上反复空点。
            var cands = [
                ['inner-button', tgt.querySelector('button[role=menuitemcheckbox]')],
                ['any-button', tgt.querySelector('button')],
                ['md-list-item', tgt.querySelector('mat-mdc-list-item,.mdc-list-item')],
                ['item', tgt],
                ['content', tgt.querySelector('[data-test-id=toolbox-drawer-item-content]')]
            ].filter(function (p) { return p[1]; });

            // 读目标工具项内部按钮的 aria-checked —— 这是工具是否真正选中的权威判据。
            //   不能读 uiChips(): 点中工具项后抽屉会自动关闭, uiChips() 恒返回 'CLOSED',
            //   旧写法据此判失败, 于是"明明选上了也报 FAILED"。
            function targetChecked() {
                var its = document.querySelectorAll('toolbox-drawer-item'), t = null;
                for (var i = 0; i < its.length; i++) if (re.test((its[i].textContent || '').trim())) t = its[i];
                if (!t) return null;
                var btn = t.querySelector('button[role=menuitemcheckbox]') || t.querySelector('button');
                return btn ? btn.getAttribute('aria-checked') : null;
            }
            // 抽屉点选后会自动关闭; 需要读数时确保它是展开的
            function ensureOpen() {
                if (document.querySelectorAll('toolbox-drawer-item').length) return Promise.resolve(true);
                var db = toolDrawerButton();
                if (!db) return Promise.resolve(false);
                if (db.getAttribute('aria-expanded') !== 'true') { try { db.click(); } catch (e) { } }
                return waitFor(function () { return document.querySelectorAll('toolbox-drawer-item').length ? true : null; }, 2500);
            }
            var tried = [];
            function attempt(k) {
                if (k >= cands.length) return Promise.resolve('toolUI:FAILED ' + before + '->checked=' + targetChecked() + ' tried[' + tried.join(',') + ']');
                var name = cands[k][0], el = cands[k][1];
                // 必须 focus + 只点一次: Angular CDK 的 menuitemcheckbox 只响应已获焦元素的点击;
                //   且它是 toggle 语义, 合成序列里的 click 再叠加 el.click() 等于双击 -> 开了又关,
                //   表现为"点了没反应"(旧写法双重点击, 是 Canvas 选不上的直接原因)。
                try { if (el.focus) el.focus(); } catch (e) { }
                try { el.click(); } catch (e) { }
                return sleep(700).then(function () {
                    // 点后抽屉多半已关闭, 重开再读 aria-checked 判定是否真的选中
                    return ensureOpen().then(function () {
                        var ck = targetChecked();
                        tried.push(name + '=checked:' + ck);
                        if (ck === 'true') return 'toolUI:OK ' + before + '->checked:true via=' + name;
                        return attempt(k + 1);
                    });
                });
            }
            return attempt(0);
        });
    }

    // L5adhe 流量日志: 记录本任务期间页面自己发出的写态报文。
    // 用途: 验证"本地状态回写覆盖注入"这一机制 —— 若 newChat 之后出现一条非我方、内容
    //   却等于本地模型态(3.1 Pro)的 L5adhe, 即坐实覆盖。
    function l5Traffic(from) {
        var all = allGaf(), out = [];
        for (var i = 0; i < all.length && out.length < 8; i++) {
            var x = all[i];
            if ((x.__ts || 0) < from) continue;
            if (x.u.indexOf('L5adhe') >= 0) out.push((x.rid || '?') + (x.__ours ? '{OURS ' : '{PAGE ') + decodeL5(x.req) + '}');
        }
        return out.join(' ');
    }

    // ── 切回指定会话 ────────────────────────────────────────────────────────
    // 为什么需要它: 每次请求结束都会 New chat 切走会话, 而视频是异步生成的 ——
    //   等成品出现时页面早已不在那个会话上, 直接扫 DOM 必然扫不到。
    // conv id 形如 c_12681f261e849ff3(来自 StreamGenerate 响应 p[1]), 已随 meta 返回给调用方。
    //
    // 侧边栏会话项如何承载 conv id 未经实测, 故这里不猜单一选择器, 而是:
    //   ① 收集所有可能承载会话的元素, 按多种键(id / href / 属性)匹配;
    //   ② 无论成败都把候选清单带回去 —— 失败时它就是我下一轮修选择器的依据。
    function convCandidates() {
        var out = [], seen = {};
        function scan(sel, keyFn) {
            var els = document.querySelectorAll(sel);
            for (var i = 0; i < els.length; i++) {
                var k = keyFn(els[i]);
                if (!k || seen[k]) continue;
                seen[k] = 1;
                out.push({ key: k, tag: els[i].tagName.toLowerCase(), el: els[i] });
            }
        }
        // 会话 id 在页面上可能带 c_ 前缀, 也可能是裸 hex; href 里还可能是另一种编码
        scan('[data-conv-id]', function (e) { return 'dcid=' + e.getAttribute('data-conv-id'); });
        scan('[data-test-id*="conversation" i]', function (e) { return 'tid=' + e.getAttribute('data-test-id'); });
        scan('a[href]', function (e) {
            var h = e.getAttribute('href') || '';
            if (!/\/app\//.test(h)) return null;
            return 'href=' + h;
        });
        scan('[id^="c_"]', function (e) { return 'id=' + e.id; });
        return out;
    }
    // 取证: 把会话列表条目的全部属性摊开。
    //   实测四种键(conv-id / test-id / href / id)都没匹配上, 说明 conv id 挂在别处
    //   —— 属性名未知, 或在子节点, 或在 jslog 的 base64 里。不猜, 直接列出真机结构。
    function convProbe() {
        var items = document.querySelectorAll('gem-nav-list-item[data-test-id="conversation"], [data-test-id="conversation"]');
        var out = {
            listFound: !!document.querySelector('conversations-list'),
            itemCount: items.length,
            linksTotal: document.querySelectorAll('a[href]').length,
            items: [],
        };
        function attrsOf(e, maxLen) {
            var o = {};
            try {
                for (var i = 0; i < e.attributes.length; i++) {
                    var nm = e.attributes[i].name;
                    if (nm === 'class' || nm === 'style') continue;
                    o[nm] = String(e.attributes[i].value).slice(0, maxLen);
                }
            } catch (x) { }
            return o;
        }
        for (var i = 0; i < items.length && i < 2; i++) {
            var e = items[i], kids = [];
            try {
                var ks = e.querySelectorAll('*');
                for (var k = 0; k < ks.length && k < 5; k++) {
                    var ka = attrsOf(ks[k], 55);
                    if (Object.keys(ka).length) kids.push(ks[k].tagName.toLowerCase() + ' ' + JSON.stringify(ka));
                }
            } catch (x2) { }
            out.items.push({ tag: e.tagName.toLowerCase(), attrs: attrsOf(e, 80), kids: kids, text: (e.textContent || '').trim().slice(0, 24) });
        }
        return out;
    }
    // 侧边栏会话列表是懒渲染的: 未展开时 gem-nav-list-item 只有骨架,
    //   无子节点、无文字、内无 a[href], 于是 convCandidates() 空手而归。
    //   实测: 侧边栏可见时匹配成功, 不可见时 22 个条目全是空壳(kids=[] text="")。
    //   故切会话前必须先确保侧边栏展开, 并在展开后重取一次。
    function sidebarItemsReady() {
        var items = document.querySelectorAll('gem-nav-list-item[data-test-id="conversation"]');
        if (!items.length) return false;
        for (var i = 0; i < items.length; i++) {
            if (items[i].querySelector('a[href]')) return true;   // 有一个渲染出链接就够
        }
        return false;
    }
    function ensureSidebar() {
        if (sidebarItemsReady()) return Promise.resolve('already-open');
        var how = expandSidebar();
        return waitFor(function () { return sidebarItemsReady() ? true : null; }, 3000)
            .then(function (ok) { return ok ? 'opened:' + (how || 'unknown') : 'FAILED:' + (how || 'no-button'); });
    }
    function switchConv(convId) {
        var want = String(convId || '').trim();
        if (!want) return Promise.resolve({ ok: false, note: 'convId 为空' });
        var bare = want.replace(/^c_/, '');
        return ensureSidebar().then(function (sb) {
            var cands = convCandidates();
            var hit = null;
            for (var i = 0; i < cands.length; i++) {
                var k = cands[i].key;
                if (k.indexOf(want) >= 0 || (bare.length > 6 && k.indexOf(bare) >= 0)) { hit = cands[i]; break; }
            }
            var summary = cands.slice(0, 12).map(function (c) { return c.tag + ':' + c.key.slice(0, 46); }).join(' | ') || 'no-candidates';
            if (!hit) {
                // 刻意不做 location.href 跳转兜底: 整页跳转会销毁扩展上下文, 使本次回捞的
                //   postMessage 永远回不来(bridge 只能超时), 反而把一个可诊断的失败变成哑失败。
                //   如实报"未找到"+候选清单+侧边栏状态 —— 这就是下一轮修选择器的直接依据。
                return { ok: false, note: '未找到匹配的会话项', sidebar: sb, candidates: summary };
            }
            try { (hit.el.querySelector('a[href]') || hit.el).click(); } catch (e) { }
            return sleep(2000).then(function () {
                return { ok: true, via: 'click:' + hit.tag + ':' + hit.key.slice(0, 30), sidebar: sb, candidates: summary };
            });
        });
    }

    // ── 视频结果回捞 ────────────────────────────────────────────────────────
    // 背景(用户实测确认): /v1/video 的生成是异步的 —— 提交后页面立刻回"正在生成视频,
    //   这可能需要几分钟", 真正的视频过几分钟才出现在会话里。因此单次请求永远拿不到成品,
    //   必须事后回捞。本函数只读 DOM, 不触发任何生成, 可安全反复调用。
    //
    // 两种链接的可取性不同, 必须如实标注, 否则调用方会把取不到的链接当成品:
    //   blob:  → 仅页面上下文有效, 转发器(Node)取不到, 只能提示用户在页面下载
    //   http(s) → 可直接下载
    function isVideoUrl(u) { return /^https?:/i.test(u) || /^blob:/i.test(u); }
    function readVideos() {
        var out = [], seen = {};
        function add(u, kind, extra) {
            if (!u || !isVideoUrl(u)) return;
            var key = u.slice(0, 120);
            if (seen[key]) return;
            seen[key] = 1;
            out.push({ url: u, kind: kind, source: extra || '', fetchable: /^https?:/i.test(u) });
        }
        // 1) <video> 及其 <source>
        var vs = document.querySelectorAll('video');
        for (var i = 0; i < vs.length; i++) {
            add(vs[i].getAttribute('src'), 'video', 'video[src]');
            add(vs[i].currentSrc, 'video', 'video.currentSrc');
            var ss = vs[i].querySelectorAll('source');
            for (var j = 0; j < ss.length; j++) add(ss[j].getAttribute('src'), 'video', 'source[src]');
            var po = vs[i].getAttribute('poster');
            if (po) add(po, 'poster', 'video[poster]');
        }
        // 2) 下载链接: 视频成品通常挂在 googleusercontent / contribution 的 download 上
        var as = document.querySelectorAll('a[href]');
        for (var k = 0; k < as.length; k++) {
            var h = as[k].getAttribute('href') || '';
            if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(h) || /videoplayback|video_generation|contribution\.usercontent/i.test(h)) {
                add(h, 'download', 'a[href]');
            }
        }
        // 3) DOM 文本里的裸链(响应正文里出现过 image/jpeg 那类裸链, 视频同理)
        try {
            var txt = document.body ? (document.body.innerText || '') : '';
            var re = /https?:\/\/[^\s"'<>)]+\.(?:mp4|webm|mov)[^\s"'<>)]*/gi, m;
            while ((m = re.exec(txt))) add(m[0], 'text', 'body.innerText');
        } catch (e) { }
        return out;
    }
    // 给回捞结果附上会话诊断, 便于判断"还没生成好"还是"选择器不对"
    //   convId 非空时先切回该会话再扫 —— 视频生成期间页面可能已被后续请求切走。
    function videoReport(convId) {
        var pre = Promise.resolve(null);
        if (convId) pre = switchConv(convId);
        return pre.then(function (sw) {
            return sleep(600).then(function () {
                var v = readVideos();
                var conv = (location.pathname || '').replace(/^\/u\/\d+/, '');
                var busy = false;
                try {
                    var bs = document.querySelectorAll('button,[aria-label]');
                    for (var i = 0; i < bs.length; i++) {
                        var al = bs[i].getAttribute('aria-label') || '';
                        if (/stop response|正在生成|generating/i.test(al + ' ' + (bs[i].textContent || ''))) { busy = true; break; }
                    }
                } catch (e) { }
                var r = {
                    count: v.length,
                    fetchable: v.filter(function (x) { return x.fetchable; }).length,
                    videos: v.slice(0, 6),
                    conv: conv,
                    generating: busy,
                    where: conv,
                    note: v.length ? ''
                        : (busy ? '仍在生成中, 稍后再试' : '未在页面找到视频: 可能尚未生成完, 或已切走会话'),
                };
                if (sw) r.switch = sw;   // 切会话的结果(含失败时的候选清单, 供精确修选择器)
                // 切会话失败时附上真机结构取证 —— 下一轮据此精确修, 不再靠猜
                if (sw && !sw.ok) { try { r.convProbe = convProbe(); } catch (e) { r.convProbe = { err: e.message }; } }
                return r;
            });
        });
    }

    var NEWCHAT_TEXT = /new chat|new conversation|新对话|新聊天|新しいチャット|新建对话/i;

    // 当前视图标识 + 侧栏状态。新建会话会改变 pathname, 这是"到底换了没有"的直接判据
    //   —— 之前只看 newchat 策略名, 策略命中不等于真跳转(实测 newchat:testid 仍 served 小模型)。
    function uiWhere() { return (location.pathname || '/').replace(/^\/u\/\d+/, '') || '/'; }
    // 仅看 pathname 会误判: 本就停在 /app 时点 New chat, pathname 不变。
    // 故把"会话轮次数"一并纳入视图指纹, 两者任一变化即视为换会话成功。
    function uiTurnCount() {
        var sels = ['conversation-turn', 'model-response', 'user-query', '.conversation-container'];
        var n = 0;
        for (var i = 0; i < sels.length; i++) {
            var k = document.querySelectorAll(sels[i]).length;
            if (k > n) n = k;
        }
        return n;
    }
    function uiFingerprint() { return uiWhere() + '#' + uiTurnCount(); }
    function rectOf(el) {
        try { var b = el.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); }
        catch (e) { return '?'; }
    }
    // 侧栏折叠时 New chat 节点仍在 DOM 但尺寸为 0, click() 是空操作。
    // typeAndSend 对发送按钮做了可见性检查, newChat 之前漏了 —— 这里补上。
    function newChatEl() {
        return document.querySelector('[data-test-id="new-chat-button"]')
            || document.querySelector('[data-test-id*="new-chat" i]');
    }
    function expandSidebar() {
        // 文档记录 79 的真机按钮清单里有 aria-label="Open sidebar" 与 "Close sidebar",
        //   这两个是本页面的实际控件, 故排在最前; 其余为兜底。
        var cands = ['button[aria-label="Open sidebar"]',
            'button[aria-label*="Open sidebar" i]',
            'button[data-test-id="side-nav-menu-button"]',
            'button[data-test-id="expand-side-nav"]',
            'button[aria-label="Main menu"]',
            'button[aria-label*="Expand" i]'];
        for (var i = 0; i < cands.length; i++) {
            var e = document.querySelector(cands[i]);
            if (e) { try { e.click(); } catch (x) { } return cands[i]; }
        }
        return null;
    }

    // New chat 的第一策略命中 [data-test-id="new-chat-button"], 它是个自定义元素
    //   (gem-nav-list-item), 真正的 Angular 路由锚点是它内部的 <a href="/app">。
    //   实测: 点外层自定义元素是空操作(URL 不变), 点内部 <a> 才真正切到新会话
    //   —— 这正是「每轮都落回旧会话、上下文被污染」的根因。
    // 故点击前统一把命中元素解析成「可点节点」: <a>/<button> 原样返回;
    //   自定义元素则下钻到内部的 a[href] 或 button。
    function clickableOf(el) {
        if (!el) return el;
        try {
            var t = el.tagName ? String(el.tagName).toLowerCase() : '';
            if (t === 'a' || t === 'button') return el;
            var inner = el.querySelector('a[href]') || el.querySelector('button');
            return inner || el;
        } catch (e) { return el; }
    }
    function newChat() {
        var strategies = [
            ['testid', function () { return document.querySelector('[data-test-id="new-chat-button"]'); }],
            ['testid*', function () { return document.querySelector('[data-test-id*="new-chat" i]'); }],
            ['href', function () {
                var as = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
                return as.filter(function (a) { return /^\/u\/\d+\/app\/?$|^\/app\/?$/.test(a.getAttribute('href') || ''); })[0];
            }],
            ['aria', function () {
                var all = Array.prototype.slice.call(document.querySelectorAll('[aria-label]'));
                return all.filter(function (x) { return NEWCHAT_TEXT.test(x.getAttribute('aria-label') || ''); })[0];
            }],
            ['text', function () {
                var all = Array.prototype.slice.call(document.querySelectorAll('button,a,[role="button"],side-nav-action-button,gem-icon-button'));
                return all.filter(function (x) { return NEWCHAT_TEXT.test((x.textContent || '').trim()); })[0];
            }]
        ];
        function tryOnce() {
            for (var i = 0; i < strategies.length; i++) {
                var el = null;
                try { el = strategies[i][1](); } catch (e) { }
                if (el) return { name: strategies[i][0], el: clickableOf(el) };
            }
            return null;
        }
        var before = uiFingerprint();
        var hit = tryOnce();
        if (!hit) {
            // 全失败: 报出所有可能是"新建"的候选(含标签名), 便于按真实 DOM 精确修
            var cands = Array.prototype.slice.call(document.querySelectorAll('[data-test-id],[aria-label],a[href],[role="button"]'))
                .map(function (x) {
                    var id = x.getAttribute('data-test-id') || x.getAttribute('aria-label') || x.getAttribute('href') || '';
                    return x.tagName.toLowerCase() + ':' + id;
                })
                .filter(function (s) { return /new|chat|app|新|对话|conversation/i.test(s); })
                .slice(0, 10);
            return Promise.resolve('newchat:NONE[' + (cands.join(' | ') || 'no-candidates') + ']');
        }
        var r0 = rectOf(hit.el);
        var zero = /^0x0$/.test(r0);
        var exp = null;
        if (zero) {
            // 侧栏展开有 CSS 过渡, 展开后立刻读 rect 仍是 0x0, 必须等它长出来再点
            exp = expandSidebar();
            return waitFor(function () {
                var e = newChatEl();
                if (!e) return null;
                var r = rectOf(e);
                return /^0x0$/.test(r) ? null : e;
            }, 2500).then(function (el2) {
                if (el2) { hit = { name: hit.name + '+expand', el: clickableOf(el2) }; }
                try { hit.el.click(); } catch (e) { }
                return afterClick();
            });
        }
        try { hit.el.click(); } catch (e) { }
        return afterClick();

        function afterClick() {
            var tag = 'newchat:' + hit.name + '(tag=' + hit.el.nodeName + ',rect=' + rectOf(hit.el) + (exp ? ',expand=' + exp : '') + ')';
            // 视图指纹只作诊断, 不作成败判据 —— 它区分不了"已经是空会话"与"点了没反应"。
            // 实测 UNCHANGED(/app#0) 的真正含义: 点击前后轮次都是 0, 即页面本就在全新空会话上,
            //   此时点 New chat 是合法 no-op, 而会话 id 每次仍会变(conv 字段可证)。
            //  旧写法把它与"点了没重置掉旧内容"报成同一个 UNCHANGED, 平白制造假警报。
            // 指纹本身也不可信: uiTurnCount 的选择器未经实测, 且本函数在新会话建立前就读它,
            //   轮次数本来就不会变。故这里只报"点了什么", 不再给换会话成功/失败的结论 ——
            //   真正的判据是 StreamGenerate 响应里的 conv id(p[1]), 那才是实测确定的事实。
            var conv0 = convFromUrl();
            return sleep(900).then(function () {
                var conv1 = convFromUrl();
                // 换会话成功的直接判据: 会话段变化(地址栏是给人看的, 最可信)。
                //   旧写法用 uiFingerprint, 它区分不了「点了没反应」与「本就在新会话」。
                var verdict = (conv1 !== conv0)
                    ? ' ->conv ' + (conv0 || 'none') + '=>' + (conv1 || 'none')
                    : ' ->conv-unchanged(' + (conv0 || 'none') + ')';
                return tag + verdict;
            });
        }
    }
    function turnCountOf(fp) { var m = /#(\d+)$/.exec(fp || ''); return m ? Number(m[1]) : -1; }
    // 轮询等待元素出现: New chat 会重建 DOM, 固定 sleep 太脆(实测 send:FAILED 就是抓到旧节点)
    function waitFor(fn, ms) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function tick() {
                var v = null;
                try { v = fn(); } catch (e) { }
                if (v) return resolve(v);
                if (Date.now() - t0 > ms) return resolve(null);
                setTimeout(tick, 120);
            })();
        });
    }
    // 选择器按实测优先级排列, 逐个兜底; 返回 {el, hit} 以便失败时能报出命中情况
    function findEditor() {
        var sels = ['.ql-editor', 'rich-textarea .ql-editor', 'div[contenteditable="true"]', 'textarea'];
        for (var i = 0; i < sels.length; i++) {
            var e = document.querySelector(sels[i]);
            if (e) return { el: e, hit: sels[i] };
        }
        return null;
    }
    function findSend() {
        // 文档实测: Send 不是原生 button, 而是自定义元素 gem-icon-button.send-button, 内部才包 button
        var sels = ['gem-icon-button.send-button button', 'button.send-button',
            'button[aria-label="Send message"]', 'button[aria-label*="Send" i]',
            'gem-icon-button.send-button', '.send-button'];
        for (var i = 0; i < sels.length; i++) {
            var e = document.querySelector(sels[i]);
            if (!e) continue;
            var dis = e.disabled === true;
            if (!dis && typeof e.getAttribute === 'function' && e.getAttribute('aria-disabled') === 'true') dis = true;
            return { el: e, hit: sels[i], disabled: dis };
        }
        return null;
    }
    function setEditorText(el, text) {
        el.focus();
        try {
            var r = document.createRange(); r.selectNodeContents(el);
            var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            document.execCommand('delete');
        } catch (e) { }
        document.execCommand('insertText', false, text);
        // Quill 有时不接收 execCommand, 内容为空时退回直接改 DOM 再补发 input 事件
        var got = (el.value != null ? el.value : el.textContent) || '';
        if (got.indexOf(text.slice(0, 8)) < 0) {
            if (el.value != null) el.value = text;
            else el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return ((el.value != null ? el.value : el.textContent) || '').length;
    }
    function typeAndSend(prompt) {
        return waitFor(findEditor, 8000).then(function (ed) {
            if (!ed) return { ok: false, diag: 'editor:NONE' };
            var len = setEditorText(ed.el, prompt);
            // 正文没进去就绝不点发送 —— 否则会往会话里发一条只有标记的空消息(实测发生过)
            var head = prompt.slice(0, 6);
            if (len < head.length || ((ed.el.value != null ? ed.el.value : ed.el.textContent) || '').indexOf(head) < 0) {
                return { ok: false, diag: 'editor:EMPTY ed=' + ed.hit + ' len=' + len };
            }
            return waitFor(findSend, 5000).then(function (sb) {
                if (!sb) return { ok: false, diag: 'send:NONE ed=' + ed.hit + ' len=' + len };
                var tg = sb.el;
                try { tg.scrollIntoView({ block: 'center' }); } catch (e) { }
                var b = tg.getBoundingClientRect();
                if (!b.width && !b.height) return { ok: false, diag: 'send:hidden ' + sb.hit + ' len=' + len };
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
                    tg.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: b.left + 8, clientY: b.top + 8, button: 0 }));
                });
                try { tg.click(); } catch (e) { }
                return { ok: true, diag: 'send:' + sb.hit + ' ed=' + ed.hit + ' len=' + len + (sb.disabled ? ' DISABLED' : '') };
            });
        });
    }

    // 时序即生效条件: 模型(账号级)与 等级/工具(会话级)分两次写, New chat 之后必须再写一次
    function runTask(t) {
        return new Promise(function (resolve) {
            // 空 prompt 直接拒绝: 只发标记没有意义, 还会在账号里留垃圾会话
            if (!t || typeof t.prompt !== 'string' || !t.prompt.trim()) {
                resolve({ text: '', thinking: '', served: 'BAD_TASK', rpc: 'task:EMPTY_PROMPT' });
                return;
            }
            var p = t.prompt;
            var rpcLog = [];
            var sgBaseline = Date.now();   // 时间戳基线: 跨 realm 后下标不再是全局单调序
            var sendOk = null;             // null=发送流程尚未走完; false=确定没发出去
            var domBase = null;            // 发送时刻的 DOM 基线(方案2: DOM 主判据的对照点)
            var pill0 = uiPill();
            function note(tag, rs) {
                // 只取判据所需: HTTP 码 + wrb.fr 返回码([1]=被处理, [3]=结构非法, [7]=at 无效)。
                // 注意 [1] 只是"RPC 被处理"的宽口径回执, 不能当生效判据(文档实测: 越界长度也返回 OK),
                //   真正判据是同一条日志里的 pill 文案。
                var arr = Array.isArray(rs) ? rs : [rs];
                var parts = [];
                for (var i = 0; i < arr.length; i++) {
                    var r = arr[i] || {};
                    var code = '?';
                    if (r.text) {
                        var m = /\["wrb.fr","L5adhe",("\[(\d+)\]"|null)/.exec(r.text);
                        code = m ? m[1] : String(r.text).slice(0, 24);
                    }
                    parts.push((r.tag || tag) + '=http' + (r.status || '?') + ':' + code);
                }
                rpcLog.push(tag + '[{' + parts.join('} {') + '}]@' + uiPill());
            }
            // UI 优先(本地态同步改), 选择器失配时退回 RPC 注入。
            // 退回只是不崩, 不代表能控住 —— 实测纯 RPC 注入会被本地状态回写覆盖,
            //   故 fallback 触发时在日志里显式标出, 避免把失败误读成成功。
            function setModel(where) {
                return clickModeItem(MODE[t.model] || t.model).then(function (a) {
                    rpcLog.push(where + '.' + a);
                    if (a.indexOf('modeUI:NONE') < 0 && a.indexOf('pickerNONE') < 0) return null;
                    rpcLog.push(where + '.fallbackRPC');
                    return setModelAndSession(t.model, t.level, t.tool)
                        .then(function (rs) { note(where + '.rpc', rs); });
                });
            }
            // 工具: UI 优先, 打不动(CDK 过滤合成手势)才退回 RPC 注入, 并显式标出
            function setTool() {
                return clickToolItem(t.tool).then(function (c) {
                    rpcLog.push(c);
                    if (/toolUI:FAILED|toolUI:NONE|NO_DRAWER_BTN/.test(c)) {
                        rpcLog.push('tool.fallbackRPC');
                        return rpcOne('tool', 45, 44, TOOL[t.tool] == null ? null : TOOL[t.tool])
                            .then(function (r) { return 'toolRPC:http' + r.status; })
                            .then(function (s) { rpcLog.push(s); });
                    }
                });
            }
            // 模型=账号级, 换会话前用真实 UI 设一次(本地态与服务端同时改)
            setModel('pre')
                .then(function () { return sleep(400); })
                .then(function () { return newChat(); })
                .then(function (s) { rpcLog.push(s); return sleep(900); })
                .then(function () {
                    // 顺序即生效: New chat 会重置会话级状态, 故换会话后再设一次。
                    // 这次走真实 UI(本地态与服务端同时改), 避免被后续回写覆盖。
                    var l5From = Date.now();
                    rpcLog.push('pillAfterNew:' + uiPill());
                    return setModel('post')
                        .then(function () { return clickLevelItem(t.level || 'High'); })
                        .then(function (b) { rpcLog.push(b); return setTool(); })
                        .then(function () {
                            var tr = l5Traffic(l5From);
                            if (tr) rpcLog.push('l5traffic[' + tr + ']');
                        });
                })
                .then(function () { return sleep(300); })
                .then(function () {
                    return uiChipsExpanded().then(function (ch) {
                        rpcLog.push('pillFinal:' + uiPill() + ' chips:' + ch);
                    });
                })
                .then(function () {
                    sgBaseline = Date.now();   // 记下发送时刻, 之后只看比它新的记录
                    try { domBase = domSnapshot(); } catch (e) { domBase = null; }   // DOM 主判据的对照基线
                    return typeAndSend(p);
                })
                .then(function (s) {
                    sendOk = !!s.ok;
                    rpcLog.push('send:' + (s.ok ? 'OK' : 'FAILED') + '[' + s.diag + ']');
                })
                .catch(function (e) { sendOk = false; rpcLog.push('err:' + e.message); });
            rpcLog.push('pillAtStart:' + pill0);
            rpcLog.push('hooks:' + hookReport());

            var t0 = 0;                          // 计时从「确实发出去了」开始, 而非建轮询时
            var hardEnd = Date.now() + 180000;   // 设态链路卡死的兜底时限
            var st = {};                         // turnCheck 的跨轮询会话态
            var poll = setInterval(function () {
                // 没发出去就没什么可等的: 直接失败, 别让调用方陪着干等两分钟。
                //   sendOk 为 null 表示发送流程还在走(设态/换会话要几秒), 此时不能下结论。
                if (sendOk === false) {
                    clearInterval(poll);
                    resolve({ text: '', thinking: '', served: 'SEND_FAILED', rpc: rpcLog.join(' | '), conv: null, sctx: '' });
                    return;
                }
                if (sendOk !== true) {
                    // 设态链路卡死(既不置 true 也不置 false)的兜底: 不能无限挂着
                    if (Date.now() > hardEnd) {
                        clearInterval(poll);
                        resolve({ text: '', thinking: '', served: 'SEND_HANG', rpc: rpcLog.join(' | '), conv: null, sctx: '' });
                    }
                    return;
                }
                if (!t0) t0 = Date.now();   // 计时从「确实发出去了」开始, 而不是从建轮询开始
                // 完成判据已换: DOM 主判据 + 包络补充(见 turnCheck)。
                //   旧写法认 URL 含 StreamGenerate, 而新版生成请求改走 batchexecute + 不透明
                //   rpcid, 该字面量恒不出现 -> sgDoneSince 恒 false -> 必然 NO_CHANNEL 空手而归。
                var done = turnCheck(sgBaseline, domBase, st);
                if (done) {
                    clearInterval(poll);
                    rpcLog.push('via:' + (done.via || '?'));
                    done.rpc = rpcLog.join(' | ');
                    done.served = done.served || null;
                    resolve(done);
                    return;
                }
                if (Date.now() - t0 > 120000) {
                    // 判定只在时限到点做, 不做任何提前抢跑。
                    //   到点仍无判据时先 collectTurn(DOM 相比基线有变化则用 DOM, 否则用包络),
                    //   只有真的一无所有才报空 —— 杜绝「页面有字却报超时」。
                    clearInterval(poll);
                    var col = collectTurn(sgBaseline, domBase);
                    if (col) {
                        rpcLog.push('via:' + (col.via || '?'));
                        col.rpc = rpcLog.join(' | ');
                        col.served = col.served || null;
                        resolve(col);
                        return;
                    }
                    var rq = sgDoneSince(sgBaseline);
                    var noChannel = (rq === false);
                    resolve({
                        text: '', thinking: '',
                        served: noChannel ? 'NO_CHANNEL' : 'TIMEOUT',
                        rpc: rpcLog.join(' | ') + (noChannel ? ' | hooks:' + hookReport() : ''),
                        conv: null, sctx: '',
                    });
                }
            }, 700);
        });
    }

    // 消息监听: 用一个"当前代"指针而不是每次 addEventListener。
    //   重载扩展会让本文件在新实例里再跑一次, 若只是每次挂新监听, 旧监听不会消失,
    //   同一条 videos 消息会被旧实例(旧代码)先处理并回一个没有 report 的响应
    //   —— 这正是"消息收到了却回不出 report"的来源。
    //   改为: 每次只保留最新一代的处理器, 旧监听看到代次不符即静默退出。
    var GEN = (window.__GA_GEN || 0) + 1;
    window.__GA_GEN = GEN;
    window.addEventListener('message', function (ev) {
        if (window.__GA_GEN !== GEN) return;   // 已有更新一代接管, 本监听作废
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || typeof d !== 'object') return;
        // 丢弃本文件自己回出去的结果包: 同窗口 postMessage 的 ev.source 也是 window,
        //   不过滤的话会收到自己刚回的 videos 包, 命中同一分支再回一次 -> 无限回环。
        //   不能按 from==='bridge' 过滤 —— bridge 发的 task/probe 请求同样带该标记,
        //   滤掉就等于把整条指令链切断(写错过一次)。本文件的回包一律带 pb, 用它区分。
        if (typeof d.pb === 'number') return;
        // bridge 可能先于本文件完成注入, 它到位后会来问一次, 这里补发握手
        if (d.__ga === 'bridge-ready') { window.postMessage({ __ga: 'page-ready', pb: PB }, '*'); return; }
        // 视频回捞: 只读 DOM, 不触发生成, 可任意次调用(异步生成的成品过几分钟才出现)
        //   d.convId 非空时先切回该会话 —— 生成期间页面可能已被后续请求切走。
        if (d.__ga === 'videos') {
            videoReport(d.convId).then(function (rep) {
                window.postMessage({ __ga: 'videos', id: d.id, pb: PB, report: rep }, '*');
            }, function (e) {
                window.postMessage({ __ga: 'videos', id: d.id, pb: PB, report: { count: 0, videos: [], note: 'READ_ERR:' + e.message } }, '*');
            });
            return;
        }
        // 探针通道: 用真实 UI 选模型后直接发送, 不注入 L5adhe。
        // 用来把"注入是否生效"与"served 判据是否可信"两个变量分开。
        if (d.__ga === 'probe') {
            runUiModelProbe(d.prompt || '').then(function (r) {
                window.postMessage({ __ga: 'result', id: d.id, thinking: r.thinking || '', text: r.text || '', served: r.served || '', rpc: r.log, conv: r.conv, sctx: r.sctx }, '*');
            });
            return;
        }
        if (d.__ga !== 'task' || !d.task) return;
        runTask(d.task).then(function (r) {
            window.postMessage({ __ga: 'result', id: d.task.id, thinking: r.thinking, text: r.text, served: r.served, rpc: r.rpc, conv: r.conv, sctx: r.sctx }, '*');
        });
    });

    window.postMessage({ __ga: 'page-ready', pb: PB }, '*');
})();
