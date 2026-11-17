@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

title Zhidao - stop dev servers

rem ============================================================
rem  Kill leftover Vite dev / preview servers.
rem
rem  Why: when "pnpm dev" is not stopped with Ctrl+C (terminal
rem  window closed, task killed in the IDE, started in background
rem  from a script), the Vite process keeps holding the port.
rem  Next "pnpm dev" then silently moves to 5174 while the browser
rem  still shows 5173 -- and after editing tailwind.config.js the
rem  old process keeps serving the old utility classes, so the page
rem  looks like "all styles are gone".
rem
rem  Usage:
rem    double-click              stop 5173 / 5174 / 4173
rem    stop-dev.bat 5173 8080    stop the given ports
rem    stop-dev.bat --dry-run    list listeners, change nothing
rem    stop-dev.bat --force      also kill non-node processes
rem
rem  Safety: only node processes are killed by default. The java
rem  backend on 8080 is skipped -- killing someone else's service
rem  costs more than typing --force once.
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses a
rem  batch file byte by byte in the current ANSI code page, so non
rem  ASCII text here breaks parsing (or breaks later, after someone
rem  re-saves the file as UTF-8). Keep it ASCII.
rem ============================================================

set "DEFAULT_PORTS=5173 5174 4173"
set "PORTS="
set "DRYRUN=0"
set "FORCE=0"
set "ARGS_GIVEN=0"
if not "%~1"=="" set "ARGS_GIVEN=1"

:parse
if "%~1"=="" goto run
if /i "%~1"=="--dry-run" (set "DRYRUN=1" & shift & goto parse)
if /i "%~1"=="/n"       (set "DRYRUN=1" & shift & goto parse)
if /i "%~1"=="--force"  (set "FORCE=1"  & shift & goto parse)
if /i "%~1"=="/f"       (set "FORCE=1"  & shift & goto parse)
if /i "%~1"=="--help"   goto help
if /i "%~1"=="/?"       goto help
if "!PORTS!"=="" (set "PORTS=%~1") else (set "PORTS=!PORTS! %~1")
shift
goto parse

:help
echo.
echo   Stop leftover dev servers
echo.
echo     stop-dev.bat                ports: %DEFAULT_PORTS%
echo     stop-dev.bat 5173 8080      stop the given ports
echo     stop-dev.bat --dry-run      list listeners only
echo     stop-dev.bat --force        also kill non-node processes
echo.
goto end

:run
if "%PORTS%"=="" set "PORTS=%DEFAULT_PORTS%"

echo.
echo   Stop dev servers
echo   ports: %PORTS%
if "%DRYRUN%"=="1" echo   [dry-run] nothing will be killed
echo.

set /a CLOSED=0
set /a SKIPPED=0
set /a FAILED=0
set "SEEN="

for %%P in (%PORTS%) do call :oneport %%P

rem Windows releases the port a second late; re-checking at once lies.
rem use the absolute path: Git for Windows / scoop keep a *nix "timeout"
rem and "ping" on PATH, and cmd would pick those up first.
if not "%DRYRUN%"=="1" if !CLOSED! GTR 0 (
  if exist "%SystemRoot%\System32\timeout.exe" (
    "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak >nul 2>&1
  ) else (
    "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul 2>&1
  )
)

echo.
rem the leftover check only makes sense after actually killing something
if not "%DRYRUN%"=="1" (
  set "LEFTOVER="
  for %%P in (%PORTS%) do (
    netstat -ano | findstr /C:":%%P " | findstr /I "LISTENING" >nul && set "LEFTOVER=!LEFTOVER! :%%P"
  )
  if not "!LEFTOVER!"=="" (
    echo   WARN:!LEFTOVER! still listening - a process may need admin rights.
    set /a FAILED+=1
  )
)

if "%DRYRUN%"=="1" (
  echo   dry-run done, nothing changed.
) else (
  echo   done: closed !CLOSED!, skipped !SKIPPED!, failed !FAILED!.
  if !CLOSED! GTR 0 echo   you can run "pnpm dev" again.
)

goto end

rem ---------------------------------------------------------- one port

:oneport
set "PORT=%~1"
set "ANY=0"
for /f "tokens=5" %%A in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /I "LISTENING"') do (
  set "ANY=1"
  call :killpid %%A %PORT%
)
if "!ANY!"=="0" echo   :%PORT%  free
goto :eof

rem ------------------------------------------------------- one process

:killpid
set "PID=%~1"
set "PORT=%~2"
if "%PID%"=="0" goto :eof

rem the same PID can hold both an IPv4 and an IPv6 listener - kill once
echo %SEEN% | findstr /C:" %PID% " >nul && goto :eof
set "SEEN=%SEEN% %PID% "

set "NAME=unknown"
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %PID%" /FO CSV /NH 2^>nul') do set "NAME=%%~N"
if /i "%NAME%"=="unknown" (
  echo   :%PORT%  pid %PID% is gone already
  goto :eof
)

set "ISNODE=0"
echo %NAME% | findstr /I /C:"node" >nul && set "ISNODE=1"
if "%ISNODE%"=="0" if not "%FORCE%"=="1" (
  echo   :%PORT%  %NAME% ^(pid %PID%^) is not node - skipped ^(use --force^)
  set /a SKIPPED+=1
  goto :eof
)

if "%DRYRUN%"=="1" (
  echo   :%PORT%  %NAME% ^(pid %PID%^) would be killed
  goto :eof
)

rem /T kills the child tree: pnpm -^> node -^> vite is a chain, and
rem killing only the top one leaves orphans holding the port
taskkill /PID %PID% /F /T >nul 2>&1
if errorlevel 1 (
  echo   :%PORT%  killing %NAME% ^(pid %PID%^) failed - try admin shell
  set /a FAILED+=1
) else (
  echo   :%PORT%  killed %NAME% ^(pid %PID%^)
  set /a CLOSED+=1
)
goto :eof

:end
rem keep the window when double-clicked; exit straight when called with args
if "%ARGS_GIVEN%"=="0" pause
endlocal
