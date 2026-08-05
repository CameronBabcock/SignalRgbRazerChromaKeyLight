import udp from "@SignalRGB/udp";

export function Name() { return "Razer Key Light Chroma"; }
export function Version() { return "0.4.0"; }
export function Type() { return "network"; }
export function Publisher() { return "Community prototype"; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [75, 70]; }
export function DefaultScale() { return 12.0; }
export function SubdeviceController() { return false; }
export function ImageUrl() {
    return "https://assets.signalrgb.com/brands/razer/logo.png";
}

/* global
controller:readonly
discovery:readonly
LightingMode:readonly
forcedColor:readonly
chromaBrightness:readonly
mainBrightness:readonly
colorTemperature:readonly
updateIntervalMs:readonly
turnOffOnShutdown:readonly
*/

export function ControllableParameters() {
    return [
        {
            property: "LightingMode",
            group: "lighting",
            label: "Lighting Mode",
            type: "combobox",
            values: ["Canvas", "Forced"],
            default: "Canvas"
        },
        {
            property: "forcedColor",
            group: "lighting",
            label: "Forced Color",
            type: "color",
            default: "#00ff41"
        },
        {
            property: "chromaBrightness",
            group: "lighting",
            label: "Chroma Brightness",
            type: "number",
            min: 1,
            max: 100,
            step: 1,
            default: 50
        },
        {
            property: "mainBrightness",
            group: "lighting",
            label: "White Panel Brightness",
            description: "Capped at 15% while Chroma is active, matching the safety behavior in the audited controller.",
            type: "number",
            min: 0,
            max: 15,
            step: 1,
            default: 0
        },
        {
            property: "colorTemperature",
            group: "lighting",
            label: "White Panel Temperature",
            type: "number",
            min: 3000,
            max: 7000,
            step: 100,
            default: 5000
        },
        {
            property: "updateIntervalMs",
            group: "settings",
            label: "Frame Pacing (ms)",
            description: "10 ms matches SignalRGB's official network add-ons. Raise this only if the light stutters or drops off Wi-Fi.",
            type: "number",
            min: 5,
            max: 250,
            step: 1,
            default: 10
        },
        {
            property: "turnOffOnShutdown",
            group: "settings",
            label: "Turn Chroma Off on Exit",
            type: "boolean",
            default: true
        }
    ];
}

const LED_NAMES = ["Key Light RGB Panel"];
const LED_POSITIONS = [[0, 0]];

export function LedNames() { return LED_NAMES; }
export function LedPositions() { return LED_POSITIONS; }

// The add-on runtime cannot open raw TCP sockets, so all device traffic is
// relayed through the companion proxy (proxy/keylight-proxy.js) over loopback
// UDP. The proxy owns the persistent TCP connection and the
// hello/registration handshake; this file only builds protocol packets.
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 10077;

// Re-push the current color at ~4 Hz even when unchanged. This keeps the
// light's Wi-Fi radio out of power-save doze between effects (the original
// project observed a sleeping radio ignoring packets — the "light reacts
// late" bug), signals the proxy that SignalRGB is alive, and heals state
// after a proxy restart or light power-cycle.
const COLOR_REFRESH_MS = 250;
// Brightness/temperature packets change rarely; re-push them slowly so the
// white-panel writes don't interleave with the color stream.
const CONFIG_REFRESH_MS = 10000;

let proxySocket = null;
let lastColor = [-1, -1, -1];
let lastConfig = "";
let lastColorPushAt = 0;
let lastConfigPushAt = 0;

export function Initialize() {
    device.setName(`Razer Key Light Chroma (${controller.ip})`);

    proxySocket = udp.createSocket();
    proxySocket.on("error", (code, message) => {
        device.log(`Proxy socket error: ${code} - ${message}`);
    });
    proxySocket.on("connection", () => {
        device.log(`Streaming to key light proxy at ${PROXY_HOST}:${PROXY_PORT}`);
    });
    proxySocket.bind(0);
    proxySocket.connect(PROXY_HOST, PROXY_PORT);
}

export function Render() {
    const now = Date.now();

    const configKey = `${chromaBrightness}|${mainBrightness}|${colorTemperature}`;
    if (configKey !== lastConfig || now - lastConfigPushAt >= CONFIG_REFRESH_MS) {
        sendConfiguration();
        lastConfig = configKey;
        lastConfigPushAt = now;
    }

    const color = LightingMode === "Forced"
        ? hexToRgb(forcedColor)
        : device.color(0, 0);

    if (colorChanged(color, lastColor) || now - lastColorPushAt >= COLOR_REFRESH_MS) {
        sendPacket(buildPacket("C_RGB", 0, color));
        lastColor = [color[0], color[1], color[2]];
        lastColorPushAt = now;
    }

    device.pause(clampInt(updateIntervalMs, 5, 250));
}

export function Shutdown() {
    if (proxySocket === null) {
        return;
    }

    if (turnOffOnShutdown) {
        sendPacket(buildPacket("C_BRIGHT", 0));
        sendPacket(buildPacket("C_RGB", 0, [0, 0, 0]));
    }

    // Release the light immediately so Synapse or another controller can
    // take over without waiting for the proxy's idle timeout.
    sendToProxy({ ip: controller.ip, cmd: "disconnect" });

    try {
        proxySocket.disconnect();
        proxySocket.close();
    } catch (e) {
        device.log(`Proxy socket close warning: ${e}`);
    }

    proxySocket = null;
}

function sendConfiguration() {
    // Keep the white panel at or below 15% while Chroma is active.
    const whitePct = clampInt(mainBrightness, 0, 15);
    const chromaPct = clampInt(chromaBrightness, 1, 100);
    const temperature = clampInt(colorTemperature, 3000, 7000);

    sendPacket(buildPacket("BRIGHT", percentToByte(whitePct)));
    sendPacket(buildPacket("TEMP", temperature));
    sendPacket(buildPacket("C_BRIGHT", percentToByte(chromaPct)));
}

function sendPacket(packet) {
    sendToProxy({ ip: controller.ip, data: packet });
}

function sendToProxy(message) {
    if (proxySocket === null) {
        return;
    }

    if (proxySocket.send(JSON.stringify(message)) === -1) {
        device.log("Failed to send datagram to key light proxy.");
    }
}

function buildPacket(command, value = 0, rgb = null) {
    const header = [0xaa, 0x00, 0x00, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let payload = [];

    switch (command) {
        case "BRIGHT":
            payload = [0x03, 0x03, 0x03, 0x00, 0x20, clampInt(value, 0, 255)];
            break;
        case "TEMP":
            payload = [
                0x04, 0x03, 0x01, 0x00, 0x20,
                (value >> 8) & 0xff,
                value & 0xff
            ];
            break;
        case "C_BRIGHT":
            payload = [0x03, 0x0f, 0x04, 0x00, 0x00, clampInt(value, 0, 255)];
            break;
        case "C_RGB":
            payload = [
                0x0c, 0x0f, 0x02, 0x01, 0x05, 0x01, 0x00, 0x00, 0x01,
                clampInt(rgb[0], 0, 255),
                clampInt(rgb[1], 0, 255),
                clampInt(rgb[2], 0, 255)
            ];
            break;
        default:
            throw new Error(`Unsupported command: ${command}`);
    }

    const packet = header.concat(payload);

    // The reverse-engineered protocol pads the packet to 103 bytes before
    // appending an XOR checksum and trailing zero, for 105 bytes total.
    while (packet.length < 103) {
        packet.push(0x00);
    }

    let checksum = 0;
    for (let i = 2; i < packet.length; i++) {
        checksum ^= packet[i];
    }

    packet.push(checksum & 0xff);
    packet.push(0x00);
    return packet;
}

function percentToByte(percent) {
    return Math.round(clampInt(percent, 0, 100) * 2.55);
}

function colorChanged(a, b) {
    return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
}

function clampInt(value, min, max) {
    const parsed = Math.round(Number(value));
    return Math.max(min, Math.min(max, parsed));
}

function hexToRgb(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!match) {
        return [0, 0, 0];
    }

    return [
        parseInt(match[1], 16),
        parseInt(match[2], 16),
        parseInt(match[3], 16)
    ];
}

// ----------------------------- Discovery service -----------------------------

const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 12000;

export function DiscoveryService() {
    this.IconUrl = "https://assets.signalrgb.com/brands/razer/logo.png";
    this.storageId = "razer-key-light-chroma";
    this.storageKey = "configured-ips";
    this.initialized = false;

    this.pingSocket = null;
    this.lastPingAt = 0;
    this.lastPongAt = 0;
    this.proxyVersion = "";
    this.proxySessions = 0;

    this.Initialize = function() {
        this.initialized = true;

        const saved = service.getSetting(this.storageId, this.storageKey);
        if (saved !== undefined) {
            try {
                const ips = JSON.parse(saved);
                for (const ip of ips) {
                    this.createController(ip);
                }
            } catch (e) {
                service.log(`Unable to parse saved Key Light IPs: ${e}`);
            }
        }

        const instance = this;
        this.pingSocket = udp.createSocket();
        this.pingSocket.on("error", (code, message) => {
            service.log(`Proxy ping socket error: ${code} - ${message}`);
        });
        this.pingSocket.on("message", (msg) => {
            instance.handleProxyMessage(msg);
        });
        this.pingSocket.bind(0);
        this.pingSocket.connect(PROXY_HOST, PROXY_PORT);

        this.pingProxy();
    };

    this.Update = function() {
        if (Date.now() - this.lastPingAt >= PING_INTERVAL_MS) {
            this.pingProxy();
        }
    };

    this.Shutdown = function() {
        if (this.pingSocket !== null) {
            try {
                this.pingSocket.disconnect();
                this.pingSocket.close();
            } catch (e) {
                service.log(`Proxy ping socket close warning: ${e}`);
            }
            this.pingSocket = null;
        }
    };

    this.pingProxy = function() {
        this.lastPingAt = Date.now();
        if (this.pingSocket !== null) {
            this.pingSocket.send(JSON.stringify({ cmd: "ping" }));
        }
    };

    this.handleProxyMessage = function(msg) {
        // Shipped add-ons receive datagram text as msg.response (Govee);
        // fall back to msg.data for runtimes that deliver byte arrays.
        const raw = msg?.response ?? msg?.data ?? msg;
        let text = raw;
        if (Array.isArray(raw)) {
            text = String.fromCharCode(...raw);
        }

        try {
            const reply = JSON.parse(text);
            if (reply.cmd === "pong") {
                this.lastPongAt = Date.now();
                this.proxyVersion = String(reply.version ?? "");
                this.proxySessions = Object.keys(reply.sessions ?? {}).length;
            }
        } catch (e) {
            void e; // not a proxy reply; ignore
        }
    };

    // Read by the QML page.
    this.proxyStatusText = function() {
        if (this.lastPongAt !== 0 && Date.now() - this.lastPongAt <= PONG_TIMEOUT_MS) {
            const version = this.proxyVersion !== "" ? ` v${this.proxyVersion}` : "";
            const lights = this.proxySessions === 1 ? "1 light connected" : `${this.proxySessions} lights connected`;
            return `Proxy online${version} — ${lights}`;
        }

        if (this.lastPingAt === 0) {
            return "Checking for proxy…";
        }

        return "Proxy offline — run install.ps1 (or: node keylight-proxy.js)";
    };

    this.proxyOnline = function() {
        return this.lastPongAt !== 0 && Date.now() - this.lastPongAt <= PONG_TIMEOUT_MS;
    };

    this.addKeyLight = function(ipAddress) {
        const ip = String(ipAddress || "").trim();
        if (!isValidIPv4(ip)) {
            service.log(`Rejected invalid Key Light IP: ${ip}`);
            return;
        }

        const ips = this.getSavedIps();
        if (!ips.includes(ip)) {
            ips.push(ip);
            service.saveSetting(this.storageId, this.storageKey, JSON.stringify(ips));
        }

        this.createController(ip);
    };

    this.clearSavedKeyLights = function() {
        service.removeSetting(this.storageId, this.storageKey);
        service.log("Cleared saved Key Light IPs. Restart SignalRGB to remove active instances.");
    };

    this.getSavedIps = function() {
        const saved = service.getSetting(this.storageId, this.storageKey);
        if (saved === undefined) {
            return [];
        }

        try {
            const parsed = JSON.parse(saved);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    };

    this.createController = function(ip) {
        const id = `razer-key-light-${ip}`;
        const existing = service.getController(id);

        if (existing === undefined) {
            const newController = new RazerKeyLightController(ip);
            service.addController(newController);
            service.announceController(newController);
        } else {
            existing.updateWithIp(ip);
        }
    };
}

class RazerKeyLightController {
    constructor(ip) {
        this.id = `razer-key-light-${ip}`;
        this.ip = ip;
        this.name = `Razer Key Light Chroma ${ip}`;
        this.deviceImage = "https://assets.signalrgb.com/brands/razer/logo.png";
    }

    updateWithIp(ip) {
        this.ip = ip;
        this.name = `Razer Key Light Chroma ${ip}`;
        service.updateController(this);
    }
}

function isValidIPv4(ip) {
    const parts = ip.split(".");
    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        if (!/^\d{1,3}$/.test(part)) {
            return false;
        }
        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}
