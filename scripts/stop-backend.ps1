#Requires -Version 5.1
<#
  智诊通 · 停止后端（Spring Boot / Maven）

  由 stop-backend.bat 调用，一般不需要直接运行。

  为什么要单独一个脚本？
    stop-dev.bat 只管 Vite 前端，而且它明确只杀名字含 node 的进程。
    后端是 mvn spring-boot:run 拉起来的 java 进程，名字是 java.exe，
    不在它的处理范围内（默认端口里也没有 8080）。这个脚本补上这一块。

  识别规则（宁可漏杀，不误杀）：
    只处理 java.exe / javaw.exe，且必须同时满足
      1) 命令行里出现本项目根目录的绝对路径
      2) 命令行看起来像后端（spring-boot:run / ZhidaoApplication /
         backend\target / backend\pom.xml）
    这样不会碰到别的 java 服务（比如另一个项目的 Spring Boot）。

  参数：
    -Port 8080    要检查的端口，默认 8080
    -DryRun       只列出会被杀的进程，不动手
    -Force        端口被非本项目进程占用时，也一并杀掉
#>
param(
    [int]$Port = 8080,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'SilentlyContinue'

# 输出被重定向/管道时，控制台那段用 GBK 编码没人看得懂；改成 UTF-8。
# 直接双击运行的场景不受影响，仍是中文控制台默认代码页。
if ([Console]::IsOutputRedirected) {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
}

# ---------------------------------------------------------------- 输出小工具

function Head($t) {
    Write-Host ''
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 56)) -ForegroundColor DarkGray
}
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X]    $m" -ForegroundColor Red }
function Hint($m) { Write-Host "         $m" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 基本信息

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = (Get-Location).ProviderPath }
$root = $root.TrimEnd('\')

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '   智诊通 · 停止后端服务' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Hint "项目目录: $root"
Hint "后端端口: $Port"
if ($DryRun) { Write-Host '   [dry-run] 只列出，不会真的杀进程' -ForegroundColor Yellow }

# ---------------------------------------------------------------- 采集

function Get-ListenerPids([int]$p) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return @() }
    return @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
}

Head '扫描进程'

$ours = @()
$cands = Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue
foreach ($c in @($cands)) {
    $cmd = $c.CommandLine
    # 读不到命令行的进程（权限不足）直接跳过，交给 -Force 分支处理
    if ([string]::IsNullOrEmpty($cmd)) { continue }
    if ($cmd.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }

    $looksBackend =
        ($cmd    -match 'spring-boot:run')      -or
        ($cmd    -match 'ZhidaoApplication')    -or
        ($cmd    -match '(?i)backend[\\/]target') -or
        ($cmd    -match '(?i)backend[\\/]pom\.xml')
    if (-not $looksBackend) { continue }

    $ours += [pscustomobject]@{
        Pid  = [int]$c.ProcessId
        Name = $c.Name
        Cmd  = $cmd
    }
}

if ($ours.Count -eq 0) {
    Write-Host "  没有找到本项目的后端进程（java + 本项目路径）"
} else {
    foreach ($o in $ours) {
        $tail = $o.Cmd
        if ($tail.Length -gt 110) { $tail = '...' + $tail.Substring($tail.Length - 110) }
        Write-Host "  [project] $($o.Name) (pid $($o.Pid))"
        Hint $tail
    }
}

# 端口上的监听者：可能不属于本项目
$listenerPids = Get-ListenerPids $Port
$extra = @()
foreach ($lp in $listenerPids) {
    if ($ours | Where-Object { $_.Pid -eq $lp }) { continue }
    $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$lp" -ErrorAction SilentlyContinue
    $nm = if ($pr) { $pr.Name } else { 'unknown' }
    $extra += [pscustomobject]@{ Pid = [int]$lp; Name = $nm }
}

if ($extra.Count -gt 0) {
    foreach ($e in $extra) {
        if ($Force) {
            Warn "端口 $Port 上的 $($e.Name) (pid $($e.Pid)) 不属于本项目，但因为 --force 会被杀掉"
        } else {
            Warn "端口 $Port 上的 $($e.Name) (pid $($e.Pid)) 不属于本项目，跳过（要杀请加 --force）"
        }
    }
}

# ---------------------------------------------------------------- 动手

Head '停止'

$targets = @()
$targets += $ours
if ($Force) { $targets += $extra }

if ($targets.Count -eq 0) {
    Write-Host '  没有需要停止的进程'
} else {
    foreach ($t in $targets) {
        if ($DryRun) {
            Write-Host "  would kill $($t.Name) (pid $($t.Pid))"
            continue
        }
        try {
            Stop-Process -Id $t.Pid -Force -ErrorAction Stop
            Write-Host "  killed $($t.Name) (pid $($t.Pid))" -ForegroundColor Green
        } catch {
            Fail "killing $($t.Name) (pid $($t.Pid)) failed - try running as administrator"
        }
    }
}

# ---------------------------------------------------------------- 复查

if (-not $DryRun -and $targets.Count -gt 0) {
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-ListenerPids $Port).Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
}

Head '结果'

$still = Get-ListenerPids $Port
if ($DryRun) {
    Hint 'dry-run 结束，什么都没改。'
} elseif ($still.Count -eq 0) {
    Ok "端口 $Port 已释放"
    Hint '现在可以重新启动后端：启动智诊通.bat'
} else {
    Fail "端口 $Port 仍被 PID $($still -join ', ') 占用"
    Hint '可能不是本项目进程：用 stop-backend.bat --force，或在管理员终端里重试'
    exit 1
}

Write-Host ''
exit 0
