# Razer Key Light Chroma — SignalRGB add-on prototype v0.5

This build adds subnet-aware discovery to the original prototype.

## What changed

- **Auto Discover** button in the SignalRGB add-on.
- Automatic discovery attempt shortly after the add-on starts.
- Optional explicit CIDR scan, including `/16` ranges.
- PowerShell 7 helper that reads the actual `PrefixLength` from
  `Get-NetIPConfiguration`.
- Candidate hosts are verified by sending the Razer Key Light hello packet to
  TCP port `10003`; this is stronger than merely checking whether the port opens.
- Results are cached for five minutes.
- Manual IP entry remains available.

## Why a helper is required

SignalRGB network add-ons expose TCP and UDP sockets, but the public add-on API
does not expose Windows network interfaces or their subnet masks. The helper
runs only on `127.0.0.1:10004`, obtains the real Windows network configuration,
performs the scan, and returns discovered Key Light IP addresses to the add-on.

The helper does not require administrator rights.

## Files

- `RazerKeyLightChroma.js` — SignalRGB device and discovery integration.
- `RazerKeyLightChroma.qml` — SignalRGB add-on UI.
- `RazerKeyLightDiscoveryHelper.ps1` — subnet-aware scanner/local helper.
- `Install-RazerKeyLightDiscoveryHelper.ps1` — optional Startup installer.

## Install the PowerShell helper

Open **PowerShell 7** in this folder and run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Install-RazerKeyLightDiscoveryHelper.ps1
```

This creates a per-user Startup shortcut and starts the helper immediately.

To remove it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Install-RazerKeyLightDiscoveryHelper.ps1 -Uninstall
```

## Test discovery directly

This reads every active private IPv4 adapter that has a default gateway and uses
its real prefix length:

```powershell
pwsh -NoProfile -File .\RazerKeyLightDiscoveryHelper.ps1 -Once
```

For an explicit `/16`:

```powershell
pwsh -NoProfile -File .\RazerKeyLightDiscoveryHelper.ps1 -Once -Cidr 192.168.0.0/16
```

The script outputs JSON containing `found`, `subnets`, `skipped`, and
`scanned_hosts`.

The default `MaxHosts` is `131072`, which supports `/16` and `/15`. Wider
networks are skipped rather than accidentally scanning millions of addresses.
You can override this intentionally:

```powershell
pwsh -NoProfile -File .\RazerKeyLightDiscoveryHelper.ps1 -Once -MaxHosts 1048576
```

## Install the SignalRGB add-on

Place the two add-on files at the root of a public Git repository:

- `RazerKeyLightChroma.js`
- `RazerKeyLightChroma.qml`

Then open:

```text
signalrgb://addon/install?url=https://gitlab.com/YOUR_ACCOUNT/YOUR_REPOSITORY
```

After installation:

1. Start/install the discovery helper.
2. Open the Razer Key Light Chroma add-on.
3. Click **Auto Discover**.
4. Put each detected Key Light into the SignalRGB layout.
5. Start at 100 ms updates and 25% Chroma brightness.
6. Test a slow color cycle before using an audio visualizer.

## Operational cautions

- Fully exit Synapse, Razer Streaming, and the original Python controller while
  this add-on is controlling the lights.
- Give each Key Light a DHCP reservation after discovery.
- A `/16` contains 65,534 normal host addresses and can take a few minutes.
- If a Key Light becomes unresponsive, unplug it for about 20 seconds and allow
  approximately one minute for Wi-Fi reconnection.
- This remains an unverified prototype; it has not been tested against physical
  Key Lights in this environment.


## v0.3 fix

Corrected PowerShell IPv4 mask generation. PowerShell treats the literal `0xFFFFFFFF` as signed `-1`; the helper now uses `[uint32]::MaxValue` before widening to `UInt64`.


## v0.4 fix

Wrapped single-item PowerShell pipeline results in arrays. Without this, one active subnet was unrolled into a scalar string and `.Count` failed under `Set-StrictMode`.


## v0.5 loader and stability fix

- Changed `import { tcp } from "@SignalRGB/tcp"` to
  `import tcp from "@SignalRGB/tcp"`, matching SignalRGB's current official
  Govee and Yeelight add-ons.
- Removed `device.pause()` calls from asynchronous TCP callbacks.
- Configuration writes are now queued and paced from `Render()`.
- A disconnect no longer creates a new socket until the reconnect delay expires.
- Shutdown sends one RGB-disable command rather than attempting a paced sequence.

Delete the prior cached add-on before installing this version. Test with one
Key Light first, then enable the second after the first remains connected.
