/**
 * A WebSocket that redials in place.
 *
 * The relay runs on a serverless function with a maximum duration, so a healthy
 * connection is closed roughly every 800 s. Node's WebSocket does not come back
 * from that, so this is the same shape as the tab's RelaySocket in os.js: the
 * caller keeps one object for the life of the process and never sees the gap,
 * except that in-flight work fails fast rather than hanging.
 */
import WebSocket from "ws";

const DELAYS = [500, 1000, 2000, 2000, 2000];
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;

export class RelaySocket {
  /**
   * @param {string} url
   * @param {{ onFrame: (data: string) => void, onGap: (open: boolean) => void, onEnd: (reason: string) => void, onHello?: (reply: { paired: boolean, instance?: string }) => void, hello: object }} handlers
   */
  constructor(url, { onFrame, onGap, onEnd, onHello, hello }) {
    this.url = url;
    this.onFrame = onFrame;
    this.onGap = onGap;
    this.onEnd = onEnd;
    this.onHello = onHello;
    this.hello = hello;
    this.inner = null;
    this.open = false;
    this.ended = false;
    this.attempt = 0;
    this.held = [];
    /** The relay function instance that answered the hello, when it says. */
    this.instance = undefined;
    this.pingTimer = null;
    this.pongTimer = null;
    this.pingSeq = 0;
    this.dial();
  }

  /**
   * A socket that dies without a close event (laptop sleep, network change)
   * looks open forever. So ping the relay; a relay that answers pings (it
   * says so by naming its `instance` in the hello reply) must pong within
   * PONG_WITHIN_MS or the socket is declared dead and redialed. An older relay
   * forwards the ping to the tab as an opaque frame and never pongs, so the
   * deadline is only armed once an instance id has been seen.
   */
  startHeartbeat(inner) {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (inner !== this.inner || !this.open) return;
      const n = ++this.pingSeq;
      inner.send(JSON.stringify({ ping: n }));
      if (this.instance === undefined || this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (inner !== this.inner) return;
        inner.terminate();
      }, PONG_WITHIN_MS);
    }, PING_EVERY_MS);
  }

  stopHeartbeat() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  dial() {
    if (this.ended) return;
    const inner = new WebSocket(this.url);
    this.inner = inner;

    inner.on("open", () => {
      if (inner !== this.inner) return;
      this.attempt = 0;
      this.open = true;
      // The token goes in the first frame, never the URL: a URL reaches logs,
      // proxies and Referer headers, and this token is root on the desktop.
      inner.send(JSON.stringify(this.hello));
      for (const frame of this.held.splice(0)) inner.send(frame);
      this.startHeartbeat(inner);
      this.onGap(true);
    });

    inner.on("message", (raw) => {
      if (inner !== this.inner) return;
      const data = typeof raw === "string" ? raw : raw.toString("utf8");
      // The relay's own frames: the hello reply and pongs. Everything else is
      // the tab's and goes through untouched.
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        msg = null;
      }
      if (msg && typeof msg === "object") {
        if (typeof msg.pong === "number") {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
          if (typeof msg.instance === "string") this.instance = msg.instance;
          return;
        }
        if (typeof msg.paired === "boolean") {
          if (typeof msg.instance === "string") this.instance = msg.instance;
          this.onHello?.({ paired: msg.paired, instance: this.instance });
          return;
        }
      }
      this.onFrame(data);
    });

    const gone = (code) => {
      if (inner !== this.inner || this.ended) return;
      this.open = false;
      this.stopHeartbeat();
      this.onGap(false);
      // 4003 is the desktop revoking this token in Settings: final, not a
      // gap. Redialing would attach this side alone and every call would be
      // 4002 forever, which reads as a relay outage rather than a decision.
      if (code === 4003) {
        this.ended = true;
        this.onEnd("the desktop revoked this token in Settings > Capabilities");
        return;
      }
      // 4001 is another process on this token taking the agent side. Final
      // too: redialing displaced it back, it redialed, and the two flapped
      // every 0.5-2 s for life with neither completing a call — and the tab's
      // answer for one's call id could land in the other's pending slot.
      if (code === 4001) {
        this.ended = true;
        this.onEnd("another vibeos-mcp is using this token; stop one of them, or pair a new token in Settings > Capabilities");
        return;
      }
      const delay = DELAYS[Math.min(this.attempt++, DELAYS.length - 1)];
      setTimeout(() => this.dial(), delay);
    };
    inner.on("close", (code) => gone(code));
    inner.on("error", () => gone());
  }

  /** Frames sent during a gap are held, not dropped, and flushed on reconnect. */
  send(frame) {
    if (this.open && this.inner) this.inner.send(frame);
    else this.held.push(frame);
  }

  close() {
    this.ended = true;
    this.stopHeartbeat();
    try {
      this.inner?.close();
    } catch {
      // already gone
    }
  }
}
