import tcp from "@SignalRGB/tcp";

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
LightingMode:readonly
forcedColor:readonly
chromaBrightness:readonly
mainBrightness:readonly
colorTemperature:readonly
updateIntervalMs:readonly
turnOffOnShutdown:readonly
device:readonly
service:readonly
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
const DISCOVERY_HELPER_HOST = "127.0.0.1";
const DISCOVERY_HELPER_PORT = 10004;

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
let pendingPackets = [];
let nextPacketAt = 0;
const reconnectDelayMs = 2000;
const configurationPacketGapMs = 25;

export function Initialize() {
    device.setName(`Razer Key Light Chroma (${controller.ip})`);
    device.setImageFromUrl(controller.deviceImage);
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
        queueConfiguration();
        lastConfig = configKey;
    }

    // Send configuration commands one frame at a time. The previous prototype
    // called device.pause() from an asynchronous socket callback, which is not
    // how SignalRGB's own add-ons use pause().
    if (pendingPackets.length > 0) {
        if (Date.now() >= nextPacketAt) {
            sendPacket(pendingPackets.shift());
            nextPacketAt = Date.now() + configurationPacketGapMs;
        }

        device.pause(configurationPacketGapMs);
        return;
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
        // One command is sufficient to disable the RGB panel. Avoid trying to
        // pace multiple packets while SignalRGB is already shutting down.
        sendPacket(buildPacket("C_BRIGHT", 0));
    }

    closeSocket();
}

function connect() {
    closeSocket();

    protocolState = "connecting";
    lastConnectAttempt = Date.now();
    pendingPackets = [];
    socket = tcp.createSocket();

    socket.on("connected", () => {
        device.log(`Connected to Key Light at ${controller.ip}:${RAZER_PORT}`);
        protocolState = "hello-sent";
        socket.send(HELLO_PACKET);
    });

    socket.on("message", (data) => {
        if (protocolState === "hello-sent") {
            protocolState = "registration-sent";
            socket.send(buildPacket("REG"));
            return;
        }

        if (protocolState === "registration-sent") {
            protocolState = "ready";
            lastConfig = "";
            lastColor = [-1, -1, -1];
            queueConfiguration();
            device.log("Key Light protocol registration completed.");
            return;
        }

        // Normal command replies are deliberately consumed and ignored.
        void data;
    });

    socket.on("disconnected", () => {
        device.log("Key Light disconnected.");
        protocolState = "disconnected";
        pendingPackets = [];
        lastConnectAttempt = Date.now();
    });

    socket.on("error", (code, message) => {
        const details = message === undefined ? code : `${code}: ${message}`;
        device.log(`Key Light socket error: ${details}`);
        protocolState = "disconnected";
        pendingPackets = [];
        lastConnectAttempt = Date.now();
    });

    socket.connect(controller.ip, RAZER_PORT);
}

function reconnectIfNeeded() {
    if (
        protocolState === "disconnected" &&
        Date.now() - lastConnectAttempt >= reconnectDelayMs
    ) {
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
    pendingPackets = [];
}

function queueConfiguration() {
    if (protocolState !== "ready") {
        return;
    }

    const whitePct = clampInt(mainBrightness, 0, 15);
    const chromaPct = clampInt(chromaBrightness, 1, 100);
    const temperature = clampInt(colorTemperature, 3000, 7000);

    pendingPackets = [
        buildPacket("BRIGHT", percentToByte(whitePct)),
        buildPacket("TEMP", temperature),
        buildPacket("C_BRIGHT", percentToByte(chromaPct))
    ];
    nextPacketAt = 0;
}

function sendPacket(packet) {
    if (
        socket !== null &&
        protocolState === "ready" &&
        socket.state === socket.ConnectedState
    ) {
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

function socketDataToString(data) {
    if (typeof data === "string") {
        return data;
    }

    let text = "";
    for (let i = 0; i < data.length; i++) {
        text += String.fromCharCode(data[i]);
    }
    return text;
}

// ----------------------------- Discovery service -----------------------------

export function DiscoveryService() {
    this.IconUrl = "https://assets.signalrgb.com/brands/razer/logo.png";
    this.storageId = "razer-key-light-chroma";
    this.storageKey = "configured-ips";

    this.scanStatus = "Waiting for discovery.";
    this.helperSocket = null;
    this.helperBuffer = "";
    this.helperCompleted = false;
    this.autoDiscoveryPending = true;
    this.autoDiscoveryAt = Date.now() + 1500;

    this.Initialize = function() {
        for (const ip of this.getSavedIps()) {
            this.createController(ip);
        }

        this.scanStatus = "Loaded saved Key Lights. Auto-discovery will start shortly.";
    };

    this.Update = function() {
        if (this.autoDiscoveryPending && Date.now() >= this.autoDiscoveryAt) {
            this.autoDiscoveryPending = false;
            this.requestAutoDiscovery();
        }

        for (const controllerEntry of service.controllers) {
            controllerEntry.obj.update();
        }
    };

    this.Shutdown = function() {
        this.closeHelperSocket();
    };

    this.requestAutoDiscovery = function() {
        this.requestHelperScan("SCAN");
    };

    this.scanCidr = function(cidrValue) {
        const cidr = String(cidrValue || "").trim();
        if (!isValidCidr(cidr)) {
            this.scanStatus = `Invalid CIDR: ${cidr}`;
            service.log(this.scanStatus);
            return;
        }

        this.requestHelperScan(`SCAN_CIDR ${cidr}`);
    };

    this.requestHelperScan = function(command) {
        this.closeHelperSocket();

        this.helperBuffer = "";
        this.helperCompleted = false;
        this.scanStatus = command === "SCAN"
            ? "Scanning active Windows IPv4 subnets..."
            : `Scanning ${command.substring("SCAN_CIDR ".length)}...`;

        const helperSocket = tcp.createSocket();
        this.helperSocket = helperSocket;

        helperSocket.on("connected", () => {
            service.log(`Connected to Key Light discovery helper on ${DISCOVERY_HELPER_HOST}:${DISCOVERY_HELPER_PORT}`);
            helperSocket.send(`${command}\n`);
        });

        helperSocket.on("message", (data) => {
            this.helperBuffer += socketDataToString(data);

            let newlineIndex = this.helperBuffer.indexOf("\n");
            while (newlineIndex >= 0) {
                const line = this.helperBuffer.substring(0, newlineIndex).trim();
                this.helperBuffer = this.helperBuffer.substring(newlineIndex + 1);

                if (line.length > 0) {
                    this.handleHelperMessage(line);
                }

                newlineIndex = this.helperBuffer.indexOf("\n");
            }
        });

        helperSocket.on("error", (err) => {
            if (!this.helperCompleted) {
                this.scanStatus = "Discovery helper is not running. Start/install the included PowerShell helper, or add an IP manually.";
                service.log(`Discovery helper error: ${err}`);
            }
        });

        helperSocket.on("disconnected", () => {
            if (!this.helperCompleted && this.scanStatus.indexOf("not running") < 0) {
                this.scanStatus = "Discovery helper disconnected before returning results.";
            }
        });

        helperSocket.connect(DISCOVERY_HELPER_HOST, DISCOVERY_HELPER_PORT);
    };

    this.handleHelperMessage = function(line) {
        let payload;
        try {
            payload = JSON.parse(line);
        } catch (e) {
            service.log(`Invalid discovery-helper response: ${line}`);
            return;
        }

        if (payload.status === "progress") {
            this.scanStatus = payload.message || "Scanning...";
            return;
        }

        if (payload.status === "error") {
            this.helperCompleted = true;
            this.scanStatus = payload.message || "Discovery failed.";
            service.log(this.scanStatus);
            this.closeHelperSocket();
            return;
        }

        if (payload.status !== "ok") {
            return;
        }

        const found = Array.isArray(payload.found) ? payload.found : [];
        for (const ip of found) {
            this.addKeyLight(ip);
        }

        this.helperCompleted = true;

        const subnetText = Array.isArray(payload.subnets) && payload.subnets.length > 0
            ? ` across ${payload.subnets.join(", ")}`
            : "";

        const skippedText = Array.isArray(payload.skipped) && payload.skipped.length > 0
            ? ` Skipped: ${payload.skipped.join("; ")}`
            : "";

        this.scanStatus = found.length > 0
            ? `Found ${found.length} Key Light${found.length === 1 ? "" : "s"}${subnetText}.${skippedText}`
            : `No Key Lights found${subnetText}.${skippedText}`;

        this.closeHelperSocket();
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
            ips.sort(compareIPv4);
            service.saveSetting(this.storageId, this.storageKey, JSON.stringify(ips));
        }

        this.createController(ip);
    };

    this.clearSavedKeyLights = function() {
        service.removeSetting(this.storageId, this.storageKey);
        this.scanStatus = "Cleared saved Key Light addresses. Restart SignalRGB to remove active instances.";
        service.log(this.scanStatus);
    };

    this.getSavedIps = function() {
        const saved = service.getSetting(this.storageId, this.storageKey);
        if (saved === undefined) {
            return [];
        }

        try {
            const parsed = JSON.parse(saved);
            return Array.isArray(parsed) ? parsed.filter(isValidIPv4) : [];
        } catch (e) {
            service.log(`Unable to parse saved Key Light IPs: ${e}`);
            return [];
        }
    };

    this.createController = function(ip) {
        const id = `razer-key-light-${ip}`;
        const existing = service.getController(id);

        if (existing === undefined) {
            const newController = new RazerKeyLightController(ip);
            service.addController(newController);
        } else {
            existing.updateWithIp(ip);
        }
    };

    this.closeHelperSocket = function() {
        if (this.helperSocket !== null) {
            try {
                this.helperSocket.close();
            } catch (e) {
                service.log(`Discovery helper socket close warning: ${e}`);
            }
        }

        this.helperSocket = null;
    };
}

class RazerKeyLightController {
    constructor(ip) {
        this.id = `razer-key-light-${ip}`;
        this.ip = ip;
        this.name = `Razer Key Light Chroma ${ip}`;
        this.deviceImage = "https://assets.signalrgb.com/brands/razer/logo.png";
        this.initialized = false;
    }

    updateWithIp(ip) {
        this.ip = ip;
        this.name = `Razer Key Light Chroma ${ip}`;
        service.updateController(this);
    }

    update() {
        if (!this.initialized) {
            this.initialized = true;
            service.updateController(this);
            service.announceController(this);
        }
    }
}

function isValidIPv4(ip) {
    const parts = String(ip).split(".");
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

function isValidCidr(cidr) {
    const parts = String(cidr).split("/");
    if (parts.length !== 2 || !isValidIPv4(parts[0])) {
        return false;
    }

    if (!/^\d{1,2}$/.test(parts[1])) {
        return false;
    }

    const prefix = Number(parts[1]);
    return prefix >= 0 && prefix <= 32;
}

function compareIPv4(left, right) {
    return ipv4ToNumber(left) - ipv4ToNumber(right);
}

function ipv4ToNumber(ip) {
    const parts = ip.split(".").map(Number);
    return (
        ((parts[0] << 24) >>> 0) +
        ((parts[1] << 16) >>> 0) +
        ((parts[2] << 8) >>> 0) +
        parts[3]
    ) >>> 0;
}
