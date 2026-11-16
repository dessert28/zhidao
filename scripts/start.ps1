# ============================================================
#  智诊通 · 一键启动（Windows / PowerShell）
#
#  设计原则：不硬编码任何本机路径，全部运行时探测。
#  换一台电脑，只要装了 Node 就能起前端；
#  装了 JDK 17 + Maven 会自动带起后端。
# ============================================================

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Line { Write-Host ('  ' + ('-' * 56)) -ForegroundColor DarkGray }
function Head($t) { Write-Host ''; Write-Host "  $t" -ForegroundColor Cyan; Line }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]    $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  [X]    $t" -ForegroundColor Red }
function Hint($t) { Write-Host "         $t" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Green
Write-Host '   智诊通 · 患者端智能导诊系统' -ForegroundColor Green
Write-Host '  ============================================' -ForegroundColor Green

# ---------- 1. Node ----------
Head '检查运行环境'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Fail '未找到 Node.js'
    Hint '前端必须依赖 Node.js 18 或更高版本'
    Hint '下载：https://nodejs.org/zh-cn/download'
    Hint '安装后请重开一个命令行窗口，再运行本脚本'
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
}

$nodeVer = (& node -v).Trim()
$major = 0
if ($nodeVer -match 'v(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 18) {
    Fail "Node.js 版本过低：$nodeVer（需要 18+）"
    Hint '请升级后重试'
} else {
    Ok "Node.js $nodeVer"
}

# ---------- 2. pnpm ----------
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
    Warn '未找到 pnpm，尝试用 Node 自带的 corepack 启用'
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        try {
            & corepack enable pnpm 2>&1 | Out-Null
            & corepack prepare pnpm@9.15.0 --activate 2>&1 | Out-Null
        } catch { }
        $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($pnpmCmd) { Ok '已通过 corepack 启用 pnpm' }
    }
}
if ($pnpmCmd) {
    Ok "pnpm $(& pnpm -v)"
} else {
    Warn 'pnpm 不可用，改用 npx 执行（首次会稍慢）'
}

# ---------- 3. 前端依赖 ----------
$feDir = Join-Path $root 'frontend'
$nodeModules = Join-Path $feDir 'node_modules'

if (-not (Test-Path $nodeModules)) {
    Warn '前端依赖未安装，正在自动安装（首次约 1-3 分钟）'
    Push-Location $feDir
    if ($pnpmCmd) { & pnpm install } else { & npx --yes pnpm@9 install }
    $installCode = $LASTEXITCODE
    Pop-Location
    if ($installCode -ne 0) {
        Fail '依赖安装失败'
        Hint '请手动执行：cd frontend 然后 pnpm install'
        Write-Host ''
        Read-Host '按回车退出'
        exit 1
    }
    Ok '依赖安装完成'
} else {
    Ok '前端依赖已就绪'
}

# ---------- 4. JDK ----------
<#
  为什么要扫描常见安装目录：
  实测发现，"装了 JDK 但没配 JAVA_HOME、也没进 PATH" 极为常见。
  用户双击脚本看到「未找到 JDK」，会以为脚本坏了。
  所以除了环境变量，还要主动去几个最可能的位置找一找。
#>
function Find-JavaExe {
    $cands = @()
    if ($env:JAVA_HOME) { $cands += (Join-Path $env:JAVA_HOME 'bin\java.exe') }

    $jcmd = Get-Command java -ErrorAction SilentlyContinue
    if ($jcmd) { $cands += $jcmd.Source }

    $globs = @(
        'C:\Program Files\Java\jdk*\bin\java.exe',
        'C:\Program Files\Eclipse Adoptium\jdk*\bin\java.exe',
        'C:\Program Files\Microsoft\jdk*\bin\java.exe',
        'C:\Program Files\Amazon Corretto\jdk*\bin\java.exe',
        'C:\Program Files\Zulu\zulu*\bin\java.exe',
        'C:\Program Files (x86)\Java\jdk*\bin\java.exe',
        'C:\tools\jdk*\bin\java.exe',
        'D:\tools\jdk*\bin\java.exe',
        'C:\ProgramData\chocolatey\lib\*\jdk*\bin\java.exe',
        "$env:USERPROFILE\.jdks\*\bin\java.exe",
        "$env:USERPROFILE\scoop\apps\openjdk*\current\bin\java.exe"
    )
    foreach ($g in $globs) {
        $hit = Get-Item $g -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { $cands += $hit.FullName }
    }

    foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) {
            # 只接受 17+ 的版本
            $line = (& $c -version 2>&1 | Select-Object -First 1)
            $jv = 0
            if ($line -match 'version "1\.(\d+)') { $jv = [int]$Matches[1] }
            elseif ($line -match 'version "(\d+)') { $jv = [int]$Matches[1] }
            if ($jv -ge 17) { return @{ Path = $c; Version = $jv } }
        }
    }
    return $null
}

$javaInfo = Find-JavaExe
$jdkOk = $false
if ($javaInfo) {
    $jdkOk = $true
    $javaExe = $javaInfo.Path
    Ok "JDK $($javaInfo.Version)"
    # 用绝对路径反推 JAVA_HOME，供后端子进程使用
    if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $javaExe)
        Hint "已自动推导 JAVA_HOME = $env:JAVA_HOME"
    }
} else {
    Warn '未找到 JDK 17 —— 后端不启动'
    Hint '前端仍可使用问诊、健康管家、就诊摘要'
    Hint '需要病历与预约页时，装 JDK 17：https://adoptium.net/'
    Hint '（装完不必手动配置，脚本会自动找）'
}

# ---------- 5. Maven ----------
<#
  同样要扫常见目录。实测中 Maven 装在 D:\tools\maven 但没进 PATH
  是最典型的情况 —— 用户以为自己装了，脚本却报"未找到"。
#>
function Find-MavenExe {
    $cands = @()
    if ($env:MVN) { $cands += $env:MVN }
    if ($env:MAVEN_HOME) { $cands += (Join-Path $env:MAVEN_HOME 'bin\mvn.cmd') }
    $mcmd = Get-Command mvn -ErrorAction SilentlyContinue
    if ($mcmd) { $cands += $mcmd.Source }

    $globs = @(
        (Join-Path $root '.tools\apache-maven\bin\mvn.cmd'),
        'C:\Program Files\Apache\maven\bin\mvn.cmd',
        'C:\Program Files\Apache Software Foundation\apache-maven-*\bin\mvn.cmd',
        'C:\Program Files\apache-maven-*\bin\mvn.cmd',
        'C:\apache-maven-*\bin\mvn.cmd',
        'C:\tools\maven\bin\mvn.cmd',
        'C:\tools\apache-maven-*\bin\mvn.cmd',
        'D:\tools\maven\bin\mvn.cmd',
        'D:\tools\apache-maven-*\bin\mvn.cmd',
        'D:\apache-maven-*\bin\mvn.cmd',
        'E:\tools\maven\bin\mvn.cmd',
        "$env:USERPROFILE\apache-maven-*\bin\mvn.cmd",
        "$env:USERPROFILE\scoop\apps\maven\current\bin\mvn.cmd",
        'C:\ProgramData\chocolatey\bin\mvn.exe'
    )
    foreach ($g in $globs) {
        if (Test-Path $g) {
            $hit = Get-Item $g -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    return $null
}

$mvnExe = Find-MavenExe
if ($mvnExe) {
    Ok 'Maven 已找到'
    Hint $mvnExe
} else {
    Warn '未找到 Maven —— 后端不启动'
    Hint '安装 Maven 3.9+：https://maven.apache.org/download.cgi'
    Hint '或把解压后的目录放到 .tools\apache-maven，脚本会自动识别'
    Hint '（装完不必配置环境变量，脚本会自动找常见位置）'
}

# ---------- 6. 端口检查 ----------
$occupied = @()
foreach ($p in @(5173, 8080)) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $occupied += $p
        Warn "端口 $p 已被占用（可能是上次没关干净）"
        $owners = $conn | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $owners) {
            $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($pr) { Hint "PID $procId = $($pr.ProcessName)" }
        }
    }
}

# ---------- 7. 启动 ----------
$startBackend = $jdkOk -and $mvnExe -and (Test-Path (Join-Path $root 'backend\pom.xml'))

Head '启动服务'

if ($startBackend) {
    # 用临时 bat 启动后端：比在 PowerShell 里层层嵌套引号可靠得多
    $batPath = Join-Path $env:TEMP 'zhidao-start-backend.bat'
    $batBody = @"
@echo off
title Zhidao Backend
cd /d "$root\backend"
set "JAVA_HOME=$($env:JAVA_HOME)"
"$mvnExe" -B spring-boot:run
echo.
echo 后端已停止。按任意键关闭本窗口。
pause >nul
"@
    Set-Content -Path $batPath -Value $batBody -Encoding ASCII

    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$batPath`"" -WindowStyle Normal | Out-Null
    Ok '后端已在新窗口启动（关闭那个窗口即停止后端）'
    Hint '首次启动约 20-40 秒就绪'
} else {
    Warn '后端跳过（缺少 JDK 17 或 Maven）'
    Hint '前端仍可启动：问诊可用，病历与预约页会提示后端未启动'
}

Write-Host ''
Write-Host '  前端启动中...' -ForegroundColor Gray
Write-Host ''
Write-Host '  --------------------------------------------' -ForegroundColor DarkGray
Write-Host '   访问地址： http://localhost:5173' -ForegroundColor White
Write-Host '   演示账号： demo / demo1234' -ForegroundColor White
Write-Host '   停止前端： 在本窗口按 Ctrl+C' -ForegroundColor White
Write-Host '  --------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

# 前端就绪后自动打开浏览器（后台轮询，不阻塞启动）
$opener = @'
$u = 'http://localhost:5173/'
for ($i = 0; $i -lt 120; $i++) {
    try {
        $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { Start-Process $u; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
}
'@
try {
    Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $opener -WindowStyle Hidden | Out-Null
} catch { }

Push-Location $feDir
try {
    if ($pnpmCmd) { & pnpm dev } else { & npx --yes pnpm@9 dev }
} finally {
    Pop-Location
}
