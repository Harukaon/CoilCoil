// Isolated E2E runtime only: real OAuth flow and storage, fake token/usage services.
const { readFileSync, appendFileSync } = require("node:fs");
const fixture = process.env.COILCOIL_E2E_ACCOUNTS_FIXTURE;
if (fixture && process.env.ELECTRON_RUN_AS_NODE === "1") {
  let nativeFetch = globalThis.fetch;
  const token = (id, kind) => kind === "anthropic" ? `sk-ant-oat01-alias-e2e-${id}` : `alias-e2e.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${id}` } })).toString("base64url")}.signature`;
  const json = (payload) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  const record = (entry) => appendFileSync(`${fixture}.requests`, JSON.stringify(entry) + "\n");
  const fakeFetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const accounts = JSON.parse(readFileSync(fixture, "utf8"));
    if (url === "https://platform.claude.com/v1/oauth/token" || url === "https://auth.openai.com/oauth/token") {
      const body = url.includes("claude.com") ? JSON.parse(String(options.body)) : Object.fromEntries(new URLSearchParams(String(options.body)));
      const code = body.grant_type === "authorization_code" ? body.code : body.refresh_token;
      const prefix = body.grant_type === "authorization_code" ? "alias-e2e-" : "alias-refresh-";
      if (typeof code !== "string" || !code.startsWith(prefix)) throw new Error("E2E token exchange requires a fake authorization code");
      const id = code.slice(prefix.length);
      const account = accounts[id];
      if (!account) throw new Error("Unknown E2E account");
      if ((account.kind === "anthropic") !== url.includes("claude.com")) throw new Error("Wrong OAuth service for account");
      record({ id, action: body.grant_type });
      return json({ access_token: token(id, account.kind), refresh_token: `alias-refresh-${id}`, expires_in: 3600, token_type: "Bearer", scope: "user:profile user:inference" });
    }
    const kind = url === "https://api.anthropic.com/api/oauth/usage" ? "anthropic" : url === "https://chatgpt.com/backend-api/wham/usage" ? "openai-codex" : undefined;
    if (kind) {
      const headers = new Headers(options.headers);
      const id = Object.keys(accounts).find((id) => headers.get("Authorization") === `Bearer ${token(id, kind)}` && accounts[id].kind === kind);
      if (!id) throw new Error("Quota request did not use its own fake account");
      if (kind === "openai-codex" && headers.get("Chatgpt-Account-Id") !== `account-${id}`) throw new Error("Wrong account ID");
      record({ id, action: "usage" });
      const account = accounts[id];
      const resets = Date.now() + 3600000;
      return json(kind === "anthropic" ? { five_hour: { utilization: account.used, resets_at: new Date(resets).toISOString() }, seven_day: { utilization: account.used + 10, resets_at: new Date(resets + 86400000).toISOString() } }
        : { plan_type: "plus", rate_limit: { primary_window: { used_percent: account.used, limit_window_seconds: 18000, reset_at: Math.floor(resets / 1000) }, secondary_window: { used_percent: account.used + 10, limit_window_seconds: 604800, reset_at: Math.floor((resets + 86400000) / 1000) } } });
    }
    if (url.startsWith("https://")) throw new Error("E2E forbids external HTTPS requests");
    return nativeFetch(input, options);
  };
  // Keep the interceptor when Pi installs its matching Undici implementation.
  Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => fakeFetch, set: (fetch) => { nativeFetch = fetch; } });
}
