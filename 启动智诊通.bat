@echo off
title Zhidao Dev Server
cd /d "%~dp0frontend"
echo.
echo ============================================
echo   Zhidao - Patient Triage System
echo ============================================
echo.
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)
if not exist "node_modules\" (
    echo [ERROR] Dependencies missing. Run: pnpm install  in the frontend folder
    pause
    exit /b 1
)
if exist ".env" (echo   LLM      : .env found, real model enabled) else (echo   LLM      : no .env, rule-routing mode)
echo.
echo   Frontend : http://localhost:5173
echo   Backend  : http://localhost:8080  optional, needed for records page
echo   Stop     : Ctrl+C in this window
echo.

REM ============================================================
REM  Backend is OPTIONAL. Without it the AI chat still works;
REM  the records page will just show a "backend not started" notice.
REM
REM  Edit these two paths for your machine:
set "JAVA_HOME=D:\tools\jdk17"
set "MVN=D:\tools\maven\bin\mvn.cmd"
REM ============================================================

set "BACKEND_OK=0"
if exist "%~dp0backend\pom.xml" if exist "%JAVA_HOME%\bin\java.exe" if exist "%MVN%" set "BACKEND_OK=1"

if "%BACKEND_OK%"=="1" (
    echo   Starting backend in a separate window...
    start "Zhidao Backend" /D "%~dp0backend" cmd /k "set JAVA_HOME=%JAVA_HOME%&& %MVN% -B spring-boot:run"
) else (
    echo   [skip] backend not started - records page will show a notice
    echo          if you need it: cd backend ^&^& mvn spring-boot:run
)

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='http://localhost:5173/'; for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; if($r.StatusCode -eq 200){Start-Process $u; break}}catch{}; Start-Sleep -Milliseconds 1000}"
echo   Starting frontend...
node "node_modules\vite\bin\vite.js"
echo.
echo   Server stopped.
pause
