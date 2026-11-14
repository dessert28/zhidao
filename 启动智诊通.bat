@echo off
chcp 65001 >nul
title Zhidao Dev Server
cd /d "%~dp0frontend"
echo.
echo ============================================
echo   Zhidao - Patient Triage System
echo ============================================
echo.
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node.js 18+
    pause
    exit /b 1
)
if not exist "node_modules\" (
    echo [ERROR] Run pnpm install in frontend first.
    pause
    exit /b 1
)
if exist ".env" (echo   LLM : .env found, real model enabled) else (echo   LLM : no .env, rule-routing)
echo.
echo   URL  : http://localhost:5173
echo   Stop : Ctrl+C
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='http://localhost:5173/'; for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; if($r.StatusCode -eq 200){Start-Process $u; break}}catch{}; Start-Sleep -Milliseconds 1000}"
echo   Starting...
node "node_modules\vite\bin\vite.js"
echo.
echo   Server stopped.
pause
