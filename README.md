# Razer Key Light Chroma — SignalRGB network add-on prototype

This is an **unverified prototype** derived from an audit of
`thepolishdane/simple-razer-keylight-chroma-controller` and SignalRGB's public
network add-on examples/documentation.

It controls each Razer Key Light Chroma over its TCP protocol (port `10003`)
without requiring Synapse or the original Python controller while running.

## Architecture: add-on + companion proxy

SignalRGB's add-on runtime cannot open raw TCP connections. The
`@SignalRGB/tcp` module in SignalRGB's developer docs does not resolve inside
installed add-ons ("could not open module ... @SignalRGB/tcp for reading"),
and every shipped network add-on (Govee, Yeelight, MagicHome, Cololight) uses
UDP only. Official add-ons for TCP-based devices either use UDP protocol
variants or remain unreleased, and community projects work around the gap with
companion processes (see `signalrgb-hue-bridge-pro`'s localhost proxy).

So this project has two parts:

- **`RazerKeyLightChroma.js` / `.qml`** — the SignalRGB add-on. It builds the
  ready-to-send 105-byte protocol packets and streams them over **loopback
  UDP** (`127.0.0.1:10077`) using `@SignalRGB/udp`, the one networking module
  proven to work in shipped add-ons. One SignalRGB device per manually entered
  Key Light IP. Changed colors are sent immediately; the current color is also
  re-pushed at ~4 Hz even when static, which keeps the light's Wi-Fi radio out
  of power-save doze (a dozing radio reacts to the first packet of a burst
  late — the "flashes lag behind the music" effect). Brightness/temperature
  are re-pushed every 10 seconds.
- **`proxy/keylight-proxy.js`** — a dependency-free Node.js process that owns
  one persistent TCP connection per light, performs the reverse-engineered
  hello/registration handshake, forwards the add-on's packets verbatim, and
  drains device responses. It opens a light's connection on the first packet
  for it and closes it again after 30 seconds without traffic — so when
  SignalRGB exits (or a light is removed), the light is released for Synapse
  or other controllers automatically. Because a light whose radio fell asleep
  ignores the first connection attempt (the attempt itself wakes it), failed
  connects are retried with widening gaps (0.3/0.6/1/1.5 s) before giving up,
  and a congestion guard skips stale colors instead of buffering them when
  Wi-Fi hiccups.

The add-on page shows a live **proxy status line** (it pings the proxy every
5 seconds), so a missing proxy is visible instead of silently doing nothing.

## Prerequisites

1. [Node.js 18+](https://nodejs.org) on the PC running SignalRGB (for the proxy).
2. Give each Key Light a DHCP reservation/static lease in your router.
3. Fully exit Razer Synapse, Razer Streaming, and the original Python controller.
   The light's control service appears to tolerate only one active controller.
4. If a light becomes wedged, unplug it for about 20 seconds, reconnect it, and
   allow roughly a minute for Wi-Fi reconnection.

## Installation

1. Install the companion proxy (from a clone of this repository, or from the
   add-on cache folder after step 2):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   Registering the auto-start task needs administrator rights, so expect a
   **UAC prompt** (the script relaunches itself elevated; the task is still
   registered for your user account). Node.js is located via PATH or, failing
   that, the standard install folders (`Program Files\nodejs`, per-user
   `AppData\Local\Programs\nodejs`).

   This copies the proxy to `%LOCALAPPDATA%\RazerKeyLightChroma`, registers a
   scheduled task (`RazerKeyLightChromaProxy`) that **starts it hidden at every
   logon**, and starts it immediately. The proxy idles (no connections held)
   whenever SignalRGB isn't streaming, so it is safe to leave running.
   To remove it later: `.\install.ps1 -Uninstall` (also prompts for elevation).

2. Install the add-on from a public Git repository copy of these files,
   keeping the same base names (`RazerKeyLightChroma.js` / `.qml`):

   `signalrgb://addon/install?url=https://gitlab.com/YOUR_ACCOUNT/YOUR_REPOSITORY`

3. Approve the installation in SignalRGB and restart it.
4. Open the Razer Key Light Chroma add-on page. The status line should read
   **"Proxy online"**.
5. Add each light's IPv4 address.
6. Restart SignalRGB if a newly added controller does not appear immediately.
7. Put the Key Light devices into your SignalRGB layout.
8. The default frame pacing is **5 ms**. After updating from an older build,
   check the device's Frame Pacing setting — SignalRGB may still have a stale
   33/100 ms value until you lower it (or until the renamed setting appears).
   If the light stutters or drops off Wi-Fi, raise pacing until stable.

## Safe first test

- White Panel Brightness: `0%`
- Chroma Brightness: `25%`
- Frame Pacing: `5 ms` (default)
- Effect: a music visualizer or fast strobe

If flashes still feel soft/laggy compared to Synapse, check your router's
**DTIM** (Razer recommends setting it to `1` for these lights) and keep the
lights on 2.4 GHz with a solid signal. Firmware-side smoothing can't be
disabled from the reverse-engineered protocol.

## Proxy configuration (optional)

Environment variables read by `keylight-proxy.js`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEYLIGHT_PROXY_PORT` | `10077` | Loopback UDP port the add-on sends to |
| `KEYLIGHT_TCP_PORT` | `10003` | TCP port of the lights |
| `KEYLIGHT_IDLE_MS` | `90000` | Idle time before a light's TCP session is released |
| `KEYLIGHT_SEND_SPACING_MS` | `0` | Optional delay between TCP packets; only for debugging a light that can't keep up |
| `KEYLIGHT_PROXY_LOG` | `keylight-proxy.log` next to the script | Log file path; empty string disables |

If you change `KEYLIGHT_PROXY_PORT`, change `PROXY_PORT` in
`RazerKeyLightChroma.js` to match.

## Known uncertainties

- This has not been hardware-tested in this environment.
- The Key Light firmware may impose a lower practical frame rate or
  periodically close the socket; the proxy reconnects on demand and the add-on
  re-pushes full state every 2 seconds.
- SignalRGB's add-on APIs evolve. If SignalRGB ships `@SignalRGB/tcp` for
  add-ons in the future, the proxy can be retired.
- The audited repository has no explicit software license. Obtain permission
  from its author before distributing a derivative implementation.

## Troubleshooting

- **Status line says "Proxy offline":** the proxy isn't running. Re-run
  `install.ps1`, or start it by hand with
  `node "%LOCALAPPDATA%\RazerKeyLightChroma\keylight-proxy.js"` and watch its
  output. Check Task Scheduler for the `RazerKeyLightChromaProxy` task.
- **Proxy online but the light stays dark:** check the proxy log
  (`%LOCALAPPDATA%\RazerKeyLightChroma\keylight-proxy.log`) for TCP errors —
  wrong IP, light offline, or another controller (Synapse) holding the
  connection. Verify the IP and test TCP port `10003`.
- **No device appears:** verify the `.js` and `.qml` names match and inspect
  the SignalRGB logs.
- **Light disconnects repeatedly:** raise frame pacing (10 ms, then 33 ms),
  close every other Razer controller, and power-cycle the light.
- **Colors feel delayed:** confirm Frame Pacing is 5 ms, proxy status shows
  `v0.5.0`, and `KEYLIGHT_SEND_SPACING_MS` is unset. Also try setting router
  DTIM to 1 (Razer’s own recommendation for these lights).
- **Light is stuck on but still pings:** the audited project's changelog notes
  that ICMP ping is not a reliable health test; the TCP control port is.
