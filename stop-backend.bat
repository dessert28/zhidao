@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

title Zhidao - stop backend

rem ============================================================
rem  Stop the Zhidao Spring Boot backend (the java process on 8080).
rem
rem  Why this exists: stop-dev.bat only handles the Vite frontend.
rem  Its default ports (5173/5174/4173) do not include 8080, and it
rem  deliberately kills node processes only -- the backend is
rem  "java.exe", so it is always skipped there.
rem
rem  The real logic lives in scripts\stop-backend.ps1:
rem  a java process is only killed when its command line also
rem  contains this project's path, so other java services are safe.
rem
rem  Usage:
rem    double-click                stop the backend on 8080
rem    stop-backend.bat 8081       check another port
rem    stop-backend.bat --dry-run  list what would be killed
rem    stop-backend.bat --force    also kill whatever holds the port
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads a batch file
rem  byte by byte in the current ANSI code page; non-ASCII text
rem  here breaks parsing sooner or later.
rem ============================================================

set "SCRIPT=%~dp0scripts\stop-backend.ps1"
set "ARGS="
set "RC=0"
set "ARGS_GIVEN=0"
if not "%~1"=="" set "ARGS_GIVEN=1"

:parse
if "%~1"=="" goto run
if /i "%~1"=="--dry-run" (set "ARGS=!ARGS! -DryRun" & shift & goto parse)
if /i "%~1"=="/n"        (set "ARGS=!ARGS! -DryRun" & shift & goto parse)
if /i "%~1"=="--force"   (set "ARGS=!ARGS! -Force"  & shift & goto parse)
if /i "%~1"=="/f"        (set "ARGS=!ARGS! -Force"  & shift & goto parse)
if /i "%~1"=="--help"    goto help
if /i "%~1"=="/?"        goto help
if /i "%~1"=="-h"        goto help
rem anything else is treated as a port number
echo %~1| findstr /R "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo.
  echo   [ERROR] unknown argument: %~1
  echo           expected: a port number, --dry-run, --force or --help
  echo.
  goto badarg
)
set "ARGS=!ARGS! -Port %~1"
shift
goto parse

:help
echo.
echo   Stop the Zhidao backend (Spring Boot, default port 8080)
echo.
echo     stop-backend.bat                stop the backend on 8080
echo     stop-backend.bat 8081           check another port
echo     stop-backend.bat --dry-run      list only, kill nothing
echo     stop-backend.bat --force        also kill non-project processes
echo.
echo   Only java processes whose command line points at this project
echo   are killed. The frontend is handled by stop-dev.bat.
echo.
goto end

:run
if not exist "%SCRIPT%" (
    echo.
    echo   [ERROR] scripts\stop-backend.ps1 is missing.
    echo           Make sure the project was not partially copied.
    echo.
    goto badarg
)

where powershell >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [ERROR] PowerShell not found.
    echo           This script needs Windows PowerShell 5.1 or later.
    echo.
    goto badarg
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" !ARGS!
set "RC=%ERRORLEVEL%"
goto end

:badarg
set "RC=1"

:end
rem keep the window when double-clicked; exit straight when called with args
if "%ARGS_GIVEN%"=="0" pause
endlocal & exit /b %RC%
