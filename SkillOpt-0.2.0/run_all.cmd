@echo off
REM ============================================================
REM  SkillOpt one-click launcher (double-click friendly).
REM  Wraps run_all.ps1, keeps this window open when it finishes,
REM  and prints the real exit code from logs\last_run.status.
REM  All arguments are forwarded to run_all.ps1, e.g.:
REM      run_all.cmd -Smoke -Venv
REM ============================================================

setlocal
chcp 65001 >nul 2>nul
set "HERE=%~dp0"
set "SCRIPT=%HERE%run_all.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] run_all.ps1 not found next to this file:
    echo         %SCRIPT%
    echo.
    pause
    exit /b 1
)

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

echo Launching SkillOpt pipeline: %SCRIPT%
echo.

REM -NoPause here: this wrapper owns the "keep window open" behaviour.
%PS% -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -NoPause %*

set "CODE=%ERRORLEVEL%"
if exist "%HERE%logs\last_run.status" for /f "usebackq delims=" %%i in ("%HERE%logs\last_run.status") do set "CODE=%%i"

echo.
echo ============================================================
echo  Pipeline finished. Exit code: %CODE%
echo  Logs: %HERE%logs\
echo  Window stays open. Press any key to close.
echo ============================================================
pause >nul
endlocal
