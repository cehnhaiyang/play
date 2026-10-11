#Requires -Version 5.1
<#
  The Play — 开发辅助脚本

  用法：
    .\.ps1                     在项目根目录直接运行（打开交互菜单）
    powershell -File .ps1      显式指定 Windows PowerShell
    双击 .bat                  同上
    .\.ps1 -Action host-check  跑单个动作后退出，不进菜单（见下方 -Action）

  注意：本机未安装 PowerShell 7（无 pwsh），只能用 powershell.exe 5.1。
        5.1 读**无 BOM** 的 UTF-8 脚本时按系统 ANSI 代码页（本机 CP936）解码，
        中文会变成乱码并导致**语法错误** —— 报的是"字符串缺少终止符"或
        "必须在 % 运算符后面提供值表达式"，与真正的原因（编码）看不出关系。
        所以本文件必须带 UTF-8 BOM。改动它请用能保留 BOM 的编辑器，
        或用 [System.IO.File]::WriteAllText 配 (New-Object System.Text.UTF8Encoding $true)。

  菜单动作与 package.json scripts 的对应：
    [1] 安装依赖      npm install + .install_electron.mjs（经淘宝镜像下载 Electron 二进制）
    [2] 注册本机桥    npm run host:install   （注册 native messaging host，见下）
    [3] 开发环境      npm run electron:dev   （concurrently: vite + electron）
    [4] 构建生产版本  npm run build          （vite build → dist/）
    [5] 打包应用      npm run electron:build （vite build && electron-builder）
    [6] 类型检查      npm run typecheck      （tsc --noEmit，app 与 extension 两份配置）
    [7] 插件构建      npm run ext:build      （插件 → extension/dist/）
    [8] 跑全部测试    npm run test:spg       （test/index.js 的全部套件）
    [9] 清理产物      dist / extension\dist / test\build 等

  悬浮球与本机桥
  ──────────────
  两个悬浮球是**独立的 Electron 无边框窗口**（app/main/orbs.js），不是注入
  页面的 content script。它们没有 chrome.* API，要拿插件的嗅探结果与 Agent
  状态，只能经 native messaging 走一条跨进程链路：

      球 → preload → 主进程 → host.js ◀──connectNative── 插件 SW

  而 connectNative **只有扩展能发起**，应用无法主动连插件 —— 所以必须先把
  host 注册到注册表（[2]），浏览器才知道该拉起哪个进程。
  没注册的表现是球上一直显示"插件未连接"，而它与"浏览器没开"长得一模一样，
  从界面上分不出是哪种。所以 [3] 启动前会自检。

  注册是一次性的，但换目录 / 换机器 / 重装系统之后要重跑。

  为什么球不做成 content script
  ─────────────────────────────
  实测过：Chrome 的 popup 窗口最小 136×80（请求 56×56 会被顶到 136×80）、
  标题栏固定吃掉 39px 高与 16px 宽、且 windows.update 不接受 alwaysOnTop。
  也就是说插件里既做不出球、也做不到置顶。详见 app/main/orbs.js 文件头。
#>
param(
    [ValidateSet('menu', 'deps', 'host', 'host-check', 'dev', 'build', 'package', 'typecheck', 'ext', 'test', 'clean')]
    [string]$Action = 'menu'
)

# ── 基础设置 ────────────────────────────────────────────────
# 无控制台时（比如被别的进程拉起）设置标题会抛错，不值得因此中断
try { $Host.UI.RawUI.WindowTitle = "The Play — 开发助手" } catch { }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

# 定位项目根目录：优先取脚本自身所在目录。
# 经 .bat 或 Scriptblock::Create 执行时 $PSScriptRoot 可能为空，
# 回退到当前目录（.bat 已先 cd /d "%~dp0"）。
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $Root

# -Action 指定了具体动作时不进菜单，也不在动作末尾停下来等回车
$script:BatchMode = ($Action -ne 'menu')

# ── 本机桥的固定路径 ────────────────────────────────────────
# 三处必须逐字一致，任何一处写错的表现都是 connectNative 报
# "Specified native messaging host not found"，与真正的原因无关。
$HostName     = 'com.theplay.host'
$HostRegKey   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$HostManifest = Join-Path $env:APPDATA "the-play\$HostName.json"
$ExtManifest  = Join-Path $Root 'extension\public\manifest.json'

# ── 输出辅助（前缀统一 3 列，便于左对齐）────────────────────
function Write-Step([string]$Msg) { Write-Host "[·] $Msg" -ForegroundColor Yellow }
function Write-Ok([string]$Msg)   { Write-Host "[✓] $Msg" -ForegroundColor Green }
function Write-Err([string]$Msg)  { Write-Host "[✗] $Msg" -ForegroundColor Red }
function Write-Info([string]$Msg) { Write-Host "[i] $Msg" -ForegroundColor DarkGray }
function Pause-Return {
    if ($script:BatchMode) { return }
    Write-Host ""
    Read-Host "按回车键返回菜单" | Out-Null
}

# ── 环境 / 依赖检查 ────────────────────────────────────────
function Get-EnvLine {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm  = Get-Command npm  -ErrorAction SilentlyContinue
    if (-not $node) { Write-Err "未找到 Node.js，请先安装 https://nodejs.org/"; return $null }
    if (-not $npm)  { Write-Err "未找到 npm，请检查 Node.js 安装"; return $null }
    return "node $(& node --version) · npm $(& npm --version)"
}

function Test-Deps {
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
        Write-Err "未找到 node_modules，请先执行 [1] 安装依赖"
        return $false
    }
    return $true
}

# ── 端口占用检查 ────────────────────────────────────────────
<#
  找出占用指定端口的进程。

  ## 为什么需要这一步

  vite.config.mts 里是 strictPort: true —— 5173 被占时 vite **直接退出**，
  不换端口。而 concurrently 带 -k：一个进程退出就把另一个也 SIGTERM 掉，
  于是整个 electron:dev 立刻结束。用户看到的是这么一段：

      [0] Error: Port 5173 is already in use
      [0] vite exited with code 1
      --> Sending SIGTERM to other processes..

  它没说"谁占着"，也没说"怎么办"。而真实原因几乎总是**上一次的开发环境
  没退干净**（Ctrl+C 之后 vite 的子进程可能还活着，或另一个终端还开着）。

  这里主动查出来并给出 PID，用户可以直接决定要不要清掉。
#>
function Get-PortOwner {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    }
    catch { return $null }
    if (-not $conn) { return $null }
    $pid_ = ($conn | Select-Object -First 1).OwningProcess
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    $cmd = ''
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid_").CommandLine
    }
    catch { }
    return [pscustomobject]@{ Pid = $pid_; Name = $(if ($proc) { $proc.ProcessName } else { '?' }); Command = $cmd }
}

# 若端口被占则报告并询问是否清掉。返回 $true 表示"可以继续"
function Test-DevPort {
    $owner = Get-PortOwner -Port 5173
    if (-not $owner) { return $true }

    Write-Err "端口 5173 已被占用，vite 会直接退出（strictPort: true）"
    Write-Info "  占用者  PID $($owner.Pid)  $($owner.Name)"
    if ($owner.Command) {
        Write-Info "  命令    $($owner.Command.Substring(0, [Math]::Min(100, $owner.Command.Length)))"
    }
    Write-Host ""
    Write-Info "  多半是上一次的开发环境没退干净。Ctrl+C 之后 vite 的子进程有时还活着。"

    if ($script:BatchMode) {
        Write-Err "请先结束该进程，或改用别的端口"
        return $false
    }

    $kill = Read-Host "  结束 PID $($owner.Pid) 并继续？(y/N)"
    if ($kill -ne 'y' -and $kill -ne 'Y') {
        Write-Info "  已取消。请手动处理端口占用后重试。"
        return $false
    }
    try {
        Stop-Process -Id $owner.Pid -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 600
        if (Get-PortOwner -Port 5173) {
            Write-Err "PID $($owner.Pid) 已结束，但端口仍被占用（可能是另一个进程）"
            return $false
        }
        Write-Ok "端口 5173 已释放"
        return $true
    }
    catch {
        Write-Err "结束进程失败：$($_.Exception.Message)"
        return $false
    }
}

# 执行 npm 命令；显式调用 npm.cmd 以确保 $LASTEXITCODE 可靠。
# 必须用 -NpmArgs 具名传参：直接写 Invoke-Npm @('run','build') 会按位置
# 把 'build' 绑到 SuccessMsg 上（数组 splat 的位置绑定），导致参数传错。
function Invoke-Npm {
    param(
        [string[]]$NpmArgs,
        [string]$SuccessMsg,
        [string]$FailMsg
    )
    Write-Step "npm $($NpmArgs -join ' ')"
    & npm.cmd @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Err "$FailMsg（退出码 $LASTEXITCODE）"
        return $false
    }
    Write-Ok $SuccessMsg
    return $true
}

# ── 本机桥：扩展 id 与注册状态 ──────────────────────────────
<#
  从 manifest.json 的 key 推出扩展 id。

  Chrome 的算法是 SHA256(公钥 DER) 取前 16 字节，每个 nibble 映射到 a-p。
  之所以要自己算：注册表里的 allowed_origins 必须与它一致，而**不一致时的
  报错与真正的原因毫无关系**（"Specified native messaging host not found"，
  听起来像"没装"，实际是"id 不匹配"）。这里算出来是为了能把两者直接对比。
#>
function Get-ExtensionId {
    if (-not (Test-Path $ExtManifest)) { return '' }
    try {
        $json = [System.IO.File]::ReadAllText($ExtManifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not $json.key) { return '' }
        $der = [Convert]::FromBase64String($json.key)
        $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
        $sb  = New-Object System.Text.StringBuilder
        for ($i = 0; $i -lt 16; $i++) {
            [void]$sb.Append([char](97 + ($sha[$i] -shr 4)))
            [void]$sb.Append([char](97 + ($sha[$i] -band 0x0F)))
        }
        return $sb.ToString()
    }
    catch { return '' }
}

<#
  检查本机桥的注册状态。

  分四步逐级确认，每级失败都给出**具体**原因 —— 这四步里任何一步出错的
  表面现象都是同一个"插件未连接"，而修法完全不同：
    1. 注册表项在不在        → 没注册，跑 [2]
    2. 注册表指向的文件在不在 → 路径过期（换过目录），重跑 [2]
    3. manifest 里的 path 在不在 → host 脚本被删/被挪，重跑 [2]
    4. allowed_origins 与扩展 id 是否一致 → 换过 key，重跑 [2]
#>
function Get-HostStatus {
    $st = [pscustomobject]@{
        Registered  = $false
        Manifest    = $HostManifest
        Target      = ''
        TargetOk    = $false
        OriginOk    = $false
        ExtensionId = (Get-ExtensionId)
        Problem     = ''
    }

    if (-not (Test-Path $HostRegKey)) {
        $st.Problem = '注册表里没有这个 host'
        return $st
    }
    $st.Registered = $true

    try {
        $st.Target = (Get-ItemProperty -Path $HostRegKey -Name '(default)' -ErrorAction Stop).'(default)'
    }
    catch {
        $st.Problem = '注册表项存在但默认值为空'
        return $st
    }
    if (-not $st.Target) {
        $st.Problem = '注册表项存在但默认值为空'
        return $st
    }
    if (-not (Test-Path $st.Target)) {
        $st.Problem = "注册表指向的 manifest 不存在：$($st.Target)"
        return $st
    }

    try {
        $mf = [System.IO.File]::ReadAllText($st.Target, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    catch {
        $st.Problem = "manifest 不是合法 JSON：$($st.Target)"
        return $st
    }

    if (-not $mf.path -or -not (Test-Path $mf.path)) {
        $st.Problem = "manifest 里的 path 不存在：$($mf.path)"
        return $st
    }
    $st.TargetOk = $true

    if (-not $st.ExtensionId) {
        $st.Problem = "读不到扩展 id（$ExtManifest 缺 key 字段？）"
        return $st
    }
    $want = "chrome-extension://$($st.ExtensionId)/"
    $st.OriginOk = ($mf.allowed_origins -contains $want)
    if (-not $st.OriginOk) {
        $st.Problem = "allowed_origins 与扩展 id 不符。应为 $want，实际 $($mf.allowed_origins -join ', ')"
        return $st
    }

    return $st
}

# 打印本机桥状态。就绪返回 $true，否则返回 $false 并说明怎么修
function Show-HostStatus {
    $st = Get-HostStatus
    if ($st.Registered -and $st.TargetOk -and $st.OriginOk) {
        Write-Ok "本机桥已就绪"
        Write-Info "  扩展 id   $($st.ExtensionId)"
        Write-Info "  manifest  $($st.Manifest)"
        return $true
    }
    $why = if ($st.Problem) { $st.Problem } else { '状态不完整' }
    Write-Err "本机桥未就绪：$why"
    Write-Info "  修复：菜单 [2] 注册本机桥，然后**重启浏览器**"
    Write-Info "  没注册时球上只会显示「插件未连接」，与「浏览器没开」长得一样"
    return $false
}

# ── 菜单动作（不再各自 Clear-Host，由主循环统一清屏）────────
function Install-Deps {
    Write-Step "安装项目依赖（Electron 走淘宝镜像）"
    $env:ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/"
    if (-not (Invoke-Npm -NpmArgs @('install') -SuccessMsg "依赖安装完成" -FailMsg "依赖安装失败")) {
        Pause-Return
        return
    }
    # electron 44.x 的 package.json 没有 postinstall 脚本，二进制靠这个 mjs 下载
    $installer = Join-Path $Root '.install_electron.mjs'
    if (Test-Path $installer) {
        Write-Step "下载 Electron 二进制"
        & node $installer
        if ($LASTEXITCODE -eq 0) { Write-Ok "Electron 二进制安装完成" }
        else { Write-Err "Electron 二进制安装失败（退出码 $LASTEXITCODE）" }
    }
    else {
        Write-Info "未找到 .install_electron.mjs，跳过 Electron 二进制下载"
    }
    Pause-Return
}

function Register-Host {
    if (-not (Test-Deps)) { Pause-Return; return }

    $before = Get-HostStatus
    if ($before.Registered -and $before.TargetOk -and $before.OriginOk) {
        Write-Ok "本机桥已经注册好了"
        Write-Info "  扩展 id   $($before.ExtensionId)"
        Write-Info "  manifest  $($before.Manifest)"
        Write-Host ""
        if ($script:BatchMode) { Show-HostStatus | Out-Null; return }
        $again = Read-Host "  仍要重新注册？(y/N)"
        if ($again -ne 'y' -and $again -ne 'Y') { Pause-Return; return }
    }

    # 注册会把当前仓库的绝对路径写进 manifest 与注册表，
    # 所以换目录之后必须重跑 —— 这也是为什么路径不写死在仓库里。
    $null = Invoke-Npm -NpmArgs @('run', 'host:install') -SuccessMsg "已注册 native messaging host" -FailMsg "注册失败"
    Write-Host ""
    $ok = Show-HostStatus
    if ($ok) { Write-Info "  重启浏览器后生效" }
    Pause-Return
}

function Start-Dev {
    if (-not (Test-Deps)) { Pause-Return; return }

    # 球的可用性完全依赖本机桥：没注册的话球上只有一句「插件未连接」，
    # 而那与「浏览器没开」长得一样，会让人往错的方向查。
    $hostOk = Show-HostStatus
    if (-not $hostOk) {
        Write-Host ""
        if ($script:BatchMode) { return }
        $go = Read-Host "  仍要继续启动？(y/N)"
        if ($go -ne 'y' -and $go -ne 'Y') { Pause-Return; return }
    }

    # 端口检查必须在启动之前。strictPort 下 vite 不会换端口，而是直接退出，
    # concurrently 的 -k 又把它整个带停 —— 报出来只有一句 "Port already in use"，
    # 不说谁占着、也不说怎么办。这里提前查出来并给出 PID。
    Write-Host ""
    if (-not (Test-DevPort)) { Pause-Return; return }

    Write-Step "开发环境（Vite + Electron）"
    Write-Info "页面地址 http://localhost:5173（vite.config.mts 中 strictPort: true）"
    Write-Info "两个悬浮球是独立的 Electron 窗口，不在页面里"
    Write-Info "按 Ctrl+C 停止"
    Write-Host ""
    & npm.cmd run electron:dev
    Write-Info "开发环境已退出"
    Pause-Return
}

function Build-Prod {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "三个入口：index.html（主窗口）+ orb/sniff.html + orb/agent.html（两个球）"
    $null = Invoke-Npm -NpmArgs @('run', 'build') -SuccessMsg "构建完成 → dist/" -FailMsg "构建失败"
    Pause-Return
}

function Package-App {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "打包配置来自 package.json 内联 build 字段（appId=com.player.app）"
    $null = Invoke-Npm -NpmArgs @('run', 'electron:build') -SuccessMsg "打包完成" -FailMsg "打包失败"
    Pause-Return
}

function Type-Check {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "两份配置：app（tsconfig.json）与插件（extension/tsconfig.json）"
    $null = Invoke-Npm -NpmArgs @('run', 'typecheck') -SuccessMsg "类型检查通过" -FailMsg "发现类型错误"
    Pause-Return
}

function Build-Extension {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "产物在 extension\dist\"
    Write-Info "chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension\dist"
    Write-Info "不要选 extension\ —— 那是源码目录，里面没有 manifest.json"
    $null = Invoke-Npm -NpmArgs @('run', 'ext:build') -SuccessMsg "插件构建完成" -FailMsg "插件构建失败"
    Pause-Return
}

function Run-Tests {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "test/index.js 的全部套件：引擎 / 桥契约 / 插件产物 / Agent 工具 / 搜索…"
    $null = Invoke-Npm -NpmArgs @('run', 'test:spg') -SuccessMsg "全部通过" -FailMsg "存在失败用例"
    Pause-Return
}

# 只清理本项目的构建产物。不碰 node_modules（其中的 .vite 只是缓存，会自动重建），
# 也不碰用户数据（悬浮球位置、Agent 对话历史都在 %APPDATA% 下，与仓库无关）。
function Clean-Build {
    Write-Step "清理构建产物"
    $found = $false
    foreach ($t in @('dist', 'dist-electron', 'release', 'extension\dist', 'test\build')) {
        $p = Join-Path $Root $t
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force
            Write-Ok "$t 已删除"
            $found = $true
        }
    }
    if (-not $found) { Write-Info "没有需要清理的内容" }
    Write-Info "extension\dist 删掉后需要重新构建，并在浏览器里重新加载扩展"
    Pause-Return
}

# ── 启动检查 ────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Root 'package.json'))) {
    Write-Err "未找到 package.json，无法确定项目根目录：$Root"
    Write-Err "请在项目目录（the-play）内运行本脚本"
    exit 1
}
$EnvLine = Get-EnvLine
if (-not $EnvLine) { exit 1 }

# ── 非交互：跑单个动作后退出 ────────────────────────────────
if ($script:BatchMode) {
    switch ($Action) {
        'deps'       { Install-Deps }
        'host'       { Register-Host }
        'host-check' { $null = Show-HostStatus }
        'dev'        { Start-Dev }
        'build'      { Build-Prod }
        'package'    { Package-App }
        'typecheck'  { Type-Check }
        'ext'        { Build-Extension }
        'test'       { Run-Tests }
        'clean'      { Clean-Build }
    }
    # host-check 要能把结果反映到退出码，否则脚本里没法拿它当判据
    if ($Action -eq 'host-check') {
        $st = Get-HostStatus
        if ($st.Registered -and $st.TargetOk -and $st.OriginOk) { exit 0 } else { exit 1 }
    }
    exit 0
}

# ── 主菜单循环 ──────────────────────────────────────────────
while ($true) {
    Clear-Host
    Write-Host ""
    Write-Host "The Play · 开发助手" -ForegroundColor Cyan
    Write-Info $EnvLine
    # 本机桥的状态直接影响球能不能用，所以放在主界面上而不是藏进菜单
    $st = Get-HostStatus
    if ($st.Registered -and $st.TargetOk -and $st.OriginOk) {
        Write-Info "本机桥已注册 · 扩展 id $($st.ExtensionId)"
    }
    else {
        Write-Err "本机桥未注册 —— 悬浮球会一直显示「插件未连接」（菜单 [2] 修复）"
    }
    Write-Host ("─" * 64) -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1  安装依赖        6  类型检查"
    Write-Host "  2  注册本机桥      7  插件构建"
    Write-Host "  3  开发环境        8  跑全部测试"
    Write-Host "  4  构建生产版本    9  清理产物"
    Write-Host "  5  打包应用        0  退出"
    Write-Host ""

    $choice = Read-Host " 请选择操作"
    switch ($choice) {
        '1' { Install-Deps }
        '2' { Register-Host }
        '3' { Start-Dev }
        '4' { Build-Prod }
        '5' { Package-App }
        '6' { Type-Check }
        '7' { Build-Extension }
        '8' { Run-Tests }
        '9' { Clean-Build }
        '0' {
            Write-Host ""
            Write-Host " 再见！" -ForegroundColor Cyan
            Start-Sleep -Milliseconds 400
            exit 0
        }
        default {
            Write-Err "无效选择，请重新输入"
            Start-Sleep -Seconds 1
        }
    }
}
