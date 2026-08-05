<#
.SYNOPSIS
  Install or uninstall the Razer Key Light Chroma companion proxy.

.DESCRIPTION
  The SignalRGB add-on cannot open raw TCP connections, so a small Node.js
  proxy relays color data from SignalRGB (loopback UDP) to each Key Light
  (TCP port 10003). This script copies the proxy to %LOCALAPPDATA% and
  registers a scheduled task so it starts automatically at logon and is
  already running whenever SignalRGB is. The proxy holds no connection to
  the lights while SignalRGB is closed or idle.

  Run it from the repository root (or the SignalRGB add-on cache folder,
  %LOCALAPPDATA%\WhirlwindFX\SignalRgb\cache\addons\<id>).

.PARAMETER Uninstall
  Stop the proxy, remove the scheduled task, and delete the installed files.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$proxySrc  = Join-Path $PSScriptRoot 'proxy\keylight-proxy.js'
$proxyDest = Join-Path $env:LOCALAPPDATA 'RazerKeyLightChroma'
$proxyJs   = Join-Path $proxyDest 'keylight-proxy.js'
$vbsShim   = Join-Path $proxyDest 'run-hidden.vbs'
$taskName  = 'RazerKeyLightChromaProxy'

function Stop-ProxyIfRunning {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'keylight-proxy\.js' }
    foreach ($p in $running) {
        Write-Host "Stopping running proxy (PID $($p.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    Write-Host "=== Uninstalling Razer Key Light Chroma proxy ===" -ForegroundColor Cyan

    Stop-ProxyIfRunning

    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Write-Host "Removing scheduled task '$taskName'..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    if (Test-Path $proxyDest) {
        Write-Host "Removing $proxyDest" -ForegroundColor Yellow
        Remove-Item $proxyDest -Recurse -Force
    }

    Write-Host "Proxy uninstalled. Remove the add-on itself from SignalRGB if no longer wanted." -ForegroundColor Green
    return
}

Write-Host "=== Installing Razer Key Light Chroma proxy ===" -ForegroundColor Cyan

if (-not (Test-Path $proxySrc)) {
    throw "proxy\keylight-proxy.js not found next to this script. Run install.ps1 from the repository root."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js not found on PATH. Install Node.js 18+ from https://nodejs.org and re-run."
}
Write-Host "Node.js: $($node.Source) ($(node --version))" -ForegroundColor Green

# 1) Copy the proxy
if (-not (Test-Path $proxyDest)) {
    New-Item -ItemType Directory -Path $proxyDest -Force | Out-Null
}
Copy-Item -Path $proxySrc -Destination $proxyJs -Force
Write-Host "Installed $proxyJs" -ForegroundColor Green

# 2) Scheduled task: auto-start at logon, keep alive
Stop-ProxyIfRunning
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
                                         -ExecutionTimeLimit ([TimeSpan]::Zero)

# Preferred: S4U principal. The task runs in a non-interactive session, so no
# console window appears and Task Scheduler restarts the proxy if it crashes.
# Registering S4U may require elevation; fall back to an interactive task that
# launches node through a hidden-window VBScript shim.
$registered = $false
try {
    $action    = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$proxyJs`"" -WorkingDirectory $proxyDest
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    $registered = $true
    Write-Host "Registered scheduled task '$taskName' (S4U, hidden, auto-restart)" -ForegroundColor Green
} catch {
    Write-Host "S4U registration failed ($($_.Exception.Message.Trim())); using interactive fallback." -ForegroundColor Yellow
}

if (-not $registered) {
    # Hardcode the quoted paths into the shim so the task needs no fragile argument quoting.
    $shimContent = 'CreateObject("Wscript.Shell").Run """' + $node.Source + '"" ""' + $proxyJs + '""", 0, False'
    Set-Content -Path $vbsShim -Value $shimContent -Encoding ASCII
    $action    = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B `"$vbsShim`"" -WorkingDirectory $proxyDest
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Registered scheduled task '$taskName' (interactive, hidden via wscript)" -ForegroundColor Green
}

# 3) Start it now and verify
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'keylight-proxy\.js' }
if ($running) {
    Write-Host "Proxy running, PID $(($running | Select-Object -First 1).ProcessId)" -ForegroundColor Green
} else {
    Write-Host "Proxy did not start; check the task in Task Scheduler or run manually:" -ForegroundColor Yellow
    Write-Host "  node `"$proxyJs`"" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Install/update the add-on in SignalRGB (signalrgb://addon/install?url=<this repo>)."
Write-Host "  2. Restart SignalRGB, open the Razer Key Light Chroma page."
Write-Host "  3. The status line should read 'Proxy online'. Add your lights' IPs."
Write-Host ""
Write-Host "Proxy log: $proxyDest\keylight-proxy.log"
