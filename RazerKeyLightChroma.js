import { tcp } from "@SignalRGB/tcp";

export function Name() { return "Razer Key Light Chroma"; }
export function Version() { return "0.1.0"; }
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
            label: "Update Interval (ms)",
            description: "Start at 100 ms. Try 50 ms after confirming the light remains stable.",
            type: "number",
            min: 33,
            max: 250,
            step: 1,
            default: 100
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

const RAZER_PORT = 10003;
const HELLO_PACKET = [
    0xaa, 0x00, 0x00, 0x13, 0x02, 0x09, 0x12, 0x02, 0x20, 0x26,
    0x01, 0x09, 0x00, 0x11, 0x00, 0x00, 0x40, 0x15, 0x00
];
const REG_PAYLOAD = hexToBytes("48004901d45d645125220853796e6170736533");

let socket = null;
let protocolState = "disconnected";
let lastConnectAttempt = 0;
let lastColor = [-1, -1, -1];
let lastConfig = "";
let reconnectDelayMs = 2000;

export function Initialize() {
    device.setName(`Razer Key Light Chroma (${controller.ip})`);
    connect();
}

export function Render() {
    if (protocolState !== "ready") {
        reconnectIfNeeded();
        device.pause(100);
        return;
    }

    const configKey = `${chromaBrightness}|${mainBrightness}|${colorTemperature}`;
    if (configKey !== lastConfig) {
        sendConfiguration();
        lastConfig = configKey;
    }

    const color = LightingMode === "Forced"
        ? hexToRgb(forcedColor)
        : device.color(0, 0);

    if (colorChanged(color, lastColor)) {
        sendPacket(buildPacket("C_RGB", 0, color));
        lastColor = [color[0], color[1], color[2]];
    }

    device.pause(clampInt(updateIntervalMs, 33, 250));
}

export function Shutdown() {
    if (protocolState === "ready" && turnOffOnShutdown) {
        sendPacket(buildPacket("C_BRIGHT", 0));
        sendPacket(buildPacket("C_RGB", 0, [0, 0, 0]));
    }

    closeSocket();
}

function connect() {
    closeSocket();

    protocolState = "connecting";
    lastConnectAttempt = Date.now();
    socket = tcp.createSocket();

    socket.on("connected", () => {
        device.log(`Connected to Key Light at ${controller.ip}:${RAZER_PORT}`);
        protocolState = "hello-sent";
        socket.send(HELLO_PACKET);
    });

    socket.on("message", (data) => {
        // Reading every response is important for a persistent connection.
        // The original project used blocking recv() calls for the hello and
        // registration responses, then closed the socket after each state push.
        if (protocolState === "hello-sent") {
            protocolState = "registration-sent";
            socket.send(buildPacket("REG"));
            return;
        }

        if (protocolState === "registration-sent") {
            protocolState = "ready";
            lastConfig = "";
            lastColor = [-1, -1, -1];
            sendConfiguration();
            device.log("Key Light protocol registration completed.");
            return;
        }

        // Subsequent replies are intentionally consumed and ignored.
        void data;
    });

    socket.on("disconnected", () => {
        device.log("Key Light disconnected.");
        protocolState = "disconnected";
    });

    socket.on("error", (err) => {
        device.log(`Key Light socket error: ${err}`);
        protocolState = "disconnected";
    });

    socket.connect(controller.ip, RAZER_PORT);
}

function reconnectIfNeeded() {
    if (Date.now() - lastConnectAttempt >= reconnectDelayMs) {
        connect();
    }
}

function closeSocket() {
    if (socket !== null) {
        try {
            socket.close();
        } catch (e) {
            device.log(`Socket close warning: ${e}`);
        }
    }

    socket = null;
    protocolState = "disconnected";
}

function sendConfiguration() {
    if (protocolState !== "ready") {
        return;
    }

    // Keep the white panel at or below 15% while Chroma is active.
    const whitePct = clampInt(mainBrightness, 0, 15);
    const chromaPct = clampInt(chromaBrightness, 1, 100);
    const temperature = clampInt(colorTemperature, 3000, 7000);

    sendPacket(buildPacket("BRIGHT", percentToByte(whitePct)));
    device.pause(20);
    sendPacket(buildPacket("TEMP", temperature));
    device.pause(20);
    sendPacket(buildPacket("C_BRIGHT", percentToByte(chromaPct)));
}

function sendPacket(packet) {
    if (socket !== null && protocolState === "ready") {
        socket.send(packet);
    }
}

function buildPacket(command, value = 0, rgb = null) {
    const header = [0xaa, 0x00, 0x00, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let payload = [];

    switch (command) {
        case "REG":
            payload = REG_PAYLOAD.slice();
            break;
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

function hexToBytes(hex) {
    const result = [];
    for (let i = 0; i < hex.length; i += 2) {
        result.push(parseInt(hex.substring(i, i + 2), 16));
    }
    return result;
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

export function DiscoveryService() {
    this.IconUrl = "https://assets.signalrgb.com/brands/razer/logo.png";
    this.storageId = "razer-key-light-chroma";
    this.storageKey = "configured-ips";
    this.initialized = false;

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
    };

    this.Update = function() {
        // Devices are entered manually because the reverse-engineered project
        // does not document a discovery broadcast.
    };

    this.Shutdown = function() {};

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
            existing.obj.updateWithIp(ip);
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
