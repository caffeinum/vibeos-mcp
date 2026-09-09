/**
 * The remembered token on this machine: ~/.vibeos-mcp/token.json, seven days
 * from minting — the same life the desktop gives a remembered pairing. A
 * token is root on that desktop, so the file is created 0600.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const storeDir = () => process.env.VIBEOS_HOME ?? join(homedir(), ".vibeos-mcp");
export const storePath = () => join(storeDir(), "token.json");

export function loadToken() {
  let raw;
  try { raw = readFileSync(storePath(), "utf8"); } catch { return null; }
  const rec = JSON.parse(raw);
  if (!/^[0-9a-f]{64}$/.test(rec.token) || typeof rec.expires !== "number") {
    throw new Error(`${storePath()} is not a token record; delete it or run: npx vibeos-mcp forget`);
  }
  return rec.expires > Date.now() ? rec : null;
}

export function mintToken() {
  const rec = { token: randomBytes(32).toString("hex"), created: Date.now(), expires: Date.now() + TOKEN_TTL_MS };
  mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(storePath(), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  return rec;
}

export function forgetToken() {
  try { rmSync(storePath()); return true; } catch { return false; }
}
