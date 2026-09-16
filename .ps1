#Requires -Version 5.1
<#
  The Play — 开发辅助脚本

  用法：
    pwsh -File .ps1      或      .\.ps1
    双击 .bat 也会调用本脚本（以 UTF-8 读入后执行）

  与 package.json 中的实际脚本对齐（2026-09-15 核对）：
    npm run dev             仅启动 Vite Web 开发服务器（不进 Electron）
    npm run electron:dev    Vite + Electron 开发模式
    npm run build           Vite 生产构建（输出 dist/）
    npm run preview         预览生产构建（默认 http://localhost:4173）
    npm run electron:build  打包（vite build && electron-builder → release/ 或 dist/）
    npm run gallery         图集 CLI（node scripts/gallery.js，需带参数）
  注意：package.json 当前没有 lint 脚本，类型检查请用菜单 [7]（npx tsc --noEmit）。
#>

# ── 基础设置 ────────────────────────────────────────────────
$Host.UI.RawUI.WindowTitle = "The Play — 开发助手"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
# 定位项目根目录：优先取脚本自身所在目录；
# 若脚本是以管道/粘贴等方式执行（此时 $PSScriptRoot 为空），回退到当前目录。
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $Root          # 无论从哪个目录调用，都回到项目根目录

# ── 输出辅助 ────────────────────────────────────────────────
function Write-Step([string]$Msg) { Write-Host "[步骤] $Msg" -ForegroundColor Yellow }
function Write-Ok([string]$Msg)   { Write-Host "[✓] $Msg" -ForegroundColor Green }
function Write-Err([string]$Msg)  { Write-Host "[✗] $Msg" -ForegroundColor Red }
function Pause-Return { Write-Host ""; Read-Host "按回车键返回菜单" }

# 按终端显示宽度居中文本（中文按 2 列计宽）
function Center-Text([string]$Text, [int]$Width) {
    $cells = 0
    foreach ($ch in $Text.ToCharArray()) {
        if ([int]$ch -gt 0x2E7F) { $cells += 2 } else { $cells += 1 }
    }
    if ($cells -ge $Width) { return $Text }
    $pad = [math]::Floor(($Width - $cells) / 2)
    return (' ' * $pad) + $Text + (' ' * ($Width - $cells - $pad))
}

function Show-Banner {
    $w = 60
    Write-Host " ╔$('═' * $w)╗" -ForegroundColor Cyan
    Write-Host " ║$(Center-Text 'The Play · 开发助手' $w)║" -ForegroundColor Cyan
    Write-Host " ║$(Center-Text 'React Advanced Player' $w)║" -ForegroundColor DarkCyan
    Write-Host " ╚$('═' * $w)╝" -ForegroundColor Cyan
}

# ── 环境 / 依赖检查 ────────────────────────────────────────
function Test-Environment {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm  = Get-Command npm  -ErrorAction SilentlyContinue
    if (-not $node) { Write-Err "未找到 Node.js，请先安装 https://nodejs.org/"; return $false }
    if (-not $npm)  { Write-Err "未找到 npm，请检查 Node.js 安装"; return $false }
    Write-Ok "Node.js $(node --version)  |  npm $(npm --version)"
    return $true
}

function Test-Deps {
    $nodeModules = Join-Path $Root 'node_modules'
    if (-not (Test-Path $nodeModules)) {
        Write-Err "未找到 node_modules，请先执行 [1] 安装依赖"
        return $false
    }
    return $true
}

# 执行 npm 命令；显式调用 npm.cmd 以确保 $LASTEXITCODE 可靠。
# 注意：必须用 -NpmArgs 具名传参。直接写 Invoke-Npm @('run','build')
# 会把 'build' 误绑到 SuccessMsg 上（数组 splat 按位置绑定），导致
# “参数指定了两次”或静默传错参数。单元素 @('install') 碰巧能跑，
# 多元素必错，故统一具名调用。
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

# ── 菜单动作 ────────────────────────────────────────────────
function Install-Deps {
    Clear-Host
    Write-Step "安装项目依赖（Electron 使用淘宝镜像）"
    $env:ELECTRON_MIRROR = "https://cdn.npmmirror.com/binaries/electron/"
    if (Invoke-Npm -NpmArgs @('install') -SuccessMsg "依赖安装完成" -FailMsg "依赖安装失败") {
        $installer = Join-Path $Root '.install_electron.mjs'
        if (Test-Path $installer) {
            Write-Step "下载 Electron 二进制"
            & node $installer
            if ($LASTEXITCODE -eq 0) { Write-Ok "Electron 二进制安装完成" }
            else { Write-Err "Electron 二进制安装失败（退出码 $LASTEXITCODE）" }
        }
        else {
            Write-Host " [信息] 未找到 .install_electron.mjs，跳过 Electron 二进制下载" -ForegroundColor DarkGray
        }
    }
    Pause-Return
}

function Start-Dev {
    Clear-Host
    Write-Host "`n [开发模式] Vite + Electron" -ForegroundColor Yellow
    Write-Host "  • 页面地址: http://localhost:5173（见 vite.config.ts，strictPort: true）"
    Write-Host "  • 按 Ctrl+C 停止开发环境`n"
    if (-not (Test-Deps)) { Pause-Return; return }
    & npm.cmd run electron:dev
    Write-Host "`n [信息] 开发环境已退出" -ForegroundColor DarkGray
    Pause-Return
}

function Start-WebDev {
    Clear-Host
    Write-Host "`n [开发模式] 仅 Vite Web（不进 Electron）" -ForegroundColor Yellow
    Write-Host "  • 页面地址: http://localhost:5173"
    Write-Host "  • 按 Ctrl+C 停止`n"
    if (-not (Test-Deps)) { Pause-Return; return }
    & npm.cmd run dev
    Write-Host "`n [信息] Web 开发服务器已退出" -ForegroundColor DarkGray
    Pause-Return
}

function Build-Prod {
    Clear-Host
    Write-Step "编译生产版本（输出目录: dist/）"
    if (-not (Test-Deps)) { Pause-Return; return }
    Invoke-Npm -NpmArgs @('run', 'build') -SuccessMsg "构建完成 → dist/" -FailMsg "构建失败"
    Pause-Return
}

function Preview-Prod {
    Clear-Host
    Write-Step "预览生产构建（默认 http://localhost:4173）"
    if (-not (Test-Deps)) { Pause-Return; return }
    if (-not (Test-Path (Join-Path $Root 'dist\index.html'))) {
        Write-Err "dist/ 不存在，请先执行 [4] 构建生产版本"
        Pause-Return
        return
    }
    Invoke-Npm -NpmArgs @('run', 'preview') -SuccessMsg "预览已退出" -FailMsg "预览失败"
    Pause-Return
}

function Package-App {
    Clear-Host
    Write-Step "打包应用程序（electron-builder）"
    if (-not (Test-Deps)) { Pause-Return; return }
    Write-Host "  • 打包配置来自 package.json 内联 build 字段（appId=com.player.app）" -ForegroundColor DarkGray
    Write-Host "  • 输出目录以 electron-builder 实际配置为准（常见为 release/ 或 dist/）" -ForegroundColor DarkGray
    Invoke-Npm -NpmArgs @('run', 'electron:build') -SuccessMsg "打包完成" -FailMsg "打包失败"
    Pause-Return
}

function Type-Check {
    Clear-Host
    # package.json 当前没有 lint 脚本，直接调 tsc，避免 `npm run lint` 报 Missing script。
    # 如需 npm run lint，请在 package.json scripts 中加："lint": "tsc --noEmit"。
    Write-Step "TypeScript 类型检查（npx tsc --noEmit）"
    if (-not (Test-Deps)) { Pause-Return; return }
    & npm.cmd exec -- tsc --noEmit
    if ($LASTEXITCODE -ne 0) {
        Write-Err "发现类型错误（退出码 $LASTEXITCODE）"
    }
    else {
        Write-Ok "类型检查通过"
    }
    Pause-Return
}

function Invoke-Gallery {
    Clear-Host
    Write-Host "`n [图库工具] node scripts/gallery.js" -ForegroundColor Yellow
    Write-Host "  • 用法示例: 761277 / 761277 --pages 1-5 / <url> --dry-run"
    Write-Host "  • 完整帮助: node scripts/gallery.js --help`n"
    if (-not (Test-Deps)) { Pause-Return; return }
    $arg = Read-Host " 输入图集参数（直接回车只显示帮助）"
    if ([string]::IsNullOrWhiteSpace($arg)) {
        & node (Join-Path $Root 'scripts\gallery.js') --help
    }
    else {
        # 简单按空格切分，满足 id / url / --pages 等常规用法
        $parts = ($arg -split '\s+') | Where-Object { $_ -ne '' }
        & node (Join-Path $Root 'scripts\gallery.js') @parts
        if ($LASTEXITCODE -ne 0) {
            Write-Err "gallery 执行失败（退出码 $LASTEXITCODE）"
        }
        else {
            Write-Ok "gallery 执行完成"
        }
    }
    Pause-Return
}

function Clean-Build {
    Clear-Host
    Write-Step "清理构建产物"
    $found = $false
    foreach ($t in @('dist', 'dist-electron', 'release', 'node_modules\.vite')) {
        $p = Join-Path $Root $t
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force
            Write-Ok "$t 已删除"
            $found = $true
        }
    }
    if (-not $found) { Write-Host " [信息] 没有需要清理的内容" -ForegroundColor DarkGray }
    Pause-Return
}

# ── 启动检查 ────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Root 'package.json'))) {
    Write-Err "未找到 package.json，无法确定项目根目录：$Root"
    Write-Err "请在项目目录（the-play）内运行本脚本"
    exit 1
}
if (-not (Test-Environment)) { exit 1 }

# ── 主菜单循环 ──────────────────────────────────────────────
while ($true) {
    Clear-Host
    Write-Host ""
    Show-Banner
    Write-Host ""
    Write-Host "  [1] 安装依赖（淘宝镜像 + Electron 二进制）"
    Write-Host "  [2] 启动开发环境（Vite + Electron）"
    Write-Host "  [3] 仅启动 Vite Web（不进 Electron）"
    Write-Host "  [4] 构建生产版本（vite build → dist/）"
    Write-Host "  [5] 预览生产版本（vite preview）"
    Write-Host "  [6] 打包应用程序（electron-builder）"
    Write-Host "  [7] 类型检查（tsc --noEmit）"
    Write-Host "  [8] 图集工具（scripts/gallery.js）"
    Write-Host "  [9] 清理构建文件（dist / dist-electron / release / .vite）"
    Write-Host "  [0] 退出"
    Write-Host ""
    Write-Host " ════════════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host ""

    $choice = Read-Host " 请选择操作"
    switch ($choice) {
        '1' { Install-Deps }
        '2' { Start-Dev }
        '3' { Start-WebDev }
        '4' { Build-Prod }
        '5' { Preview-Prod }
        '6' { Package-App }
        '7' { Type-Check }
        '8' { Invoke-Gallery }
        '9' { Clean-Build }
        '0' {
            Write-Host "`n 再见！" -ForegroundColor Cyan
            Start-Sleep -Milliseconds 600
            exit 0
        }
        default {
            Write-Err "无效选择，请重新输入"
            Start-Sleep -Seconds 1
        }
    }
}
