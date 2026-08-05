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
// The proxy holds no connection while SignalRGB is idle or closed: sessions
// are opened on the first packet for a light and torn down after an idle
// timeout (or an explicit disconnect command), which releases the light for
// Synapse or other controllers.
//
// Datagram format (JSON, one object per datagram):
//   {"ip": "192.168.1.120", "data": [ ...raw packet bytes... ]}  forward packet
//   {"ip": "192.168.1.120", "cmd": "disconnect"}                 close session now
//   {"cmd": "ping"}                                              reply {"cmd":"pong",...}
//
// Configuration (env vars):
//   KEYLIGHT_PROXY_PORT  UDP port to listen on (loopback only). Default 10077.
//   KEYLIGHT_TCP_PORT    TCP port of the lights. Default 10003 (override for tests).
//   KEYLIGHT_IDLE_MS     Close a light's TCP session after this much silence
//                        from SignalRGB. Default 30000.
//   KEYLIGHT_PROXY_LOG   Log file path. Defaults to keylight-proxy.log next to
//                        this script. Set to "" to disable file logging.

const dgram = require("dgram");
const net = require("net");
const fs = require("fs");
const path = require("path");

const VERSION = "0.4.0"; // keep in sync with the add-on's Version()
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = parseInt(process.env.KEYLIGHT_PROXY_PORT || "10077", 10);
const LIGHT_TCP_PORT = parseInt(process.env.KEYLIGHT_TCP_PORT || "10003", 10);
const IDLE_MS = parseInt(process.env.KEYLIGHT_IDLE_MS || "30000", 10);
const RECONNECT_COOLDOWN_MS = 2000;
// Optional pacing between TCP packets. Default 0: packets are framed
// (fixed 105 bytes) and the socket has NoDelay, so spacing only adds latency.
const SEND_SPACING_MS = parseInt(process.env.KEYLIGHT_SEND_SPACING_MS || "0", 10);
const QUEUE_LIMIT = 16;

// A light whose Wi-Fi radio dropped into power-save doze ignores the first
// connection attempt, but the attempt itself wakes the radio (documented in
// the original controller project). Retry with widening gaps before giving up.
const WAKE_RETRY_BACKOFF_MS = [300, 600, 1000, 1500];
const CONNECT_TIMEOUT_MS = 2000;

// If more than ~3 packets of unsent bytes sit in the socket (Wi-Fi hiccup),
// hold the queue instead of buffering stale colors behind the congestion;
// color coalescing keeps only the newest frame while we wait.
const BACKPRESSURE_BYTES = 315;
const BACKPRESSURE_POLL_MS = 10;

// C_RGB packets supersede each other: if one is already waiting (e.g. during
// the handshake), replace it instead of queueing a stale color behind it.
function isColorPacket(bytes) {
    return bytes[10] === 0x0c && bytes[11] === 0x0f && bytes[12] === 0x02;
}

// ----------------------------- logging --------------------------------------

const LOG_PATH = process.env.KEYLIGHT_PROXY_LOG !== undefined
    ? process.env.KEYLIGHT_PROXY_LOG
    : path.join(__dirname, "keylight-proxy.log");

if (LOG_PATH) {
    try {
        // Rotate if larger than 5 MB to avoid unbounded growth.
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

// Registration payload from the reverse-engineered protocol
// ("H\0I\1...Synapse3"). Packet framing matches the add-on's buildPacket().
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

// ip -> Session
const sessions = new Map();
// ip -> timestamp of last failed/closed connection, for reconnect cooldown
const cooldowns = new Map();

class Session {
    constructor(ip) {
        this.ip = ip;
        this.state = "connecting"; // connecting | hello-sent | registration-sent | ready
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
        socket.setKeepAlive(true, 15000);
        // Inactivity timeout guards the connect/handshake phase; a dozing
        // light can leave a bare connect hanging for many seconds.
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
                socket.setTimeout(0); // streaming is one-way; silence is normal now
                log(`[${this.ip}] registration complete, ${this.queue.length} packet(s) queued`);
                this.drain();
                return;
            }

            // Later replies are drained and ignored to keep the connection healthy.
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
                // Established connection dropped; the next packet reopens it
                // (with fresh wake retries of its own).
                log(`[${this.ip}] TCP connection closed`);
                this.dispose("closed by peer or error");
                return;
            }

            // Connect or handshake failed — often just a dozing radio that the
            // attempt itself woke up. Keep the queue and retry with backoff.
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

        if (isColorPacket(bytes)) {
            const waitingColor = this.queue.findIndex(isColorPacket);
            if (waitingColor !== -1) {
                this.queue[waitingColor] = bytes;
                this.drain();
                return;
            }
        }

        this.queue.push(bytes);
        if (this.queue.length > QUEUE_LIMIT) {
            this.queue.shift();
        }
        this.drain();
    }

    drain() {
        if (this.draining || this.state !== "ready" || this.closed) {
            return;
        }

        while (this.queue.length > 0) {
            // Congested socket (Wi-Fi hiccup): pause instead of stacking stale
            // packets behind it. Coalescing keeps the queued color current.
            if (this.socket.writableLength > BACKPRESSURE_BYTES) {
                if (this.backpressureTimer === null) {
                    this.backpressureTimer = setTimeout(() => {
                        this.backpressureTimer = null;
                        this.drain();
                    }, BACKPRESSURE_POLL_MS);
                }
                return;
            }

            this.socket.write(Buffer.from(this.queue.shift()));

            if (SEND_SPACING_MS > 0) {
                // Optional debug pacing between packets.
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
        return undefined; // still cooling down; drop the packet, the add-on re-sends
    }

    log(`[${ip}] opening TCP session to port ${LIGHT_TCP_PORT}`);
    const session = new Session(ip);
    sessions.set(ip, session);
    return session;
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
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch (e) {
        log(`Ignoring malformed datagram from ${rinfo.address}:${rinfo.port}: ${e.message}`);
        return;
    }

    if (msg.cmd === "ping") {
        const states = {};
        for (const [ip, session] of sessions) {
            states[ip] = session.state;
        }
        const pong = JSON.stringify({ cmd: "pong", version: VERSION, sessions: states });
        server.send(pong, rinfo.port, rinfo.address);
        return;
    }

    if (typeof msg.ip !== "string" || net.isIPv4(msg.ip) === false) {
        log(`Ignoring datagram without valid "ip" from ${rinfo.address}:${rinfo.port}`);
        return;
    }

    if (msg.cmd === "disconnect") {
        const session = sessions.get(msg.ip);
        if (session !== undefined) {
            session.dispose("disconnect requested by add-on");
        }
        return;
    }

    if (Array.isArray(msg.data) && msg.data.length > 0) {
        const session = getOrCreateSession(msg.ip);
        if (session !== undefined) {
            session.enqueue(msg.data);
        }
    }
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
