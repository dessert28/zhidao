@echo off
REM ============================================================
REM  Zhidao launcher (Windows)
REM
REM  This file only does one thing: hand over to PowerShell.
REM  All real logic lives in scripts\start.ps1 (UTF-8, Chinese output).
REM
REM  Why not implement everything here?
REM    - chcp 65001 inside a .bat can silently abort the script
REM    - goto inside an if(...) block exits the whole script
REM    - Chinese text in .bat depends on the console code page
REM  PowerShell has none of these problems.
REM ============================================================

setlocal
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] PowerShell not found.
    echo         This launcher needs Windows PowerShell 5.1 or later.
    echo.
    pause
    exit /b 1
)

if not exist "scripts\start.ps1" (
    echo.
    echo [ERROR] scripts\start.ps1 is missing.
    echo         Make sure the project was not partially copied.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1"

if errorlevel 1 (
    echo.
    echo [ERROR] Launcher exited with an error. See messages above.
    echo.
    pause
)

endlocal
