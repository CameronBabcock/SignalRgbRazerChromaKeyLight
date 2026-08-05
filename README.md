# Razer Key Light Chroma — SignalRGB network add-on prototype

This is an **unverified prototype** derived from an audit of
`thepolishdane/simple-razer-keylight-chroma-controller` and SignalRGB's public
network add-on examples/documentation.

It directly controls each Razer Key Light Chroma over TCP port `10003`.
It does **not** require Synapse or the original Python controller while running.

## Why this is separate from the Python project

The audited project is well suited to buttons, presets, and occasional state
changes. Its current `/set` path writes JSON to disk, opens a new TCP connection,
performs the full handshake, and sends the complete white/RGB state for each
update. That architecture will drop frames and add latency if driven at music
visualizer rates.

This add-on instead:

- creates one SignalRGB device per manually entered Key Light IP;
- keeps a TCP connection open;
- performs the reverse-engineered hello and registration handshake once;
- samples one color from SignalRGB's canvas;
- sends only changed RGB values;
- drains device responses;
- reconnects after an error.

The Key Light Chroma appears to be a **single RGB zone**, so each physical panel
is represented as one canvas LED.

## Prerequisites

1. Give each Key Light a DHCP reservation/static lease in your router.
2. Fully exit Razer Synapse, Razer Streaming, and the original Python controller.
   The light's control service appears to tolerate only one active controller.
3. If a light becomes wedged, unplug it for about 20 seconds, reconnect it, and
   allow roughly a minute for Wi-Fi reconnection.

## Installation

SignalRGB network integrations are installed as add-ons from a repository.

1. Put these files in a public Git repository, keeping the same base name:

   - `RazerKeyLightChroma.js`
   - `RazerKeyLightChroma.qml`

2. Open this URI in Windows, replacing the repository URL:

   `signalrgb://addon/install?url=https://gitlab.com/YOUR_ACCOUNT/YOUR_REPOSITORY`

3. Approve the installation in SignalRGB.
4. Open the Razer Key Light Chroma add-on page.
5. Add each light's IPv4 address.
6. Restart SignalRGB if a newly added controller does not appear immediately.
7. Put the two Key Light devices into your SignalRGB layout, one on the left and
   one on the right.
8. Start with an update interval of **100 ms (10 Hz)**. If stable, reduce it to
   **50 ms (20 Hz)**.

SignalRGB's current public add-ons use a `.js` service/device file plus a
same-named `.qml` configuration interface. The add-on URI format above is the
same format used by SignalRGB's official Govee add-on.

## Safe first test

- White Panel Brightness: `0%`
- Chroma Brightness: `25%`
- Update Interval: `100 ms`
- Effect: a slow color cycle

After five to ten minutes without disconnects, try a music visualizer and then
lower the update interval to `50 ms`.

## Known uncertainties

- This has not been hardware-tested in this environment.
- The original project reconnects for every state push. Persistent streaming is
  the right architecture for SignalRGB, but the Key Light firmware may impose a
  lower practical frame rate or periodically close the socket.
- SignalRGB's add-on APIs evolve. If the add-on fails to load, inspect the latest
  SignalRGB log and compare the service/controller calls with a currently
  installed network add-on such as Govee or Philips Hue.
- The audited repository has no explicit software license. Obtain permission
  from its author before distributing a derivative implementation. Protocol
  interoperability facts can be reimplemented independently, but do not copy
  and republish the original application wholesale without permission.

## Troubleshooting

- **No device appears:** verify the `.js` and `.qml` names match and inspect the
  SignalRGB logs.
- **Connection refused:** verify the IP and test TCP port `10003`.
- **Light disconnects repeatedly:** return to `100 ms`, close every other Razer
  controller, and power-cycle the light.
- **Colors update but music feels delayed:** try `50 ms`; do not immediately
  jump below `33 ms`.
- **Light is stuck on but still pings:** the audited project's changelog notes
  that ICMP ping is not a reliable health test; the TCP control port is.
