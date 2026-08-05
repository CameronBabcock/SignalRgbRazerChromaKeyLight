#requires -Version 7.0
<#
.SYNOPSIS
    Discovers Razer Key Light Chroma devices on the actual active IPv4 subnets.

.DESCRIPTION
    Reads IPv4 address and PrefixLength from Get-NetIPConfiguration. A /24 scans
    one host octet; a /16 scans two host octets. Candidate devices are verified
    by connecting to TCP 10003 and sending the reverse-engineered Key Light hello
    packet, rather than relying on ping.

    Default mode runs a localhost discovery service for the SignalRGB add-on.
    Use -Once for a one-time scan that prints JSON.

.EXAMPLE
    pwsh -NoProfile -File .\RazerKeyLightDiscoveryHelper.ps1 -Once

.EXAMPLE
    pwsh -NoProfile -File .\RazerKeyLightDiscoveryHelper.ps1 -Once -Cidr 192.168.0.0/16

.EXAMPLE
    pwsh -NoProfile -WindowStyle Hidden -File .\RazerKeyLightDiscoveryHelper.ps1
#>

[CmdletBinding()]
param(
    [switch]$Once,

    [ValidatePattern('^\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}$')]
    [string]$Cidr,

    [ValidateRange(1, 65535)]
    [int]$ListenPort = 10004,

    [ValidateRange(1, 65535)]
    [int]$TargetPort = 10003,

    [ValidateRange(50, 5000)]
    [int]$TimeoutMs = 250,

    [ValidateRange(1, 512)]
    [int]$ThrottleLimit = 128,

    # Supports /16 (65,534 usable addresses) and /15 by default. Increase
    # explicitly for unusually wide enterprise networks.
    [ValidateRange(1, 16777214)]
    [int]$MaxHosts = 131072,

    [ValidateRange(1, 60)]
    [int]$CacheMinutes = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HelloPacket = [byte[]]@(
    0xAA, 0x00, 0x00, 0x13, 0x02, 0x09, 0x12, 0x02, 0x20, 0x26,
    0x01, 0x09, 0x00, 0x11, 0x00, 0x00, 0x40, 0x15, 0x00
)

function ConvertTo-IPv4UInt32 {
    param(
        [Parameter(Mandatory)]
        [string]$Address
    )

    $parsed = [System.Net.IPAddress]::Parse($Address)
    $bytes = $parsed.GetAddressBytes()

    if ($bytes.Length -ne 4) {
        throw "'$Address' is not an IPv4 address."
    }

    [Array]::Reverse($bytes)
    return [BitConverter]::ToUInt32($bytes, 0)
}

function ConvertFrom-IPv4UInt32 {
    param(
        [Parameter(Mandatory)]
        [uint32]$Value
    )

    $bytes = [BitConverter]::GetBytes($Value)
    [Array]::Reverse($bytes)
    return ([System.Net.IPAddress]::new([byte[]]$bytes)).ToString()
}

function Test-PrivateOrLocalIPv4 {
    param(
        [Parameter(Mandatory)]
        [string]$Address
    )

    $bytes = [System.Net.IPAddress]::Parse($Address).GetAddressBytes()

    return (
        $bytes[0] -eq 10 -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
        ($bytes[0] -eq 169 -and $bytes[1] -eq 254)
    )
}

function Get-IPv4Range {
    param(
        [Parameter(Mandatory)]
        [string]$CidrValue
    )

    $cidrParts = @($CidrValue.Split('/', 2))
    if ($cidrParts.Count -ne 2) {
        throw "Invalid CIDR '$CidrValue'."
    }

    $ip = $cidrParts[0]
    $prefix = [int]$cidrParts[1]

    if ($prefix -lt 0 -or $prefix -gt 32) {
        throw "Invalid prefix length '$prefix'."
    }

    $ipValue = [uint32](ConvertTo-IPv4UInt32 -Address $ip)
    $hostBits = 32 - $prefix
    $blockSize = [uint64][Math]::Pow(2, $hostBits)

    $mask64 = if ($prefix -eq 0) {
        [uint64]0
    }
    else {
        ([uint64]([uint32]::MaxValue) -shl $hostBits) -band [uint64]([uint32]::MaxValue)
    }

    $network = [uint64]($ipValue -band [uint32]$mask64)
    $broadcast = $network + $blockSize - 1

    if ($prefix -le 30) {
        $first = $network + 1
        $last = $broadcast - 1
    }
    elseif ($prefix -eq 31) {
        $first = $network
        $last = $broadcast
    }
    else {
        $first = $network
        $last = $network
    }

    [pscustomobject]@{
        Cidr      = "$(ConvertFrom-IPv4UInt32 -Value ([uint32]$network))/$prefix"
        Prefix    = $prefix
        Network   = $network
        Broadcast = $broadcast
        First     = $first
        Last      = $last
        HostCount = [uint64]($last - $first + 1)
    }
}

function Get-ActiveIPv4Cidrs {
    $results = foreach ($configuration in (Get-NetIPConfiguration)) {
        if ($configuration.NetAdapter.Status -ne 'Up') {
            continue
        }

        # Prefer interfaces that participate in normal routed networking. This
        # avoids scanning most disconnected Hyper-V/VPN-only interfaces.
        if (-not $configuration.IPv4DefaultGateway) {
            continue
        }

        foreach ($address in @($configuration.IPv4Address)) {
            if (-not $address.IPAddress) {
                continue
            }

            if ($address.IPAddress -eq '127.0.0.1') {
                continue
            }

            if (-not (Test-PrivateOrLocalIPv4 -Address $address.IPAddress)) {
                continue
            }

            try {
                $range = Get-IPv4Range -CidrValue "$($address.IPAddress)/$($address.PrefixLength)"
                [pscustomobject]@{
                    InterfaceAlias = $configuration.InterfaceAlias
                    Address        = $address.IPAddress
                    PrefixLength   = [int]$address.PrefixLength
                    Cidr           = $range.Cidr
                }
            }
            catch {
                Write-Warning "Skipping $($configuration.InterfaceAlias): $($_.Exception.Message)"
            }
        }
    }

    return @($results | Sort-Object Cidr -Unique)
}

function Invoke-KeyLightScan {
    param(
        [Parameter(Mandatory)]
        [string[]]$Cidrs
    )

    $found = [System.Collections.Generic.HashSet[string]]::new()
    $skipped = [System.Collections.Generic.List[string]]::new()
    $normalizedCidrs = [System.Collections.Generic.List[string]]::new()
    [uint64]$totalScanned = 0

    foreach ($cidrEntry in $Cidrs) {
        $range = Get-IPv4Range -CidrValue $cidrEntry
        $normalizedCidrs.Add($range.Cidr)

        if ($range.HostCount -gt [uint64]$MaxHosts) {
            $skipped.Add(
                "$($range.Cidr) has $($range.HostCount) hosts, above MaxHosts=$MaxHosts"
            )
            continue
        }

        $probePort = $TargetPort
        $probeTimeout = $TimeoutMs
        $probeHello = $HelloPacket
        $batchSize = 4096

        for (
            [uint64]$batchStart = $range.First;
            $batchStart -le $range.Last;
            $batchStart += [uint64]$batchSize
        ) {
            $batchEnd = [Math]::Min(
                [double]$range.Last,
                [double]($batchStart + [uint64]$batchSize - 1)
            )
            $batchEnd = [uint64]$batchEnd

            $targets = [System.Collections.Generic.List[string]]::new()
            for ([uint64]$value = $batchStart; $value -le $batchEnd; $value++) {
                $targets.Add((ConvertFrom-IPv4UInt32 -Value ([uint32]$value)))
            }

            $totalScanned += [uint64]$targets.Count

            $batchFound = $targets | ForEach-Object -Parallel {
                $candidateIp = $_
                $client = [System.Net.Sockets.TcpClient]::new()

                try {
                    $connectTask = $client.ConnectAsync(
                        $candidateIp,
                        $using:probePort
                    )

                    if (-not $connectTask.Wait($using:probeTimeout)) {
                        return
                    }

                    if (-not $client.Connected) {
                        return
                    }

                    $stream = $client.GetStream()
                    $stream.WriteTimeout = $using:probeTimeout
                    $stream.ReadTimeout = [Math]::Max(
                        500,
                        $using:probeTimeout
                    )

                    $hello = [byte[]]$using:probeHello
                    $stream.Write($hello, 0, $hello.Length)
                    $stream.Flush()

                    $response = [byte[]]::new(64)
                    try {
                        $bytesRead = $stream.Read(
                            $response,
                            0,
                            $response.Length
                        )
                    }
                    catch {
                        $bytesRead = 0
                    }

                    if ($bytesRead -gt 0) {
                        $candidateIp
                    }
                }
                catch {
                    # Closed, filtered and unreachable hosts are expected.
                }
                finally {
                    $client.Dispose()
                }
            } -ThrottleLimit $ThrottleLimit

            foreach ($candidate in @($batchFound)) {
                if ($candidate) {
                    [void]$found.Add([string]$candidate)
                }
            }
        }
    }

    [pscustomobject]@{
        status        = 'ok'
        found         = @($found | Sort-Object {
            ConvertTo-IPv4UInt32 -Address $_
        })
        subnets       = @($normalizedCidrs | Sort-Object -Unique)
        skipped       = @($skipped)
        scanned_hosts = $totalScanned
        timestamp     = [DateTimeOffset]::Now.ToString('o')
    }
}

function Get-RequestedCidrs {
    param(
        [string]$ExplicitCidr
    )

    if ($ExplicitCidr) {
        return @((Get-IPv4Range -CidrValue $ExplicitCidr).Cidr)
    }

    $local = @(Get-ActiveIPv4Cidrs)
    if ($local.Count -eq 0) {
        throw 'No active private IPv4 interface with a default gateway was found.'
    }

    return @($local.Cidr)
}

if ($Once) {
    try {
        $result = Invoke-KeyLightScan -Cidrs (
            Get-RequestedCidrs -ExplicitCidr $Cidr
        )
        $result | ConvertTo-Json -Depth 6
        exit 0
    }
    catch {
        [pscustomobject]@{
            status  = 'error'
            message = $_.Exception.Message
        } | ConvertTo-Json -Compress
        exit 1
    }
}

$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $ListenPort
)

$cachedResult = $null
$cachedCidrsKey = ''
$cachedAt = [DateTimeOffset]::MinValue

try {
    $listener.Start()
    Write-Host "Razer Key Light discovery helper listening on 127.0.0.1:$ListenPort"

    while ($true) {
        $client = $listener.AcceptTcpClient()
        $reader = $null
        $writer = $null

        try {
            $client.ReceiveTimeout = 30000
            $client.SendTimeout = 30000
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new(
                $stream,
                [System.Text.Encoding]::UTF8,
                $false,
                1024,
                $true
            )
            $writer = [System.IO.StreamWriter]::new(
                $stream,
                [System.Text.UTF8Encoding]::new($false),
                1024,
                $true
            )
            $writer.AutoFlush = $true

            $request = $reader.ReadLine()
            if (-not $request) {
                continue
            }

            $requestedCidr = $null
            if ($request.StartsWith('SCAN_CIDR ')) {
                $requestedCidr = $request.Substring('SCAN_CIDR '.Length).Trim()
            }
            elseif ($request -ne 'SCAN') {
                $writer.WriteLine(
                    ([pscustomobject]@{
                        status  = 'error'
                        message = "Unknown command '$request'."
                    } | ConvertTo-Json -Compress)
                )
                continue
            }

            $cidrs = @(Get-RequestedCidrs -ExplicitCidr $requestedCidr)
            $cidrsKey = ($cidrs | Sort-Object) -join ','

            $writer.WriteLine(
                ([pscustomobject]@{
                    status  = 'progress'
                    message = "Scanning $($cidrs -join ', ') on TCP $TargetPort..."
                } | ConvertTo-Json -Compress)
            )

            $cacheAge = [DateTimeOffset]::Now - $cachedAt
            $cacheValid = (
                $null -ne $cachedResult -and
                $cidrsKey -eq $cachedCidrsKey -and
                $cacheAge.TotalMinutes -lt $CacheMinutes
            )

            if (-not $cacheValid) {
                $cachedResult = Invoke-KeyLightScan -Cidrs $cidrs
                $cachedCidrsKey = $cidrsKey
                $cachedAt = [DateTimeOffset]::Now
            }

            $writer.WriteLine(
                ($cachedResult | ConvertTo-Json -Compress -Depth 6)
            )
        }
        catch {
            try {
                $errorPayload = [pscustomobject]@{
                    status  = 'error'
                    message = $_.Exception.Message
                } | ConvertTo-Json -Compress

                if ($writer) {
                    $writer.WriteLine($errorPayload)
                }
            }
            catch {
                # Client may already have disconnected.
            }
        }
        finally {
            if ($reader) {
                $reader.Dispose()
            }
            if ($writer) {
                $writer.Dispose()
            }
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
}
