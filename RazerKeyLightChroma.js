import udp from "@SignalRGB/udp";

export function Name() { return "Razer Key Light Chroma"; }
export function Version() { return "0.5.0"; }
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
framePacingMs:readonly
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
            // Renamed from updateIntervalMs so SignalRGB picks up the new
            // default instead of keeping a stale 33/100 ms value from older builds.
            property: "framePacingMs",
            group: "settings",
            label: "Frame Pacing (ms)",
            description: "5 ms is as fast as SignalRGB's render loop typically goes. Raise only if the light stutters or drops off Wi-Fi.",
            type: "number",
            min: 1,
            max: 100,
            step: 1,
            default: 5
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

const CMD_FORWARD = 0xa1;
const CMD_DISCONNECT = 0xa2;
const CMD_PING = 0xa3;
const CMD_PONG = 0xa4;

// Keep the radio awake between effect changes. The original controller project
// documented a sleeping Wi-Fi radio ignoring the first packets of a burst.
const COLOR_KEEPALIVE_MS = 200;

let proxySocket = null;
let lastColor = [-1, -1, -1];
let lastConfig = "";
let lastColorPushAt = 0;
let ipBytes = [0, 0, 0, 0];
// Prebuilt 110-byte datagram: cmd + 4-byte IP + 105-byte C_RGB packet.
let colorDatagram = null;

export function Initialize() {
    device.setName(`Razer Key Light Chroma (${controller.ip})`);
    ipBytes = controller.ip.split(".").map((p) => Number(p));
    colorDatagram = buildColorDatagramTemplate(ipBytes);

    proxySocket = udp.createSocket();
    proxySocket.on("error", (code, message) => {
        device.log(`Proxy socket error: ${code} - ${message}`);
    });
    proxySocket.on("connection", () => {
        device.log(`Streaming to key light proxy at ${PROXY_HOST}:${PROXY_PORT}`);
    });
    proxySocket.bind(0);
    proxySocket.connect(PROXY_HOST, PROXY_PORT);

    // Push brightness/temperature once at start; afterwards only on change.
    lastConfig = "";
    lastColor = [-1, -1, -1];
    lastColorPushAt = 0;
}

export function Render() {
    const now = Date.now();

    const configKey = `${chromaBrightness}|${mainBrightness}|${colorTemperature}`;
    if (configKey !== lastConfig) {
        sendConfiguration();
        lastConfig = configKey;
    }

    const color = LightingMode === "Forced"
        ? hexToRgb(forcedColor)
        : device.color(0, 0);

    if (colorChanged(color, lastColor) || now - lastColorPushAt >= COLOR_KEEPALIVE_MS) {
        sendColor(color[0], color[1], color[2]);
        lastColor = [color[0], color[1], color[2]];
        lastColorPushAt = now;
    }

    device.pause(clampInt(framePacingMs, 1, 100));
}

export function Shutdown() {
    if (proxySocket === null) {
        return;
    }

    if (turnOffOnShutdown) {
        sendPacket(buildPacket("C_BRIGHT", 0));
        sendColor(0, 0, 0);
    }

    sendBinary([CMD_DISCONNECT, ipBytes[0], ipBytes[1], ipBytes[2], ipBytes[3]]);

    try {
        proxySocket.disconnect();
        proxySocket.close();
    } catch (e) {
        device.log(`Proxy socket close warning: ${e}`);
    }

    proxySocket = null;
}

function sendConfiguration() {
    const whitePct = clampInt(mainBrightness, 0, 15);
    const chromaPct = clampInt(chromaBrightness, 1, 100);
    const temperature = clampInt(colorTemperature, 3000, 7000);

    sendPacket(buildPacket("BRIGHT", percentToByte(whitePct)));
    sendPacket(buildPacket("TEMP", temperature));
    sendPacket(buildPacket("C_BRIGHT", percentToByte(chromaPct)));
}

function sendColor(r, g, b) {
    if (proxySocket === null || colorDatagram === null) {
        return;
    }

    // Mutate the prebuilt datagram in place: RGB at offset 5+19, then
    // recompute the XOR checksum over bytes [7 .. 107] (protocol bytes 2..102
    // of the 105-byte frame, which starts at datagram offset 5).
    colorDatagram[5 + 19] = r;
    colorDatagram[5 + 20] = g;
    colorDatagram[5 + 21] = b;

    let checksum = 0;
    for (let i = 5 + 2; i < 5 + 103; i++) {
        checksum ^= colorDatagram[i];
    }
    colorDatagram[5 + 103] = checksum & 0xff;

    sendBinary(colorDatagram);
}

function sendPacket(packet) {
    const datagram = new Array(5 + packet.length);
    datagram[0] = CMD_FORWARD;
    datagram[1] = ipBytes[0];
    datagram[2] = ipBytes[1];
    datagram[3] = ipBytes[2];
    datagram[4] = ipBytes[3];
    for (let i = 0; i < packet.length; i++) {
        datagram[5 + i] = packet[i];
    }
    sendBinary(datagram);
}

function sendBinary(bytes) {
    if (proxySocket === null) {
        return;
    }

    if (proxySocket.send(bytes) === -1) {
        device.log("Failed to send datagram to key light proxy.");
    }
}

function buildColorDatagramTemplate(ip) {
    const packet = buildPacket("C_RGB", 0, [0, 0, 0]);
    const datagram = new Array(5 + packet.length);
    datagram[0] = CMD_FORWARD;
    datagram[1] = ip[0];
    datagram[2] = ip[1];
    datagram[3] = ip[2];
    datagram[4] = ip[3];
    for (let i = 0; i < packet.length; i++) {
        datagram[5 + i] = packet[i];
    }
    return datagram;
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
            // Prefer binary ping; JSON fallback kept for older proxies.
            if (this.pingSocket.send([CMD_PING]) === -1) {
                this.pingSocket.send(JSON.stringify({ cmd: "ping" }));
            }
        }
    };

    this.handleProxyMessage = function(msg) {
        // Binary pong: 0xA4 | verLen | ver | n | (ip*4 + state)*n
        const bytes = coerceBytes(msg);
        if (bytes && bytes.length >= 2 && bytes[0] === CMD_PONG) {
            const verLen = bytes[1];
            if (bytes.length >= 2 + verLen + 1) {
                this.lastPongAt = Date.now();
                this.proxyVersion = String.fromCharCode(...bytes.slice(2, 2 + verLen));
                this.proxySessions = bytes[2 + verLen];
            }
            return;
        }

        // JSON pong (compat)
        const raw = msg?.response ?? msg?.data ?? msg;
        let text = raw;
        if (Array.isArray(raw)) {
            text = String.fromCharCode(...raw);
        }
        if (typeof text !== "string") {
            return;
        }

        try {
            const reply = JSON.parse(text);
            if (reply.cmd === "pong") {
                this.lastPongAt = Date.now();
                this.proxyVersion = String(reply.version ?? "");
                this.proxySessions = Object.keys(reply.sessions ?? {}).length;
            }
        } catch (e) {
            void e;
        }
    };

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

function coerceBytes(msg) {
    if (!msg) {
        return null;
    }
    if (Array.isArray(msg)) {
        return msg;
    }
    if (Array.isArray(msg.data)) {
        return msg.data;
    }
    if (typeof msg.response === "string") {
        const out = new Array(msg.response.length);
        for (let i = 0; i < msg.response.length; i++) {
            out[i] = msg.response.charCodeAt(i);
        }
        return out;
    }
    return null;
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
