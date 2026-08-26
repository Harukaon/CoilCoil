import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RemotePasswordCredential {
  username: string;
  salt: string;
  hash: string;
}

export interface RemoteDevice {
  token: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
}

/** Wrong codes cost nothing to try, so a short lockout is what makes six digits enough. */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 60_000;

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

/**
 * Networks whose members are already the user's own machines.
 *
 * Tailscale hands every node an address in the CGNAT range it reserves for the
 * tailnet, and a home LAN uses the private ranges. Loopback is deliberately
 * absent: the reverse-proxy tunnel arrives on loopback, so trusting it would
 * hand the whole internet a free pass through the proxy.
 */
function isTrustedAddress(address: string): boolean {
  const value = address.startsWith("::ffff:") ? address.slice(7) : address;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  // Tailscale's tailnet range, 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export { isTrustedAddress };

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free
  // answer: tokens are fixed width, so a different length is simply not ours.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Who is allowed to drive this Mac from somewhere else.
 *
 * The remote entry point is equivalent to an unlocked shell, so the tunnel is
 * never the only thing standing in front of it. A phone pairs once with a code
 * shown on the Mac and then holds a long-lived device token; the Mac keeps the
 * roster and can drop any device.
 */
export class RemoteAuth {
  private devices: RemoteDevice[] = [];
  private credential?: RemotePasswordCredential;
  private code = newCode();
  private attempts = 0;
  private lockedUntil = 0;

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        devices?: RemoteDevice[];
        credential?: RemotePasswordCredential;
      };
      if (Array.isArray(raw.devices)) this.devices = raw.devices.filter((device) => typeof device?.token === "string");
      const credential = raw.credential;
      if (credential && typeof credential.username === "string" && typeof credential.hash === "string") {
        this.credential = credential;
      }
    } catch {
      this.devices = [];
      this.credential = undefined;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      `${JSON.stringify({ devices: this.devices, credential: this.credential }, undefined, 2)}\n`,
      { mode: 0o600 },
    );
  }

  /** The code to read off the Mac's screen. Rotates after every successful pairing. */
  pairingCode(): string {
    return this.code;
  }

  rotateCode(): string {
    this.code = newCode();
    this.attempts = 0;
    this.lockedUntil = 0;
    return this.code;
  }

  pair(code: string, name: string, now = Date.now()): RemoteDevice | undefined {
    if (now < this.lockedUntil) return undefined;
    if (!equals(code.trim(), this.code)) {
      this.attempts += 1;
      if (this.attempts >= MAX_ATTEMPTS) {
        this.lockedUntil = now + LOCKOUT_MS;
        this.rotateCode();
      }
      return undefined;
    }
    const device = this.issue(name, now);
    this.rotateCode();
    return device;
  }

  /** The account name to show in settings, or undefined when none is set. */
  username(): string | undefined {
    return this.credential?.username;
  }

  setPassword(username: string, password: string): void {
    const salt = randomBytes(16).toString("hex");
    this.credential = { username: username.trim().slice(0, 60), salt, hash: hashPassword(password, salt) };
    this.save();
  }

  clearPassword(): void {
    this.credential = undefined;
    this.save();
  }

  /**
   * Sign in with the configured account.
   *
   * Rate limited by the same counter as the pairing code, because both are
   * guessable secrets typed on a phone.
   */
  signIn(username: string, password: string, name: string, now = Date.now()): RemoteDevice | undefined {
    if (now < this.lockedUntil) return undefined;
    const credential = this.credential;
    if (!credential || !password) return undefined;
    const matches = equals(username.trim(), credential.username)
      && equals(hashPassword(password, credential.salt), credential.hash);
    if (!matches) {
      this.attempts += 1;
      if (this.attempts >= MAX_ATTEMPTS) this.lockedUntil = now + LOCKOUT_MS;
      return undefined;
    }
    return this.issue(name, now);
  }

  /**
   * Hand out a device token.
   *
   * One phone at a time, by design: a new sign-in retires whatever held access
   * before it, so a stolen or forgotten phone stops working the moment another
   * device is admitted.
   */
  private issue(name: string, now: number): RemoteDevice {
    const device: RemoteDevice = {
      token: newToken(),
      name: name.slice(0, 60) || "未命名设备",
      pairedAt: now,
      lastSeenAt: now,
    };
    this.devices = [device];
    this.save();
    return device;
  }

  verify(token: string | undefined, now = Date.now()): RemoteDevice | undefined {
    if (!token) return undefined;
    const device = this.devices.find((candidate) => equals(candidate.token, token));
    if (!device) return undefined;
    device.lastSeenAt = now;
    return device;
  }

  /** Devices without their tokens, for anything that displays the roster. */
  roster(): Omit<RemoteDevice, "token">[] {
    return this.devices.map(({ token: _token, ...rest }) => rest);
  }

  revokeAll(): void {
    this.devices = [];
    this.save();
  }

  lockedOut(now = Date.now()): boolean {
    return now < this.lockedUntil;
  }

  /** lastSeenAt only matters once it survives a restart; flushing on shutdown is enough. */
  flush(): void {
    this.save();
  }
}
