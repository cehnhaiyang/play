#Requires -Version 5.1
<#
  The Play — 开发辅助脚本

  用法：
    .\.ps1                     在项目根目录直接运行
    powershell -File .ps1      显式指定 Windows PowerShell
    双击 .bat                  以 UTF-8 读入后执行

  注意：本机未安装 PowerShell 7（无 pwsh），只能用 powershell.exe 5.1。

  菜单动作与 package.json scripts 的对应：
    [1] 安装依赖      npm install + .install_electron.mjs（经淘宝镜像下载 Electron 二进制）
    [2] 开发环境      npm run electron:dev   （concurrently: vite + electron）
    [3] 构建生产版本  npm run build          （vite build → dist/）
    [4] 打包应用      npm run electron:build （vite build && electron-builder）
    [5] 类型检查      npx tsc --noEmit
    [6] 图集工具      node scripts/gallery.js
    [7] 清理产物      dist / dist-electron / release

  需要跑测试时直接用命令行（本机测试是硬要求，不放进交互菜单）：
    npm run test:spg          主进程/引擎/搜索等 9 个套件的单元与静态回归
    npm run test:proxy-sync   代理设置的跨进程同步
    npm run test:ui           界面回归（自动起 vite + Electron 截图断言布局）
#>

# ── 基础设置 ────────────────────────────────────────────────
$Host.UI.RawUI.WindowTitle = "The Play — 开发助手"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

# 定位项目根目录：优先取脚本自身所在目录。
# 经 .bat 的 Scriptblock::Create 路径执行时 $PSScriptRoot 为空，
# 回退到当前目录（.bat 已先 cd /d "%~dp0"）。
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $Root

# ── 输出辅助（前缀统一 3 列，便于左对齐）────────────────────
function Write-Step([string]$Msg) { Write-Host "[·] $Msg" -ForegroundColor Yellow }
function Write-Ok([string]$Msg)   { Write-Host "[✓] $Msg" -ForegroundColor Green }
function Write-Err([string]$Msg)  { Write-Host "[✗] $Msg" -ForegroundColor Red }
function Write-Info([string]$Msg) { Write-Host "[i] $Msg" -ForegroundColor DarkGray }
function Pause-Return { Write-Host ""; Read-Host "按回车键返回菜单" }

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

function Start-Dev {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Step "开发环境（Vite + Electron）"
    Write-Info "页面地址 http://localhost:5173（vite.config.ts 中 strictPort: true）"
    Write-Info "按 Ctrl+C 停止"
    Write-Host ""
    & npm.cmd run electron:dev
    Write-Info "开发环境已退出"
    Pause-Return
}

function Build-Prod {
    if (-not (Test-Deps)) { Pause-Return; return }
    Invoke-Npm -NpmArgs @('run', 'build') -SuccessMsg "构建完成 → dist/" -FailMsg "构建失败"
    Pause-Return
}

function Package-App {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Info "打包配置来自 package.json 内联 build 字段（appId=com.player.app）"
    Invoke-Npm -NpmArgs @('run', 'electron:build') -SuccessMsg "打包完成" -FailMsg "打包失败"
    Pause-Return
}

function Type-Check {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Step "TypeScript 类型检查（tsc --noEmit）"
    & npm.cmd exec -- tsc --noEmit
    if ($LASTEXITCODE -ne 0) { Write-Err "发现类型错误（退出码 $LASTEXITCODE）" }
    else { Write-Ok "类型检查通过" }
    Pause-Return
}

function Invoke-Gallery {
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Step "图集工具（scripts/gallery.js）"
    Write-Info "用法  npm run gallery -- <id|url> [--pages 1-5] [--dry-run]"
    Write-Info "示例  npm run gallery -- 761277 --pages 1-5"
    Write-Host ""
    & node (Join-Path $Root 'scripts\gallery.js') --help
    Pause-Return
}

# 只清理本项目的构建产物。不碰 node_modules（其中的 .vite 只是缓存，会自动重建）。
function Clean-Build {
    Write-Step "清理构建产物"
    $found = $false
    foreach ($t in @('dist', 'dist-electron', 'release')) {
        $p = Join-Path $Root $t
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force
            Write-Ok "$t 已删除"
            $found = $true
        }
    }
    if (-not $found) { Write-Info "没有需要清理的内容" }
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

# ── 主菜单循环 ──────────────────────────────────────────────
while ($true) {
    Clear-Host
    Write-Host ""
    Write-Host "The Play · 开发助手" -ForegroundColor Cyan
    Write-Info $EnvLine
    Write-Host ("─" * 64) -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1  安装依赖       5  类型检查"
    Write-Host "  2  开发环境       6  图集工具"
    Write-Host "  3  构建生产版本   7  清理产物"
    Write-Host "  4  打包应用       0  退出"
    Write-Host ""

    $choice = Read-Host " 请选择操作"
    switch ($choice) {
        '1' { Install-Deps }
        '2' { Start-Dev }
        '3' { Build-Prod }
        '4' { Package-App }
        '5' { Type-Check }
        '6' { Invoke-Gallery }
        '7' { Clean-Build }
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
