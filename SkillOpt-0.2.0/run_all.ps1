<#
.SYNOPSIS
    SkillOpt 一键运行脚本：安装 -> 凭据 -> 数据 -> 训练 -> 评估。

.DESCRIPTION
    在 Windows PowerShell 下按顺序完成 SkillOpt 的完整流程：

      [1/6] 环境预检   校验 Python 3.10+、配置文件与项目目录
      [2/6] 环境与依赖 可选创建 .venv，并按 benchmark 自动安装对应 pip extras
      [3/6] 凭据配置   读取/生成 .env，加载 API 凭据并做可用性检查
      [4/6] 数据准备   SearchQA 自动物化 split；其他 benchmark 检查 split_dir 完整性
      [5/6] 训练       打印规模预告并停下等确认（回车继续 / 输入 n 取消 / -Yes 跳过），
                       然后运行 scripts/train.py，产物写入 outputs\<RunName>\
      [6/6] 评估       scripts/eval_only.py，评估 best_skill.md 并输出分数

    前置工作（1-4：依赖、凭据、数据）都是安全动作，可以自动完成；真正会发起模型
    请求的是第 5 步，所以默认在这里停下等你确认，不会不经同意就开始烧请求。

    常用姿势：
      .\run_all.ps1 -InitOnly                     # 第一次：只生成 .env，填好 key 再跑
      .\run_all.ps1 -Smoke -Venv                  # 冒烟：8 条样本快速验证全流程
      .\run_all.ps1                               # 正式：SearchQA 完整流程
      .\run_all.ps1 -Config configs/docvqa/default.yaml -SkipInstall
      .\run_all.ps1 -SkipTrain -RunName searchqa_20260928_101010   # 只评估已有运行

    如果被执行策略拦住，用：
      powershell -ExecutionPolicy Bypass -File .\run_all.ps1

    运行日志会写入 logs\run_all_<时间戳>.log（结束时打印路径），闪退也能事后查因。
    双击运行请用同目录的 run_all.cmd；在交互式窗口里跑会在结束时暂停（-NoPause 关闭暂停）。

.PARAMETER Config
    YAML 配置路径（相对项目根），默认 configs/searchqa/local.yaml
    （本地 OpenAI 兼容端点 http://127.0.0.1:7863/v1 + global:deepseek-v4.1-flash）。

.PARAMETER RunName
    本次运行目录名，产物写入 outputs\<RunName>。默认为 <benchmark>_<时间戳>。

.PARAMETER EvalSplit
    训练后评估使用哪个 split：test（默认）/ valid_seen / valid_unseen / val / train / all。

.PARAMETER Venv
    使用项目内 .venv 虚拟环境（不存在则创建）；之后所有 python/pip 调用都走它。

.PARAMETER Smoke
    冒烟模式：1 epoch、8 条训练样本、4 条评估样本，快速确认整条链路可用。

.PARAMETER DryRun
    只做检查并打印将要执行的命令，不安装、不写文件、不训练、不评估。

.PARAMETER InitOnly
    生成 .env 模板后立即退出（首次使用）。

.PARAMETER SkipInstall
    跳过 pip 安装步骤。

.PARAMETER SkipEnvCheck
    跳过 .env 与 API 凭据检查（凭据由系统环境变量/其他方式提供时使用）。

.PARAMETER SkipData
    跳过数据准备步骤。

.PARAMETER SkipTrain
    跳过训练步骤；配合 -RunName 可直接评估此前的运行目录。

.PARAMETER SkipEval
    跳过训练后的评估步骤。

.PARAMETER WithWebUI
    额外安装 webui（Gradio 监控面板）依赖。

.PARAMETER Extras
    额外追加的 pip extras，例如 -Extras claude,qwen。

.PARAMETER TrainArgs
    透传给 scripts/train.py 的额外参数，例如：
      -TrainArgs '--backend','azure_openai','--num_epochs','2'

.PARAMETER EvalArgs
    透传给 scripts/eval_only.py 的额外参数。

.PARAMETER Pause
    脚本结束时暂停等待回车（双击运行 .ps1 或在独立窗口运行时使用，避免窗口一闪而过）。

.PARAMETER NoPause
    强制不暂停（脚本会在结束时自动暂停，此项用于覆盖，例如在 CI / 计划任务中）。

.PARAMETER Yes
    跳过"开始训练前的确认"，前置工作完成后直接开跑。
    默认行为是：装依赖 / 检查凭据 / 物化数据（安全的前置动作）→ 打印规模预告 →
    停下等回车确认；在非交互环境（输出重定向、CI）下必须显式加 -Yes 才会开跑。

.EXAMPLE
    .\run_all.ps1 -InitOnly

.EXAMPLE
    .\run_all.ps1 -Smoke -Venv

.EXAMPLE
    .\run_all.ps1 -Yes -Smoke

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\run_all.ps1 -Config configs/searchqa/default.yaml
#>
[CmdletBinding()]
param(
    [string]   $Config    = "configs/searchqa/local.yaml",
    [string]   $RunName   = "",
    [ValidateSet("all", "train", "test", "val", "valid_seen", "valid_unseen")]
    [string]   $EvalSplit = "test",
    [switch]   $Venv,
    [switch]   $Smoke,
    [switch]   $DryRun,
    [switch]   $InitOnly,
    [switch]   $SkipInstall,
    [switch]   $SkipEnvCheck,
    [switch]   $SkipData,
    [switch]   $SkipTrain,
    [switch]   $SkipEval,
    [switch]   $WithWebUI,
    [switch]   $Pause,
    [switch]   $NoPause,
    [switch]   $Yes,
    [string[]] $Extras    = @(),
    [string[]] $TrainArgs = @(),
    [string[]] $EvalArgs  = @()
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 定位项目根 ──────────────────────────────────────────────────────────────
$ProjectRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location -LiteralPath $ProjectRoot

$script:TotalSteps = 6
$script:StepIndex  = 0
$script:PyExe      = "python"
$script:PyPrefix   = @()
$script:Warnings   = New-Object System.Collections.Generic.List[string]
$script:EvalHard   = $null
$script:EvalSoft   = $null
$script:EvalCount  = $null
$script:ExitCode   = 0
$script:TranscriptPath    = ""
$script:TranscriptStarted = $false

# 结束时是否暂停：显式 -Pause 优先；否则交互式控制台默认暂停；-NoPause 强制关闭
$script:InteractiveConsole = -not ([Console]::IsOutputRedirected)
$script:PauseOnExit = (-not $NoPause) -and ($Pause -or $script:InteractiveConsole)
$EvalSplitExplicit = $PSBoundParameters.ContainsKey("EvalSplit")

# ── 输出辅助 ────────────────────────────────────────────────────────────────
function Write-Section([string]$Title) {
    $script:StepIndex++
    Write-Host ""
    Write-Host ("-" * 68) -ForegroundColor DarkGray
    Write-Host ("  [{0}/{1}] {2}" -f $script:StepIndex, $script:TotalSteps, $Title) -ForegroundColor Cyan
    Write-Host ("-" * 68) -ForegroundColor DarkGray
}
function Write-Info([string]$Message)  { Write-Host "    $Message" }
function Write-Pass([string]$Message)  { Write-Host "    [OK]   $Message" -ForegroundColor Green }
function Write-Note([string]$Message)  { Write-Host "    [提示] $Message" -ForegroundColor Yellow }
function Write-Bad([string]$Message)   { Write-Host "    [错误] $Message" -ForegroundColor Red }
function Write-SkipMsg([string]$Message) { Write-Host "    [跳过] $Message" -ForegroundColor DarkGray }
function Add-Warning([string]$Message) { [void]$script:Warnings.Add($Message) }

# ── Python 解析 / 调用 ──────────────────────────────────────────────────────
function Resolve-BasePython {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @{ Exe = "python"; Prefix = @() }
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @{ Exe = "py"; Prefix = @("-3") }
    }
    throw "未找到 Python。请安装 Python 3.10+ 并确保 python 或 py 在 PATH 中。"
}

function Get-PythonVersion([string]$Exe, [string[]]$Prefix) {
    # 用 --version 而非 -c 内联代码，避免 PowerShell 5.1 原生命令传参时的引号问题
    $out = & $Exe @($Prefix + @("--version")) 2>&1
    if (-not $out) { return "" }
    $text = ($out | Select-Object -Last 1).ToString().Trim()
    $m = [regex]::Match($text, '(\d+)\.(\d+)\.(\d+)')
    if (-not $m.Success) { return "" }
    return $m.Value
}

function Test-PythonVersion([string]$Version) {
    if (-not $Version) { return $false }
    $parts = $Version.Split(".")
    if ($parts.Count -lt 2) { return $false }
    $major = [int]$parts[0]; $minor = [int]$parts[1]
    return ($major -gt 3) -or ($major -eq 3 -and $minor -ge 10)
}

function Invoke-Py {
    param(
        [Parameter(Mandatory = $true)][string[]]$PyArgs,
        [switch]$AllowFailure
    )
    $full    = @($script:PyPrefix) + $PyArgs
    $display = "{0} {1}" -f $script:PyExe, ($full -join " ")
    Write-Host "    > $display" -ForegroundColor DarkGray
    & $script:PyExe @full | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "命令执行失败（退出码 $code）：$display"
    }
    return $code
}

# ── .env 与配置解析 ─────────────────────────────────────────────────────────
function Import-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)
    $loaded = 0
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith("#")) { continue }
        if ($line -match '^export\s+(.+)$') { $line = $Matches[1].Trim() }
        $eq = $line.IndexOf("=")
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $val = $line.Substring($eq + 1).Trim()
        $hash = $val.IndexOf(" #")
        if ($hash -ge 0) { $val = $val.Substring(0, $hash).Trim() }
        if ($val.Length -ge 2) {
            $first = $val.Substring(0, 1); $last = $val.Substring($val.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        if ($val -eq "") { continue }   # 空值不覆盖已存在的环境变量
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($key, $val, "Process")
            $loaded++
        }
    }
    return $loaded
}

function Get-ConfigField {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $visited = @{}
    while ($Path) {
        if (-not (Test-Path -LiteralPath $Path)) { break }
        $Path = (Resolve-Path -LiteralPath $Path).Path
        if ($visited.ContainsKey($Path)) { break }
        $visited[$Path] = $true

        $raw = Get-Content -LiteralPath $Path -Raw
        $baseRel = $null
        $bm = [regex]::Match($raw, '(?m)^\s*_base_:\s*(.+?)\s*$')
        if ($bm.Success) { $baseRel = $bm.Groups[1].Value.Trim().Trim('"').Trim("'") }

        $pattern = '(?m)^\s*' + [regex]::Escape($Key) + ':\s*(.*)$'
        $m = [regex]::Match($raw, $pattern)
        if ($m.Success) {
            $val = ($m.Groups[1].Value -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
            if ($val -ne "") { return $val }
        }
        if (-not $baseRel) { break }
        $Path = Join-Path (Split-Path -Parent $Path) $baseRel
    }
    return ""
}

function Get-CredentialFound {
    $found = @()
    foreach ($name in @("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_AUTH_MODE", "OPENAI_API_KEY",
                        "ANTHROPIC_API_KEY", "MINIMAX_API_KEY", "QWEN_CHAT_BASE_URL")) {
        if ([Environment]::GetEnvironmentVariable($name, "Process")) { $found += $name }
    }
    return $found
}

# ── 运行日志与收尾 ──────────────────────────────────────────────────────────
function Start-RunLog {
    $logDir = Join-Path $ProjectRoot "logs"
    try {
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $script:TranscriptPath = Join-Path $logDir ("run_all_{0}.log" -f $stamp)
        Start-Transcript -Path $script:TranscriptPath -Force | Out-Null
        $script:TranscriptStarted = $true
    } catch {
        $script:TranscriptStarted = $false
        $script:TranscriptPath = ""
    }
}

function Complete-Run([int]$Code) {
    $script:ExitCode = $Code
    Write-Host ""
    Write-Host ("  退出码：{0}" -f $Code) -ForegroundColor DarkGray
    if ($script:TranscriptPath) {
        Write-Host ("  完整日志：{0}" -f $script:TranscriptPath) -ForegroundColor DarkGray
    }
    if ($script:TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
        $script:TranscriptStarted = $false
    }
    # 写状态文件，供 run_all.cmd / CI 读取真实退出码
    try {
        $statusDir = Join-Path $ProjectRoot "logs"
        if (-not (Test-Path -LiteralPath $statusDir)) {
            New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
        }
        Set-Content -LiteralPath (Join-Path $statusDir "last_run.status") -Value $Code -Encoding ASCII
    } catch { }
    if ($script:PauseOnExit) {
        Write-Host ""
        try { Read-Host "  按回车键关闭窗口" | Out-Null } catch { }
    }
}

function Show-ScalePreview {
    $numEpochs = Get-ConfigField -Path $ConfigPath -Key "num_epochs"
    $batchSize = Get-ConfigField -Path $ConfigPath -Key "batch_size"
    $trainSize = Get-ConfigField -Path $ConfigPath -Key "train_size"
    $selNum    = Get-ConfigField -Path $ConfigPath -Key "sel_env_num"
    $testNum   = Get-ConfigField -Path $ConfigPath -Key "test_env_num"
    $workers   = Get-ConfigField -Path $ConfigPath -Key "workers"
    $analysts  = Get-ConfigField -Path $ConfigPath -Key "analyst_workers"

    $stepsText = "$numEpochs epochs（步数按数据集自动推导）"
    if ($numEpochs -match '^\d+$' -and $batchSize -match '^\d+$' -and $trainSize -match '^\d+$' `
            -and [int]$batchSize -gt 0 -and [int]$trainSize -gt 0) {
        $spe = [math]::Ceiling([int]$trainSize / [int]$batchSize)
        $stepsText = "{0} epochs x {1} steps/epoch = {2} 步" -f $numEpochs, $spe, ([int]$numEpochs * $spe)
    }
    $selText  = if ($selNum -eq "0" -or -not $selNum) { "selection 集全量" } else { "selection 集 $selNum 条" }
    $testText = if ($testNum -eq "0" -or -not $testNum) { "test 集全量" } else { "test 集 $testNum 条" }

    Write-Host ""
    Write-Info "规模预告（训练启动后会立即并发调用模型，先看清体量）："
    Write-Info ("  训练 : {0}；每步 rollout {1} 条，反思并发 {2}" -f $stepsText, $batchSize, $analysts)
    Write-Info ("  验证 : 启动时 baseline + 每步门控评估 {0}（评估并发 {1}）" -f $selText, $workers)
    Write-Info ("  测试 : 结束时评估 {0} x 3 轮（baseline / best / final）" -f $testText)
    Write-Info ""
    Write-Info "  压小规模：-Smoke，或"
    Write-Info "    -TrainArgs '--num_epochs','1','--train_size','80','--batch_size','8','--sel_env_num','20','--test_env_num','40','--analyst_workers','4'"
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
Start-RunLog
try {
    Write-Host ""
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    Write-Host "  SkillOpt 一键运行" -ForegroundColor Cyan
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    $modeText = if ($DryRun) { "DryRun（只检查，不改动）" } elseif ($Smoke) { "Smoke（冒烟）" } else { "完整流程" }
    Write-Host ("  项目根 : {0}" -f $ProjectRoot)
    Write-Host ("  配置   : {0}" -f $Config)
    Write-Host ("  模式   : {0}" -f $modeText)

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "pyproject.toml"))) {
        throw "当前目录不是 SkillOpt 项目根（缺少 pyproject.toml）。请把脚本放在项目根或在其目录内运行。"
    }

    # ── [1/6] 环境预检 ──────────────────────────────────────────────────────
    Write-Section "环境预检"

    if (-not (Test-Path -LiteralPath $Config)) { throw "配置文件不存在：$Config" }
    $ConfigPath = (Resolve-Path -LiteralPath $Config).Path
    Write-Pass "配置文件：$ConfigPath"

    $benchmark = Split-Path -Leaf (Split-Path -Parent $ConfigPath)
    Write-Info "benchmark：$benchmark"

    $base = Resolve-BasePython
    $baseVer = Get-PythonVersion -Exe $base.Exe -Prefix $base.Prefix
    if (-not (Test-PythonVersion -Version $baseVer)) {
        throw "需要 Python 3.10+，当前检测到：$baseVer（$($base.Exe)）"
    }
    Write-Pass "系统 Python：$baseVer（$($base.Exe)）"
    $script:PyExe    = $base.Exe
    $script:PyPrefix = $base.Prefix

    # ── [2/6] 环境与依赖 ────────────────────────────────────────────────────
    Write-Section "Python 环境与依赖"

    if ($Venv) {
        $venvDir = Join-Path $ProjectRoot ".venv"
        $venvPy  = Join-Path $venvDir "Scripts\python.exe"
        if (-not (Test-Path -LiteralPath $venvPy)) {
            if ($DryRun) {
                Write-Info "[DryRun] 将创建虚拟环境：$venvDir"
            } else {
                Invoke-Py -PyArgs @("-m", "venv", ".venv") | Out-Null
                Write-Pass "已创建虚拟环境：$venvDir"
            }
        }
        if (Test-Path -LiteralPath $venvPy) {
            $script:PyExe    = $venvPy
            $script:PyPrefix = @()
            $venvVer = Get-PythonVersion -Exe $venvPy -Prefix @()
            Write-Pass "虚拟环境 Python：$venvVer"
        }
    } else {
        Write-Info "未启用 -Venv，使用系统 Python（加 -Venv 可隔离到 .venv）"
    }

    $extras = @()
    if ($benchmark -eq "searchqa")  { $extras += "searchqa" }
    if ($benchmark -eq "alfworld")  { $extras += "alfworld" }
    if ($WithWebUI)                 { $extras += "webui" }
    $extras += $Extras
    $extras = @($extras | Where-Object { $_ } | Select-Object -Unique)

    $installTarget = "."
    if ($extras.Count -gt 0) { $installTarget = ".[" + ($extras -join ",") + "]" }

    if ($SkipInstall) {
        Write-SkipMsg "已指定 -SkipInstall"
    } elseif ($DryRun) {
        Write-Info "[DryRun] 将执行：python -m pip install -e $installTarget"
    } else {
        Invoke-Py -PyArgs @("-m", "pip", "install", "--disable-pip-version-check", "-e", $installTarget) | Out-Null
        Write-Pass "依赖安装完成：pip install -e $installTarget"
    }

    # ── [3/6] 凭据与 .env ───────────────────────────────────────────────────
    Write-Section "凭据与 .env 配置"

    $envFile    = Join-Path $ProjectRoot ".env"
    $envExample = Join-Path $ProjectRoot ".env.example"

    if ($SkipEnvCheck) {
        Write-SkipMsg "已指定 -SkipEnvCheck"
    } else {
        if (-not (Test-Path -LiteralPath $envFile)) {
            if (Test-Path -LiteralPath $envExample) {
                if ($DryRun) {
                    Write-Info "[DryRun] 将从 .env.example 生成 .env"
                } else {
                    Copy-Item -LiteralPath $envExample -Destination $envFile -Force
                    Write-Pass "已从 .env.example 生成 .env"
                }
            } else {
                Write-Note "未找到 .env / .env.example，将仅使用系统环境变量。"
            }
        } else {
            $loadedCount = Import-DotEnv -Path $envFile
            Write-Pass "已加载 .env（$loadedCount 个非空变量）"
        }

        if ($InitOnly) {
            Write-Host ""
            Write-Note "请编辑 .env 填入 API 凭据（AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY 等），然后重新运行本脚本。"
            Complete-Run -Code 0
            return
        }

        $found = @(Get-CredentialFound)
        $cfgKey = Get-ConfigField -Path $ConfigPath -Key "azure_openai_api_key"
        if ($cfgKey) { $found += "config:model.azure_openai_api_key" }

        if ($found.Count -eq 0) {
            $envEndpoint = [Environment]::GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT", "Process")
            $envKey      = [Environment]::GetEnvironmentVariable("AZURE_OPENAI_API_KEY", "Process")
            $hint = @()
            if ($envEndpoint) {
                $hint += "AZURE_OPENAI_ENDPOINT = $envEndpoint"
                if ($envEndpoint -match 'your-resource') { $hint += "  该值看起来仍是模板占位值，需要替换成你自己的 Azure 资源地址" }
            }
            if (-not $envKey) { $hint += "AZURE_OPENAI_API_KEY 为空" }

            if ($DryRun) {
                Write-Note "未检测到 API 凭据（DryRun 继续）。"
            } else {
                Write-Bad "未检测到可用的 API 凭据，已停止（窗口不会关闭）。"
                foreach ($h in $hint) { Write-Info $h }
                Write-Info ""
                Write-Info "请编辑 $envFile 后重新运行，例如："
                Write-Info "  AZURE_OPENAI_ENDPOINT=https://<你的资源名>.openai.azure.com/"
                Write-Info "  AZURE_OPENAI_API_KEY=<你的 key>"
                Write-Info "也可以改用 OPENAI_API_KEY / ANTHROPIC_API_KEY，或加 -SkipEnvCheck 自行管理凭据。"
                Complete-Run -Code 1
                return
            }
        } else {
            Write-Pass ("检测到凭据：" + ($found -join "、"))
        }
    }

    # ── [4/6] 数据准备 ──────────────────────────────────────────────────────
    Write-Section "数据准备"

    if ($SkipData) {
        Write-SkipMsg "已指定 -SkipData"
    } else {
        $canonicalSplits = @("train", "val", "test")
        $splitRel = Get-ConfigField -Path $ConfigPath -Key "split_dir"
        $missing = @()
        $splitAbs = ""

        if (-not $splitRel) {
            Write-Note "配置未声明 split_dir（可能用 split_mode=ratio + data_path 自动切分），跳过检查。"
        } else {
            if ([System.IO.Path]::IsPathRooted($splitRel)) { $splitAbs = $splitRel }
            else { $splitAbs = Join-Path $ProjectRoot $splitRel }

            foreach ($s in $canonicalSplits) {
                $p = Join-Path $splitAbs (Join-Path $s "items.json")
                if (-not (Test-Path -LiteralPath $p)) { $missing += $s }
            }

            if ($missing.Count -eq 0) {
                Write-Pass "split 就绪：$splitAbs"
            } else {
                Write-Note ("split 缺失 [{0}]：{1}" -f ($missing -join ", "), $splitAbs)

                if ($benchmark -eq "searchqa") {
                    if ($DryRun) {
                        Write-Info "[DryRun] 将执行：python scripts/materialize_searchqa.py"
                    } else {
                        Write-Info "开始物化 SearchQA 数据（首次需从 HuggingFace 下载，请耐心等待）..."
                        Invoke-Py -PyArgs @("-u", "scripts/materialize_searchqa.py") | Out-Null
                        Write-Pass "SearchQA 数据已写入：$splitAbs"
                    }
                } elseif ($benchmark -eq "alfworld") {
                    $aw = [Environment]::GetEnvironmentVariable("ALFWORLD_DATA", "Process")
                    if (-not $aw) {
                        Write-Note "ALFWorld 需要先执行 alfworld-download 并设置 ALFWORLD_DATA 环境变量。"
                    } else {
                        Write-Note "已检测到 ALFWORLD_DATA=$aw，请确认其中包含 json_2.1.1。"
                    }
                    Add-Warning "ALFWorld 数据需手动准备（见 data/README.md）。"
                } else {
                    Write-Note "该 benchmark 数据需手动物化（见 data/README.md）。"
                    Add-Warning "$benchmark 数据可能不完整：$splitAbs"
                }
            }
        }
    }

    # ── 运行目录 ────────────────────────────────────────────────────────────
    if (-not $RunName) {
        if ($SkipTrain) {
            throw "指定了 -SkipTrain 但未提供 -RunName，无法定位要评估的运行目录。"
        }
        $RunName = "{0}_{1}" -f $benchmark, (Get-Date -Format "yyyyMMdd_HHmmss")
    }
    $RunDir   = Join-Path $ProjectRoot (Join-Path "outputs" $RunName)
    $bestSkill = Join-Path $RunDir "best_skill.md"

    # ── [5/6] 训练 ──────────────────────────────────────────────────────────
    Write-Section "训练"

    if ($SkipTrain) {
        Write-SkipMsg "已指定 -SkipTrain"
    } elseif ($DryRun) {
        Show-ScalePreview
        Write-Info "[DryRun] 将执行：python -u scripts/train.py --config $ConfigPath --out_root $RunDir"
    } else {
        Write-Info "运行目录：$RunDir"
        Show-ScalePreview
        if ((Test-Path -LiteralPath $RunDir) -and (Get-ChildItem -LiteralPath $RunDir -Force | Select-Object -First 1)) {
            Write-Note "运行目录已存在且非空，训练产物会写入/覆盖该目录。"
        }

        # ── 确认闸门：前置工作已完成，开跑前停下等确认 ──────────────────
        Write-Host ""
        Write-Info "前置工作已完成（依赖 / 凭据 / 数据），下面这一步才会真正发起模型请求。"
        $proceed = $true
        if ($Yes) {
            Write-Info "已指定 -Yes，跳过确认，直接开始训练。"
        } elseif ($script:InteractiveConsole) {
            $answer = Read-Host "    按回车开始训练（训练结束后会自动评估）；输入 n 取消"
            if ($answer -match '^\s*n(o)?\s*$') { $proceed = $false }
        } else {
            $proceed = $false
            Write-Note "当前是非交互环境（输出被重定向），为避免意外消耗请求，已在此停下。"
            Write-Note "确认无误后加 -Yes 重新运行，例如：.\run_all.ps1 -Yes"
        }

        if (-not $proceed) {
            Write-Host ""
            Write-Info "已取消：未发起任何训练或评估请求。"
            Write-Info "前置成果会保留（依赖已安装、数据已物化），下次运行会自动跳过。"
            Complete-Run -Code 0
            return
        }

        $trainCmd = @("scripts/train.py", "--config", $ConfigPath, "--out_root", $RunDir)
        if ($Smoke) {
            $trainCmd += @("--num_epochs", "1", "--train_size", "8", "--batch_size", "8",
                           "--analyst_workers", "2", "--max_analyst_rounds", "1",
                           "--sel_env_num", "4", "--test_env_num", "4",
                           "--edit_budget", "1", "--min_edit_budget", "1",
                           "--use_slow_update", "false", "--use_meta_skill", "false",
                           "--eval_test", "false")
        }
        $trainCmd += $TrainArgs

        Invoke-Py -PyArgs (@("-u") + $trainCmd) | Out-Null
        Write-Pass "训练完成"

        if (Test-Path -LiteralPath $bestSkill) {
            Write-Pass "最优技能：$bestSkill"
        } else {
            Write-Note "未找到 best_skill.md，请检查上方训练日志。"
            Add-Warning "训练目录中没有 best_skill.md：$RunDir"
        }
    }

    # ── [6/6] 评估 ──────────────────────────────────────────────────────────
    Write-Section "评估"

    if ($SkipEval) {
        Write-SkipMsg "已指定 -SkipEval"
    } elseif ($DryRun) {
        Write-Info "[DryRun] 将执行：python -u scripts/eval_only.py --config $ConfigPath --skill $bestSkill --split $EvalSplit"
    } elseif (-not (Test-Path -LiteralPath $bestSkill)) {
        Write-Note "缺少 best_skill.md，跳过评估：$bestSkill"
        Add-Warning "未执行评估：找不到 $bestSkill"
    } else {
        $evalSplit = $EvalSplit
        if ($Smoke -and -not $PSBoundParameters.ContainsKey("EvalSplit")) { $evalSplit = "valid_seen" }

        $evalOut  = Join-Path $RunDir ("eval_" + ($evalSplit -replace '[\\/:*?"<>|]', "_"))
        $evalCmd  = @("scripts/eval_only.py", "--config", $ConfigPath, "--skill", $bestSkill,
                      "--split", $evalSplit, "--out_root", $evalOut)
        if ($Smoke) { $evalCmd += @("--test_env_num", "4") }
        $evalCmd += $EvalArgs

        Write-Info "评估 split：$evalSplit"
        Write-Info "评估产物：$evalOut"
        Invoke-Py -PyArgs (@("-u") + $evalCmd) | Out-Null
        Write-Pass "评估完成"

        $summaryPath = Join-Path $evalOut "eval_summary.json"
        if (Test-Path -LiteralPath $summaryPath) {
            $sum = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
            $script:EvalHard  = $sum.hard
            $script:EvalSoft  = $sum.soft
            $script:EvalCount = $sum.n_items
        }
    }

    # ── 汇总 ────────────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    Write-Host "  完成" -ForegroundColor Cyan
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    Write-Host ("  运行目录 : {0}" -f $RunDir)
    if (Test-Path -LiteralPath $bestSkill) {
        Write-Host ("  最优技能 : {0}" -f $bestSkill)
    }
    if ($null -ne $script:EvalHard) {
        Write-Host ("  评估结果 : hard={0:F4}  soft={1:F4}  (n={2}, split={3})" -f `
            $script:EvalHard, $script:EvalSoft, $script:EvalCount, $(if ($Smoke -and -not $EvalSplitExplicit) { "valid_seen" } else { $EvalSplit }))
    }
    if ($script:Warnings.Count -gt 0) {
        Write-Host ""
        Write-Host "  提醒：" -ForegroundColor Yellow
        foreach ($w in $script:Warnings) { Write-Host "    - $w" -ForegroundColor Yellow }
    }
    Write-Host ""
    Write-Host "  后续可用命令："
    Write-Host "    python scripts/eval_only.py --config $Config --skill `"$bestSkill`" --split all"
    Write-Host "    python -m skillopt_webui.app            # 需先 pip install -e `".[webui]`""
    Write-Host "    skillopt-sleep run                      # 夜间自进化（Claude Code / Codex）"
    Write-Host ""
    Complete-Run -Code 0
    return
}
catch {
    Write-Host ""
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    Write-Bad $_.Exception.Message
    Write-Host "  已中止。修正问题后可重复运行本脚本（已完成的步骤会自动跳过/复用）。" -ForegroundColor Red
    $stack = $_.ScriptStackTrace
    if ($stack) {
        Write-Host ("  出错位置：{0}" -f (($stack -split "`r?`n") | Select-Object -First 1)) -ForegroundColor DarkGray
    }
    Write-Host ("=" * 68) -ForegroundColor DarkGray
    Complete-Run -Code 1
}
