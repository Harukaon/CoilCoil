import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import WebSocket from "ws";

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BrowserDebugEvent {
  sequence: number;
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface PausedCallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  line: number;
  column: number;
  scopes: Array<{ type: string; name?: string; objectId?: string; description?: string }>;
}

interface ActiveTargetResult {
  activePageTargetId?: string;
  activeTabId?: string;
  tabs?: Array<{ id: string; pageTargetId: string; title: string; url: string; active: boolean }>;
}

interface NetworkRecord {
  requestId: string;
  startedAt: number;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  type?: string;
  finishedAt?: number;
  failed?: Record<string, unknown>;
}

const MAX_EVENTS = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pausedCallFrames(params: Record<string, unknown>): PausedCallFrame[] {
  const frames = Array.isArray(params.callFrames) ? params.callFrames : [];
  return frames.flatMap((value) => {
    const frame = record(value);
    const location = record(frame.location);
    const callFrameId = stringValue(frame.callFrameId);
    if (!callFrameId) return [];
    const scopes = Array.isArray(frame.scopeChain) ? frame.scopeChain : [];
    return [{
      callFrameId,
      functionName: stringValue(frame.functionName) || "(anonymous)",
      url: stringValue(frame.url) || "",
      line: (numberValue(location.lineNumber) ?? 0) + 1,
      column: (numberValue(location.columnNumber) ?? 0) + 1,
      scopes: scopes.map((scopeValue) => {
        const scope = record(scopeValue);
        const object = record(scope.object);
        return {
          type: stringValue(scope.type) || "unknown",
          ...(stringValue(scope.name) ? { name: stringValue(scope.name) } : {}),
          ...(stringValue(object.objectId) ? { objectId: stringValue(object.objectId) } : {}),
          ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
        };
      }),
    }];
  });
}

export class BrowserDebugClient {
  private readonly endpoint: string;
  private readonly token: string;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private nextSequence = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: BrowserDebugEvent[] = [];
  private pageTargetId?: string;
  private pageSessionId?: string;
  private paused?: BrowserDebugEvent;
  private networkRecordingStartedAt?: number;
  private networkRecordingActive = false;
  private readonly pausedRequests = new Map<string, BrowserDebugEvent>();
  private readonly webSocketUrls = new Map<string, string>();

  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint;
    this.token = token;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.pageSessionId = undefined;
    this.pageTargetId = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  async command<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("内置浏览器调试连接尚未就绪。");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器调试命令超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async activeSession(): Promise<{ sessionId: string; target: ActiveTargetResult }> {
    const target = await this.command<ActiveTargetResult>("SuoCode.getBrowserState");
    if (!target.activePageTargetId) throw new Error("当前没有可调试的内置浏览器标签页。");
    if (this.pageTargetId !== target.activePageTargetId || !this.pageSessionId) {
      if (this.pageSessionId) {
        await this.command("Target.detachFromTarget", { sessionId: this.pageSessionId }).catch(() => {});
      }
      this.resetTargetState();
      const attached = await this.command<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.activePageTargetId,
        flatten: true,
      });
      this.pageTargetId = target.activePageTargetId;
      this.pageSessionId = attached.sessionId;
      this.paused = undefined;
    }
    return { sessionId: this.pageSessionId, target };
  }

  async pageCommand<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const { sessionId } = await this.activeSession();
    return this.command<T>(method, params, sessionId);
  }

  eventLog(options: { methods?: string[]; sinceSequence?: number; limit?: number } = {}): BrowserDebugEvent[] {
    const methods = options.methods?.length ? new Set(options.methods) : undefined;
    const filtered = this.events.filter((event) =>
      (!methods || methods.has(event.method))
      && event.sequence > (options.sinceSequence ?? 0));
    return filtered.slice(-Math.max(1, Math.min(options.limit ?? 100, 500)));
  }

  latestPaused(): BrowserDebugEvent | undefined {
    return this.paused;
  }

  async waitForEvent(options: { methods: string[]; timeoutMs?: number; text?: string; sinceSequence?: number }): Promise<BrowserDebugEvent> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 300_000));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const event = this.eventLog({ methods: options.methods, sinceSequence: options.sinceSequence, limit: 500 })
        .find((candidate) => !options.text || JSON.stringify(candidate.params).includes(options.text));
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待浏览器事件超时：${options.methods.join(", ")}`);
  }

  startNetworkRecording(): void {
    this.networkRecordingStartedAt = Date.now();
    this.networkRecordingActive = true;
  }

  stopNetworkRecording(): void {
    this.networkRecordingActive = false;
  }

  isNetworkRecording(): boolean {
    return this.networkRecordingActive;
  }

  pausedNetworkRequests(): BrowserDebugEvent[] {
    return [...this.pausedRequests.values()];
  }

  resolvePausedRequest(requestId: string): void {
    this.pausedRequests.delete(requestId);
  }

  webSocketUrl(requestId: string): string | undefined {
    return this.webSocketUrls.get(requestId);
  }

  networkRecords(): NetworkRecord[] {
    const since = this.networkRecordingStartedAt ?? 0;
    const records = new Map<string, NetworkRecord>();
    for (const event of this.events) {
      if (event.timestamp < since || !event.method.startsWith("Network.")) continue;
      const requestId = stringValue(event.params.requestId);
      if (!requestId) continue;
      const current = records.get(requestId) ?? { requestId, startedAt: event.timestamp };
      if (event.method === "Network.requestWillBeSent") {
        current.request = record(event.params.request);
        current.type = stringValue(event.params.type);
      } else if (event.method === "Network.responseReceived") {
        current.response = record(event.params.response);
        current.type = stringValue(event.params.type) || current.type;
      } else if (event.method === "Network.loadingFinished") current.finishedAt = event.timestamp;
      else if (event.method === "Network.loadingFailed") {
        current.finishedAt = event.timestamp;
        current.failed = event.params;
      }
      records.set(requestId, current);
    }
    return [...records.values()];
  }

  async exportHar(path: string): Promise<{ path: string; entries: number }> {
    const entries = this.networkRecords().map((item) => {
      const request = item.request ?? {};
      const response = item.response ?? {};
      return {
        startedDateTime: new Date(item.startedAt).toISOString(),
        time: Math.max(0, (item.finishedAt ?? Date.now()) - item.startedAt),
        request: {
          method: stringValue(request.method) || "GET",
          url: stringValue(request.url) || "",
          httpVersion: "HTTP/1.1",
          headers: Object.entries(record(request.headers)).map(([name, value]) => ({ name, value: String(value) })),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: typeof request.postData === "string" ? Buffer.byteLength(request.postData) : -1,
        },
        response: {
          status: numberValue(response.status) ?? 0,
          statusText: stringValue(response.statusText) || "",
          httpVersion: stringValue(response.protocol) || "HTTP/1.1",
          headers: Object.entries(record(response.headers)).map(([name, value]) => ({ name, value: String(value) })),
          cookies: [],
          content: { size: numberValue(response.encodedDataLength) ?? 0, mimeType: stringValue(response.mimeType) || "" },
          redirectURL: "",
          headersSize: -1,
          bodySize: numberValue(response.encodedDataLength) ?? -1,
        },
        cache: {},
        timings: { send: 0, wait: Math.max(0, (item.finishedAt ?? Date.now()) - item.startedAt), receive: 0 },
        ...(item.failed ? { _failure: item.failed } : {}),
      };
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ log: { version: "1.2", creator: { name: "SuoCode", version: "0.1.0" }, pages: [], entries } }, null, 2)}\n`);
    return { path, entries: entries.length };
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint, { headers: { Authorization: `Bearer ${this.token}` } });
      const fail = (error: Error): void => {
        if (this.socket === socket) this.socket = undefined;
        reject(error);
      };
      socket.once("open", () => {
        socket.off("error", fail);
        this.socket = socket;
        socket.on("message", (value) => this.handleMessage(value.toString()));
        socket.once("close", () => this.handleClosed(new Error("内置浏览器调试连接已关闭。")));
        socket.once("error", (error) => this.handleClosed(error));
        resolve();
      });
      socket.once("error", fail);
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as CdpResponse;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `CDP error ${message.error.code ?? ""}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const event: BrowserDebugEvent = {
      sequence: this.nextSequence++,
      timestamp: Date.now(),
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (message.method === "Debugger.paused") this.paused = event;
    else if (message.method === "Debugger.resumed") this.paused = undefined;
    else if (message.method === "Fetch.requestPaused") {
      const requestId = stringValue(event.params.requestId);
      if (requestId) this.pausedRequests.set(requestId, event);
    } else if (message.method === "Network.webSocketCreated") {
      const requestId = stringValue(event.params.requestId);
      const url = stringValue(event.params.url);
      if (requestId && url) this.webSocketUrls.set(requestId, url);
    }
  }

  private resetTargetState(): void {
    this.events.length = 0;
    this.paused = undefined;
    this.pausedRequests.clear();
    this.webSocketUrls.clear();
    this.networkRecordingStartedAt = undefined;
    this.networkRecordingActive = false;
  }

  private handleClosed(error: Error): void {
    this.socket = undefined;
    this.pageSessionId = undefined;
    this.pageTargetId = undefined;
    this.resetTargetState();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
