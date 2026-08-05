#requires -Version 7.0
<#
Creates or removes a per-user Startup shortcut for the discovery helper.
No administrator rights are required.
#>

[CmdletBinding()]
param(
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$helperPath = Join-Path $PSScriptRoot 'RazerKeyLightDiscoveryHelper.ps1'
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Razer Key Light Discovery Helper.lnk'

if ($Uninstall) {
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
    }

    Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" |
        Where-Object {
            $_.CommandLine -like '*RazerKeyLightDiscoveryHelper.ps1*'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Write-Host 'Removed the Startup shortcut and stopped the helper.'
    exit 0
}

if (-not (Test-Path $helperPath)) {
    throw "Helper not found: $helperPath"
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pwshPath
$shortcut.Arguments = (
    '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass ' +
    "-File `"$helperPath`""
)
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'SignalRGB Razer Key Light discovery helper'
$shortcut.Save()

$alreadyRunning = Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" |
    Where-Object {
        $_.CommandLine -like '*RazerKeyLightDiscoveryHelper.ps1*'
    }

if (-not $alreadyRunning) {
    Start-Process -FilePath $pwshPath -WindowStyle Hidden -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$helperPath`""
    )
}

Write-Host "Installed and started the discovery helper."
Write-Host "Startup shortcut: $shortcutPath"
