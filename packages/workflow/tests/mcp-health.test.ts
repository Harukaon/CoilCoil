import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialHealth,
  collectEnvPlaceholders,
  markToolResult,
  piConfigPath,
} from "../extensions/mcp-health.ts";

test("MCP health uses the SuoCode-owned Agent directory", () => {
  assert.equal(
    piConfigPath({ PI_CODING_AGENT_DIR: "/tmp/suocode-agent" }),
    "/tmp/suocode-agent/mcp.json",
  );
});

test("MCP health finds nested environment placeholders", () => {
  const placeholders = collectEnvPlaceholders({
    headers: {
      authorization: "Bearer ${FIRECRAWL_API_KEY}",
    },
    env: ["$env:SECOND_TOKEN", "unchanged"],
  });

  assert.deepEqual([...placeholders].sort(), [
    "FIRECRAWL_API_KEY",
    "SECOND_TOKEN",
  ]);
});

test("MCP health distinguishes missing and inherited environment", () => {
  const servers = {
    firecrawl: {
      headers: {
        "x-firecrawl-api-key": "${FIRECRAWL_API_KEY}",
      },
    },
  };

  const missing = buildInitialHealth(servers, {});
  assert.equal(missing.get("firecrawl")?.auth, "failed");
  assert.deepEqual(missing.get("firecrawl")?.missingEnv, [
    "FIRECRAWL_API_KEY",
  ]);

  const inherited = buildInitialHealth(servers, {
    FIRECRAWL_API_KEY: "present-but-never-returned",
  });
  assert.equal(inherited.get("firecrawl")?.auth, "env-ready");
  assert.deepEqual(inherited.get("firecrawl")?.missingEnv, []);
});

test("MCP health records successful and failed live calls", () => {
  const health = buildInitialHealth({
    firecrawl: {
      headers: {
        "x-firecrawl-api-key": "${FIRECRAWL_API_KEY}",
      },
    },
  }, { FIRECRAWL_API_KEY: "present-but-never-returned" });

  markToolResult(
    health,
    "firecrawl_firecrawl_search",
    [{ type: "text", text: "search completed" }],
    false,
  );
  assert.equal(health.get("firecrawl")?.auth, "verified");

  markToolResult(
    health,
    "mcp",
    { server: "firecrawl", error: "invalid_token" },
    true,
  );
  assert.equal(health.get("firecrawl")?.auth, "failed");
  assert.equal(health.get("firecrawl")?.failure, "凭证无效或未继承");
});
