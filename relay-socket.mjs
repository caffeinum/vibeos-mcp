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

export class RelaySocket {
  /**
   * @param {string} url
   * @param {{ onFrame: (data: string) => void, onGap: (open: boolean) => void, onEnd: (reason: string) => void, hello: object }} handlers
   */
  constructor(url, { onFrame, onGap, onEnd, hello }) {
    this.url = url;
    this.onFrame = onFrame;
    this.onGap = onGap;
    this.onEnd = onEnd;
    this.hello = hello;
    this.inner = null;
    this.open = false;
    this.ended = false;
    this.attempt = 0;
    this.held = [];
    this.dial();
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
      this.onGap(true);
    });

    inner.on("message", (raw) => {
      if (inner !== this.inner) return;
      this.onFrame(typeof raw === "string" ? raw : raw.toString("utf8"));
    });

    const gone = (code) => {
      if (inner !== this.inner || this.ended) return;
      this.open = false;
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
    try {
      this.inner?.close();
    } catch {
      // already gone
    }
  }
}
