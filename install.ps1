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

  Registering the scheduled task requires administrator rights on most
  systems, so the script relaunches itself elevated (UAC prompt) when needed.

  Run it from the repository root (or the SignalRGB add-on cache folder,
  %LOCALAPPDATA%\WhirlwindFX\SignalRgb\cache\addons\<id>).

.PARAMETER Uninstall
  Stop the proxy, remove the scheduled task, and delete the installed files.

.PARAMETER Elevated
  Internal. Set when the script relaunches itself with administrator rights;
  keeps the elevated console open at the end so its output stays readable.

.PARAMETER TargetUser
  Internal. The user the logon task is registered for. Captured before
  elevation so a UAC login under a different admin account still installs
  the task and files for the user who ran the script.

.PARAMETER ProxyDest
  Internal. Install folder for the proxy, captured before elevation for the
  same reason as TargetUser.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Elevated,
    [string]$TargetUser = $env:USERNAME,
    [string]$ProxyDest = (Join-Path $env:LOCALAPPDATA 'RazerKeyLightChroma')
)

$ErrorActionPreference = 'Stop'

$proxySrc = Join-Path $PSScriptRoot 'proxy\keylight-proxy.js'
$proxyJs  = Join-Path $ProxyDest 'keylight-proxy.js'
$vbsShim  = Join-Path $ProxyDest 'run-hidden.vbs'
$taskName = 'RazerKeyLightChromaProxy'

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Node {
    # PATH first; fall back to the standard install locations because a
    # fresh Node install (or a stripped PATH) is not visible to this shell.
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $roots = @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        (Join-Path $env:LOCALAPPDATA 'Programs')
    ) | Where-Object { $_ }

    foreach ($root in $roots) {
        $candidate = Join-Path $root 'nodejs\node.exe'
        if (Test-Path $candidate) { return $candidate }
    }

    return $null
}

function Stop-ProxyIfRunning {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'keylight-proxy\.js' }
    foreach ($p in $running) {
        Write-Host "Stopping running proxy (PID $($p.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------- self-elevation (UAC) ------------------------------

if (-not (Test-IsAdmin)) {
    Write-Host "Administrator rights are required to register the scheduled task." -ForegroundColor Cyan
    Write-Host "Requesting elevation (UAC prompt)..." -ForegroundColor Cyan

    $relaunchArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        '-Elevated',
        '-TargetUser', "`"$env:USERNAME`"",
        '-ProxyDest', "`"$ProxyDest`""
    )
    if ($Uninstall) { $relaunchArgs += '-Uninstall' }

    try {
        $elevatedProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $relaunchArgs -Verb RunAs -Wait -PassThru
        exit $elevatedProcess.ExitCode
    } catch {
        Write-Host "Elevation was declined. Re-run this script from an administrator PowerShell." -ForegroundColor Red
        exit 1
    }
}

$exitCode = 0
try {
    # ------------------------------ uninstall --------------------------------

    if ($Uninstall) {
        Write-Host "=== Uninstalling Razer Key Light Chroma proxy ===" -ForegroundColor Cyan

        Stop-ProxyIfRunning

        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Write-Host "Removing scheduled task '$taskName'..." -ForegroundColor Yellow
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }

        if (Test-Path $ProxyDest) {
            Write-Host "Removing $ProxyDest" -ForegroundColor Yellow
            Remove-Item $ProxyDest -Recurse -Force
        }

        Write-Host "Proxy uninstalled. Remove the add-on itself from SignalRGB if no longer wanted." -ForegroundColor Green
        return
    }

    # ------------------------------- install ---------------------------------

    Write-Host "=== Installing Razer Key Light Chroma proxy ===" -ForegroundColor Cyan

    if (-not (Test-Path $proxySrc)) {
        throw "proxy\keylight-proxy.js not found next to this script. Run install.ps1 from the repository root."
    }

    $nodeExe = Find-Node
    if (-not $nodeExe) {
        throw "Node.js not found on PATH or in the usual install folders (Program Files\nodejs). Install Node.js 18+ from https://nodejs.org and re-run."
    }
    Write-Host "Node.js: $nodeExe ($(& $nodeExe --version))" -ForegroundColor Green
    Write-Host "Installing for user '$TargetUser'" -ForegroundColor Green

    # 1) Copy the proxy
    if (-not (Test-Path $ProxyDest)) {
        New-Item -ItemType Directory -Path $ProxyDest -Force | Out-Null
    }
    Copy-Item -Path $proxySrc -Destination $proxyJs -Force
    Write-Host "Installed $proxyJs" -ForegroundColor Green

    # 2) Scheduled task: auto-start at logon, keep alive
    Stop-ProxyIfRunning
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $TargetUser
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
                                             -ExecutionTimeLimit ([TimeSpan]::Zero)

    # Preferred: S4U principal. The task runs in a non-interactive session, so
    # no console window appears and Task Scheduler restarts the proxy if it
    # crashes. Fall back to an interactive task that launches node through a
    # hidden-window VBScript shim if S4U registration is rejected.
    $registered = $false
    try {
        $action    = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$proxyJs`"" -WorkingDirectory $ProxyDest
        $principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType S4U
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        $registered = $true
        Write-Host "Registered scheduled task '$taskName' (S4U, hidden, auto-restart)" -ForegroundColor Green
    } catch {
        Write-Host "S4U registration failed ($($_.Exception.Message.Trim())); using interactive fallback." -ForegroundColor Yellow
    }

    if (-not $registered) {
        # Hardcode the quoted paths into the shim so the task needs no fragile argument quoting.
        $shimContent = 'CreateObject("Wscript.Shell").Run """' + $nodeExe + '"" ""' + $proxyJs + '""", 0, False'
        Set-Content -Path $vbsShim -Value $shimContent -Encoding ASCII
        $action    = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B `"$vbsShim`"" -WorkingDirectory $ProxyDest
        $principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType Interactive
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
    Write-Host "Proxy log: $ProxyDest\keylight-proxy.log"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($Elevated) {
        # This console belongs to the elevated relaunch and would vanish on exit.
        Read-Host "`nPress Enter to close" | Out-Null
    }
}

exit $exitCode
