@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$script = [System.IO.File]::ReadAllText('.\.ps1', [System.Text.Encoding]::UTF8); Invoke-Command -ScriptBlock ([Scriptblock]::Create($script))"
if %errorlevel% neq 0 pause