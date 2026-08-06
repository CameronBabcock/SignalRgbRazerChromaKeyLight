// Loopback UDP-to-TCP proxy for the Razer Key Light Chroma SignalRGB add-on.
//
// Why: SignalRGB's add-on runtime cannot open raw TCP connections (the
// "@SignalRGB/tcp" module documented for plugins does not resolve inside
// installed add-ons; every shipped network add-on uses UDP only). The Key
// Light Chroma speaks a raw TCP protocol on port 10003, so this proxy does
// the TCP half: the add-on streams ready-made protocol packets to this
// process over loopback UDP, and the proxy owns one persistent TCP
// connection per light, including the hello/registration handshake.
//
// Datagram formats:
//   Binary (hot path):
//     0xA1 | a | b | c | d | data...     forward packet to a.b.c.d
//     0xA2 | a | b | c | d               disconnect a.b.c.d
//     0xA3                               ping
//     0xA4 | verLen | ver... | n |       pong
//            (a b c d | state)*n
//   JSON (compat / status):
//     {"ip":"...","data":[...]} / {"ip":"...","cmd":"disconnect"} / {"cmd":"ping"}
//
// Configuration (env vars):
//   KEYLIGHT_PROXY_PORT  UDP port to listen on (loopback only). Default 10077.
//   KEYLIGHT_TCP_PORT    TCP port of the lights. Default 10003.
//   KEYLIGHT_IDLE_MS     Close a light's TCP session after this much silence
//                        from SignalRGB. Default 90000.
//   KEYLIGHT_PROXY_LOG   Log file path. Defaults to keylight-proxy.log next to
//                        this script. Set to "" to disable file logging.

const dgram = require("dgram");
const net = require("net");
const fs = require("fs");
const path = require("path");

const VERSION = "0.5.0";
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = parseInt(process.env.KEYLIGHT_PROXY_PORT || "10077", 10);
const LIGHT_TCP_PORT = parseInt(process.env.KEYLIGHT_TCP_PORT || "10003", 10);
const IDLE_MS = parseInt(process.env.KEYLIGHT_IDLE_MS || "90000", 10);
const RECONNECT_COOLDOWN_MS = 250;
const SEND_SPACING_MS = parseInt(process.env.KEYLIGHT_SEND_SPACING_MS || "0", 10);
const QUEUE_LIMIT = 8;

// A light whose Wi-Fi radio dropped into power-save doze ignores the first
// connection attempt, but the attempt itself wakes the radio (documented in
// the original controller project). Retry with widening gaps before giving up.
const WAKE_RETRY_BACKOFF_MS = [300, 600, 1000, 1500];
const CONNECT_TIMEOUT_MS = 2000;

// If more than ~2 packets of unsent bytes sit in the socket (Wi-Fi hiccup),
// hold the queue instead of buffering stale colors behind the congestion;
// color coalescing keeps only the newest frame while we wait.
const BACKPRESSURE_BYTES = 210;
const BACKPRESSURE_POLL_MS = 5;

const CMD_FORWARD = 0xa1;
const CMD_DISCONNECT = 0xa2;
const CMD_PING = 0xa3;
const CMD_PONG = 0xa4;

// Session states encoded in pong replies
const STATE_CODE = {
    connecting: 1,
    "hello-sent": 2,
    "registration-sent": 3,
    ready: 4
};
const STATE_NAME = {
    1: "connecting",
    2: "hello-sent",
    3: "registration-sent",
    4: "ready"
};

function isColorPacket(bytes) {
    return bytes.length >= 13 && bytes[10] === 0x0c && bytes[11] === 0x0f && bytes[12] === 0x02;
}

// ----------------------------- logging --------------------------------------

const LOG_PATH = process.env.KEYLIGHT_PROXY_LOG !== undefined
    ? process.env.KEYLIGHT_PROXY_LOG
    : path.join(__dirname, "keylight-proxy.log");

if (LOG_PATH) {
    try {
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
            fs.renameSync(LOG_PATH, LOG_PATH + ".1");
        }
        const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });
        const tee = (orig) => (...args) => {
            orig.apply(console, args);
            stream.write(args.map(String).join(" ") + "\n");
        };
        console.log = tee(console.log);
        console.error = tee(console.error);
    } catch (e) {
        console.error(`Could not open log file ${LOG_PATH}: ${e.message}`);
    }
}

function log(msg) {
    console.log(`${new Date().toISOString()} ${msg}`);
}

// ------------------------- Key Light protocol -------------------------------

const HELLO_PACKET = Buffer.from([
    0xaa, 0x00, 0x00, 0x13, 0x02, 0x09, 0x12, 0x02, 0x20, 0x26,
    0x01, 0x09, 0x00, 0x11, 0x00, 0x00, 0x40, 0x15, 0x00
]);

function buildRegistrationPacket() {
    const header = [0xaa, 0x00, 0x00, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const payload = Array.from(Buffer.from("48004901d45d645125220853796e6170736533", "hex"));
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
    return Buffer.from(packet);
}

const REGISTRATION_PACKET = buildRegistrationPacket();

// ----------------------------- TCP sessions ---------------------------------

const sessions = new Map();
const cooldowns = new Map();

class Session {
    constructor(ip) {
        this.ip = ip;
        this.state = "connecting";
        this.queue = [];
        this.lastActivity = Date.now();
        this.draining = false;
        this.closed = false;
        this.attempt = 0;
        this.retryTimer = null;
        this.backpressureTimer = null;
        this.socket = null;

        this.openSocket();
    }

    openSocket() {
        this.state = "connecting";
        const socket = net.createConnection({ host: this.ip, port: LIGHT_TCP_PORT });
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(CONNECT_TIMEOUT_MS);

        socket.on("timeout", () => {
            if (this.state !== "ready") {
                socket.destroy(new Error("connect/handshake timeout"));
            }
        });

        socket.on("connect", () => {
            log(`[${this.ip}] TCP connected, sending hello`);
            this.state = "hello-sent";
            socket.write(HELLO_PACKET);
        });

        socket.on("data", (data) => {
            if (this.state === "hello-sent") {
                this.state = "registration-sent";
                socket.write(REGISTRATION_PACKET);
                return;
            }

            if (this.state === "registration-sent") {
                this.state = "ready";
                this.attempt = 0;
                socket.setTimeout(0);
                log(`[${this.ip}] registration complete, ${this.queue.length} packet(s) queued`);
                this.drain();
                return;
            }

            void data;
        });

        socket.on("error", (err) => {
            log(`[${this.ip}] TCP error: ${err.message}`);
        });

        socket.on("close", () => {
            if (this.closed) {
                return;
            }

            if (this.state === "ready") {
                log(`[${this.ip}] TCP connection closed`);
                this.dispose("closed by peer or error");
                return;
            }

            if (this.attempt < WAKE_RETRY_BACKOFF_MS.length) {
                const delay = WAKE_RETRY_BACKOFF_MS[this.attempt];
                this.attempt++;
                log(`[${this.ip}] connect failed; wake retry ${this.attempt}/${WAKE_RETRY_BACKOFF_MS.length} in ${delay} ms`);
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    if (!this.closed) {
                        this.openSocket();
                    }
                }, delay);
                return;
            }

            this.dispose(`unreachable after ${WAKE_RETRY_BACKOFF_MS.length + 1} attempts`);
        });
    }

    enqueue(bytes) {
        this.lastActivity = Date.now();
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

        // Fast path: session ready, socket not congested, nothing queued —
        // write the color (or any packet) immediately with no array churn.
        if (
            this.state === "ready"
            && !this.closed
            && this.queue.length === 0
            && this.socket
            && this.socket.writableLength <= BACKPRESSURE_BYTES
        ) {
            this.socket.write(buf);
            return;
        }

        if (isColorPacket(buf)) {
            const waitingColor = this.queue.findIndex(isColorPacket);
            if (waitingColor !== -1) {
                this.queue[waitingColor] = buf;
                this.drain();
                return;
            }
        }

        this.queue.push(buf);
        if (this.queue.length > QUEUE_LIMIT) {
            // Drop oldest non-essential packet; prefer keeping newest color.
            const dropAt = this.queue.findIndex((p, i) => i < this.queue.length - 1 && isColorPacket(p));
            this.queue.splice(dropAt === -1 ? 0 : dropAt, 1);
        }
        this.drain();
    }

    drain() {
        if (this.draining || this.state !== "ready" || this.closed || !this.socket) {
            return;
        }

        while (this.queue.length > 0) {
            if (this.socket.writableLength > BACKPRESSURE_BYTES) {
                if (this.backpressureTimer === null) {
                    this.backpressureTimer = setTimeout(() => {
                        this.backpressureTimer = null;
                        this.drain();
                    }, BACKPRESSURE_POLL_MS);
                }
                return;
            }

            this.socket.write(this.queue.shift());

            if (SEND_SPACING_MS > 0) {
                this.draining = true;
                setTimeout(() => {
                    this.draining = false;
                    this.drain();
                }, SEND_SPACING_MS);
                return;
            }
        }
    }

    dispose(reason) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.queue = [];
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
        }
        if (this.backpressureTimer !== null) {
            clearTimeout(this.backpressureTimer);
        }
        if (this.socket !== null) {
            this.socket.destroy();
        }
        if (sessions.get(this.ip) === this) {
            sessions.delete(this.ip);
            cooldowns.set(this.ip, Date.now());
            log(`[${this.ip}] session removed (${reason})`);
        }
    }
}

function getOrCreateSession(ip) {
    const existing = sessions.get(ip);
    if (existing !== undefined) {
        return existing;
    }

    const lastFailure = cooldowns.get(ip) ?? 0;
    if (Date.now() - lastFailure < RECONNECT_COOLDOWN_MS) {
        return undefined;
    }

    log(`[${ip}] opening TCP session to port ${LIGHT_TCP_PORT}`);
    const session = new Session(ip);
    sessions.set(ip, session);
    return session;
}

function ipFromBytes(buf, offset) {
    return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

function buildPong() {
    const ver = Buffer.from(VERSION, "utf8");
    const entries = [...sessions.entries()];
    const out = Buffer.alloc(2 + ver.length + 1 + entries.length * 5);
    let o = 0;
    out[o++] = CMD_PONG;
    out[o++] = ver.length;
    ver.copy(out, o);
    o += ver.length;
    out[o++] = entries.length;
    for (const [ip, session] of entries) {
        const parts = ip.split(".").map(Number);
        out[o++] = parts[0];
        out[o++] = parts[1];
        out[o++] = parts[2];
        out[o++] = parts[3];
        out[o++] = STATE_CODE[session.state] || 0;
    }
    return out;
}

function handlePing(rinfo) {
    server.send(buildPong(), rinfo.port, rinfo.address);
}

function handleForward(ip, data) {
    const session = getOrCreateSession(ip);
    if (session !== undefined) {
        session.enqueue(data);
    }
}

function handleDisconnect(ip) {
    const session = sessions.get(ip);
    if (session !== undefined) {
        session.dispose("disconnect requested by add-on");
    }
}

// Idle sweep: release lights SignalRGB stopped talking about (or SignalRGB quit).
setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
        if (now - session.lastActivity > IDLE_MS) {
            log(`[${session.ip}] idle for ${IDLE_MS} ms`);
            session.dispose("idle timeout");
        }
    }
}, Math.min(5000, IDLE_MS)).unref();

// ------------------------------ UDP server ----------------------------------

const server = dgram.createSocket("udp4");

server.on("message", (raw, rinfo) => {
    if (raw.length === 0) {
        return;
    }

    // Binary hot path
    const cmd = raw[0];
    if (cmd === CMD_PING) {
        handlePing(rinfo);
        return;
    }
    if (cmd === CMD_FORWARD && raw.length > 5) {
        handleForward(ipFromBytes(raw, 1), raw.subarray(5));
        return;
    }
    if (cmd === CMD_DISCONNECT && raw.length >= 5) {
        handleDisconnect(ipFromBytes(raw, 1));
        return;
    }

    // JSON compatibility path (status / older add-on builds)
    if (raw[0] === 0x7b) { // '{'
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            log(`Ignoring malformed datagram from ${rinfo.address}:${rinfo.port}: ${e.message}`);
            return;
        }

        if (msg.cmd === "ping") {
            // Keep JSON pong for older UIs that parse text replies.
            const states = {};
            for (const [ip, session] of sessions) {
                states[ip] = session.state;
            }
            server.send(JSON.stringify({ cmd: "pong", version: VERSION, sessions: states }), rinfo.port, rinfo.address);
            return;
        }

        if (typeof msg.ip === "string" && net.isIPv4(msg.ip)) {
            if (msg.cmd === "disconnect") {
                handleDisconnect(msg.ip);
                return;
            }
            if (Array.isArray(msg.data) && msg.data.length > 0) {
                handleForward(msg.ip, Buffer.from(msg.data));
            }
        }
        return;
    }

    log(`Ignoring unknown datagram (${raw.length} bytes) from ${rinfo.address}:${rinfo.port}`);
});

server.on("error", (err) => {
    console.error(`UDP server error: ${err.message}`);
    process.exit(1);
});

server.bind(LISTEN_PORT, LISTEN_HOST, () => {
    log(`Razer Key Light Chroma proxy v${VERSION} listening on udp://${LISTEN_HOST}:${LISTEN_PORT}`);
    log(`Forwarding to lights on TCP port ${LIGHT_TCP_PORT}, idle timeout ${IDLE_MS} ms`);
});

function shutdown() {
    log("Shutting down");
    for (const session of [...sessions.values()]) {
        session.dispose("proxy shutdown");
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Silence unused-lint style for STATE_NAME in case we expand diagnostics later.
void STATE_NAME;
