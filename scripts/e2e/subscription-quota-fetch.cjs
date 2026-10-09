// Test-process preload only. Exercises the real runtime command/auth path while
// replacing official usage GETs with file-backed, deterministic account data.
const { readFileSync, appendFileSync } = require("node:fs");
const fixture = process.env.COILCOIL_E2E_QUOTA_FIXTURE;
if (fixture && process.env.ELECTRON_RUN_AS_NODE === "1") {
  let nativeFetch = globalThis.fetch;
  const providers = new Map([
    ["https://api.anthropic.com/api/oauth/usage", "anthropic"],
    ["https://chatgpt.com/backend-api/wham/usage", "openai-codex"],
  ]);
  const quotaFetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const provider = providers.get(url);
    if (!provider) {
      if (url.startsWith("https://")) throw new Error("E2E forbids external HTTPS requests");
      return nativeFetch(input, options);
    }
    const headers = new Headers(options.headers);
    if (!headers.get("Authorization")?.startsWith("Bearer quota-e2e")) throw new Error("E2E quota requires fake credentials");
    if (provider === "openai-codex" && headers.get("Chatgpt-Account-Id") !== "account-e2e") throw new Error("Missing quota account header");
    const data = JSON.parse(readFileSync(fixture, "utf8"))[provider];
    appendFileSync(`${fixture}.requests`, JSON.stringify({ provider, phase: "started" }) + "\n");
    if (data.delayMs) await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, data.delayMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    appendFileSync(`${fixture}.requests`, JSON.stringify({ provider, phase: "finished" }) + "\n");
    return new Response(JSON.stringify(data.payload), { status: data.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  // Pi installs its Undici fetch during startup. Retain the test interception
  // while allowing that installation to update the local-HTTP implementation.
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    get: () => quotaFetch,
    set: (fetch) => { nativeFetch = fetch; },
  });
}
