import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { powerSaveBlocker } from "electron";
import type {
  DesktopPlatform,
  RemoteAccessInput,
  RemoteAccessState,
  RemoteTunnelMode,
} from "../../shared/desktop-api";
import { RemoteServer } from "./remote-server";

const DEFAULT_PORT = 7788;
const DEFAULT_HOST = "127.0.0.1";

interface StoredRemoteConfig {
  enabled: boolean;
  port: number;
  host: string;
  mode: RemoteTunnelMode;
  publicUrl?: string;
  keepAwake: boolean;
  trustLocalNetwork: boolean;
  /** The user's own scratch notes for this screen; never interpreted. */
  notes?: string;
}

/**
 * Which address the entry point listens on, derived rather than stored.
 *
 * Tailscale has to be reached on the tailnet address, while a reverse proxy
 * tunnels into loopback — so the two modes need different hosts. Storing the
 * live one would mean switching to Tailscale overwrites the proxy setup's host
 * and switching back leaves the entry point on an address the tunnel does not
 * reach. Deriving it keeps `host` meaning "what the user chose for the proxy",
 * which is the only value worth remembering.
 */
/**
 * Undo the old behaviour, which wrote the live listening address into `host`.
 *
 * A config saved by an earlier build can carry `0.0.0.0` or a tailnet address
 * there. Kept as-is, switching back to the reverse proxy would leave the entry
 * point on an address the tunnel never reaches, which is exactly the bug the
 * derived host fixes — so those two shapes are read back as the loopback
 * default they should have been.
 */
function storedProxyHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host || host === "0.0.0.0") return DEFAULT_HOST;
  const [a, b] = host.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 100 && b >= 64 && b <= 127) return DEFAULT_HOST;
  return host;
}

function listenHost(config: StoredRemoteConfig): string {
  if (config.mode !== "tailscale") return config.host;
  return tailscaleAddress() ?? "0.0.0.0";
}

/**
 * This Mac's address inside the tailnet, when Tailscale is running.
 *
 * Tailscale gives every node an address in the range it reserves for the
 * tailnet, so the interface list is enough to find it — no need to shell out to
 * the Tailscale CLI, which may not be on PATH for a GUI app.
 */
export function tailscaleAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [a, b] = address.address.split(".").map((part) => Number.parseInt(part, 10));
      if (a === 100 && b >= 64 && b <= 127) return address.address;
    }
  }
  return undefined;
}

export interface RemoteAccessOptions {
  configFile: string;
  authFile: string;
  platform: DesktopPlatform;
  rendererUrl?: string;
  rendererDir: string;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void;
  onStateChanged(state: RemoteAccessState): void;
}

function normalizePort(value: unknown, fallback: number): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeMode(value: unknown): RemoteTunnelMode {
  return value === "tailscale" ? "tailscale" : "reverse-proxy";
}

/**
 * Owns everything about remote access that outlives a single window.
 *
 * The switch, the port, the pairing code and the sleep policy all live here so
 * the settings screen has one thing to talk to, and so turning remote access on
 * or off takes effect immediately instead of at the next launch.
 */
export class RemoteAccessController {
  private config: StoredRemoteConfig;
  private server?: RemoteServer;
  private blockerId?: number;
  private failure?: string;

  constructor(private readonly options: RemoteAccessOptions) {
    this.config = this.load();
  }

  private load(): StoredRemoteConfig {
    let stored: Partial<StoredRemoteConfig> = {};
    try {
      stored = JSON.parse(readFileSync(this.options.configFile, "utf8")) as Partial<StoredRemoteConfig>;
    } catch {
      stored = {};
    }
    // The environment still wins, so a one-off `npm run dev` can override the
    // stored switch without changing what the app does next time.
    const forced = process.env.COILCOIL_REMOTE === "1" || !!process.env.COILCOIL_REMOTE_PORT;
    return {
      enabled: forced || stored.enabled === true,
      port: normalizePort(process.env.COILCOIL_REMOTE_PORT ?? stored.port, DEFAULT_PORT),
      host: process.env.COILCOIL_REMOTE_HOST?.trim() || storedProxyHost(stored.host),
      mode: normalizeMode(stored.mode),
      publicUrl: typeof stored.publicUrl === "string" && stored.publicUrl.trim() ? stored.publicUrl.trim() : undefined,
      keepAwake: stored.keepAwake === true,
      // On by default only for Tailscale, where every peer is already a machine
      // the user signed into their own tailnet.
      trustLocalNetwork: stored.trustLocalNetwork ?? normalizeMode(stored.mode) === "tailscale",
      notes: typeof stored.notes === "string" ? stored.notes : undefined,
    };
  }

  private persist(): void {
    try {
      writeFileSync(this.options.configFile, `${JSON.stringify(this.config, undefined, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.options.log("error", "remote_config_write_failed", { message: String(error) });
    }
  }

  state(): RemoteAccessState {
    return {
      enabled: this.config.enabled,
      running: !!this.server,
      port: this.config.port,
      host: listenHost(this.config),
      mode: this.config.mode,
      publicUrl: this.config.publicUrl,
      notes: this.config.notes ?? "",
      keepAwake: this.config.keepAwake,
      trustLocalNetwork: this.config.trustLocalNetwork,
      username: this.server?.auth.username() ?? this.pendingUsername,
      tailscaleAddress: tailscaleAddress(),
      keepAwakeActive: this.blockerId !== undefined && powerSaveBlocker.isStarted(this.blockerId),
      // A pairing code is only meaningful while something is listening for it.
      pairingCode: this.server ? this.server.auth.pairingCode() : undefined,
      devices: this.server ? this.server.auth.roster() : [],
      connectedClients: this.server?.connectedClients() ?? 0,
      error: this.failure,
    };
  }

  private publish(): void {
    this.options.onStateChanged(this.state());
  }

  async apply(input: RemoteAccessInput): Promise<RemoteAccessState> {
    const next: StoredRemoteConfig = {
      enabled: input.enabled ?? this.config.enabled,
      port: input.port === undefined ? this.config.port : normalizePort(input.port, this.config.port),
      host: input.host === undefined ? this.config.host : (input.host.trim() || DEFAULT_HOST),
      mode: input.mode === undefined ? this.config.mode : normalizeMode(input.mode),
      publicUrl: input.publicUrl === undefined ? this.config.publicUrl : (input.publicUrl.trim() || undefined),
      keepAwake: input.keepAwake ?? this.config.keepAwake,
      trustLocalNetwork: input.trustLocalNetwork ?? this.config.trustLocalNetwork,
      notes: input.notes === undefined ? this.config.notes : input.notes,
    };
    // Restarting on every save would drop a connected phone for a change it
    // does not care about, so only the values the server is built from count.
    const restart = this.server !== undefined
      && (next.port !== this.config.port || listenHost(next) !== listenHost(this.config));
    this.config = next;
    this.persist();

    if (!next.enabled || restart) this.stopServer();
    if (next.enabled && !this.server) await this.startServer();
    this.applyKeepAwake();
    this.publish();
    return this.state();
  }

  /** A username saved while the entry point was stopped, applied once it starts. */
  private pendingUsername?: string;

  /** Set or clear the account that can sign in without a pairing code. */
  setAccount(username: string, password: string): RemoteAccessState {
    if (!username.trim() || !password) {
      this.server?.auth.clearPassword();
      this.pendingUsername = undefined;
    } else {
      this.pendingUsername = username.trim();
      this.server?.auth.setPassword(username, password);
    }
    this.publish();
    return this.state();
  }

  /** Forward a main-process push to whoever is holding the remote control. */
  broadcast(channel: string, payload: unknown): void {
    this.server?.broadcast(channel, payload);
  }

  /** Invalidate the current code without touching devices already paired. */
  regenerateCode(): RemoteAccessState {
    this.server?.auth.rotateCode();
    this.publish();
    return this.state();
  }

  revokeDevices(): RemoteAccessState {
    this.server?.auth.revokeAll();
    this.publish();
    return this.state();
  }

  async start(): Promise<void> {
    if (this.config.enabled) await this.startServer();
    this.applyKeepAwake();
    this.publish();
  }

  private async startServer(): Promise<void> {
    if (this.server) return;
    const server = new RemoteServer({
      host: listenHost(this.config),
      port: this.config.port,
      platform: this.options.platform,
      rendererUrl: this.options.rendererUrl,
      rendererDir: this.options.rendererDir,
      authFile: this.options.authFile,
      // The Vite page at localhost:5173 is a local development client for
      // this exact Electron process. It must not be forced through pairing,
      // while packaged/remote access keeps the normal auth gate.
      allowLoopback: Boolean(this.options.rendererUrl),
      invoke: this.options.invoke,
      log: this.options.log,
      trustLocalNetwork: () => this.config.trustLocalNetwork,
      onClientsChanged: () => this.publish(),
    });
    try {
      const address = await server.start();
      this.server = server;
      this.failure = undefined;
      this.options.log("info", "remote_ready", { address });
    } catch (error) {
      // The usual cause is the port already being in use, and the settings
      // screen is where that has to be readable.
      this.failure = error instanceof Error ? error.message : String(error);
      this.options.log("error", "remote_start_failed", { message: this.failure });
    }
  }

  private stopServer(): void {
    this.server?.stop();
    this.server = undefined;
  }

  /**
   * Keep the Mac awake while it is someone's remote machine.
   *
   * macOS asks for no permission here: the app declares that the system must
   * not idle-sleep, the same assertion `caffeinate` makes. The display is left
   * free to sleep, and closing the lid still suspends the machine — no
   * software can override that.
   */
  private applyKeepAwake(): void {
    const wanted = this.config.enabled && this.config.keepAwake;
    if (wanted && this.blockerId === undefined) {
      this.blockerId = powerSaveBlocker.start("prevent-app-suspension");
      this.options.log("info", "remote_keep_awake_started", {});
      return;
    }
    if (!wanted && this.blockerId !== undefined) {
      if (powerSaveBlocker.isStarted(this.blockerId)) powerSaveBlocker.stop(this.blockerId);
      this.blockerId = undefined;
      this.options.log("info", "remote_keep_awake_stopped", {});
    }
  }

  stop(): void {
    this.stopServer();
    if (this.blockerId !== undefined && powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId);
    }
    this.blockerId = undefined;
  }
}
