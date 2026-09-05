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
/** API Gateway posts at most 32 KB per frame; warn well before a frame is cut. */
export const FRAME_WARN_BYTES = 30_000;

/** Close codes (or `bye` frames) that end this socket for good, and why. */
const FINAL = {
  4001: "another vibeos-mcp is using this token; stop one of them, or pair a new token in Settings > Capabilities",
  4003: "the desktop revoked this token in Settings > Capabilities",
};

export class RelaySocket {
  /**
   * @param {string} url
   * @param {string | string[]} url the relay, or relays in order of preference:
   *   a dial that fails before it opens moves to the next; an open socket that
   *   later drops redials the same relay first.
   * @param {{ onFrame: (data: string) => void, onGap: (open: boolean) => void, onEnd: (reason: string) => void, onHello?: (reply: { paired: boolean, instance?: string }) => void, onWarn?: (text: string) => void, hello: object }} handlers
   */
  constructor(url, { onFrame, onGap, onEnd, onHello, onWarn, hello }) {
    this.urls = Array.isArray(url) ? url : [url];
    this.urlIndex = 0;
    this.onWarn = onWarn;
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

  get url() {
    return this.urls[this.urlIndex];
  }

  /** Final for this socket: no redial, every later call fails with `reason`. */
  end(reason) {
    this.ended = true;
    this.stopHeartbeat();
    this.onEnd(reason);
  }

  dial() {
    if (this.ended) return;
    const inner = new WebSocket(this.url);
    this.inner = inner;
    let opened = false;

    inner.on("open", () => {
      if (inner !== this.inner) return;
      opened = true;
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
        // A relay that cannot send custom close codes (API Gateway) says
        // goodbye in-band first. Same meaning as the close code it names.
        if (msg.bye === 4001 || msg.bye === 4003) {
          this.inner = null;
          try { inner.close(); } catch { /* already gone */ }
          this.open = false;
          this.onGap(false);
          this.end(FINAL[msg.bye]);
          return;
        }
      }
      this.onFrame(data);
    });

    let gone_once = false;
    const gone = (code) => {
      // `ws` emits error AND close for one failed dial; count it once, or the
      // url list rotates twice and lands back on the dead relay.
      if (gone_once || inner !== this.inner || this.ended) return;
      gone_once = true;
      this.open = false;
      this.stopHeartbeat();
      this.onGap(false);
      // 4003 is the desktop revoking this token in Settings: final, not a
      // gap. Redialing would attach this side alone and every call would be
      // 4002 forever, which reads as a relay outage rather than a decision.
      // 4001 is another process on this token taking the agent side. Final
      // too: redialing displaced it back, it redialed, and the two flapped
      // every 0.5-2 s for life with neither completing a call — and the tab's
      // answer for one's call id could land in the other's pending slot.
      if (FINAL[code]) {
        this.end(FINAL[code]);
        return;
      }
      // Never opened: this relay is unreachable, try the next one. A relay
      // that was open and dropped (the ~800 s cut, the 2 h API Gateway limit)
      // is redialed as is.
      if (!opened && this.urls.length > 1) {
        const next = (this.urlIndex + 1) % this.urls.length;
        this.onWarn?.(`relay ${this.url} unreachable, trying ${this.urls[next]}`);
        this.urlIndex = next;
      }
      const delay = DELAYS[Math.min(this.attempt++, DELAYS.length - 1)];
      setTimeout(() => this.dial(), delay);
    };
    inner.on("close", (code) => gone(code));
    inner.on("error", () => gone());
  }

  /** Frames sent during a gap are held, not dropped, and flushed on reconnect. */
  send(frame) {
    if (Buffer.byteLength(frame) > FRAME_WARN_BYTES) {
      this.onWarn?.(`frame of ${Buffer.byteLength(frame)} bytes is near the relay's 32 KB limit and may be cut`);
    }
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
