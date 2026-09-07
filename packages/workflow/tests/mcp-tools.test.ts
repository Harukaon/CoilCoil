import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { MCP_MANAGER_CHANNEL, describeTools, directToolName, requestMcpManager } from "../extensions/mcp-tools.ts";

test("向运行时要 MCP 客户端，拿到的是同一个对象", () => {
  // 不是复制一份配置自己再连一遍——Agent 和设置界面共用同一套连接和同一份凭据。
  const bus = createEventBus();
  const manager = { marker: "runtime" };
  bus.on(MCP_MANAGER_CHANNEL, (data) => { (data as { manager?: unknown }).manager = manager; });
  assert.equal(requestMcpManager(bus as never), manager as never);
});

test("没人应答就是没有，不去猜也不去自己造一个", () => {
  const bus = createEventBus();
  assert.equal(requestMcpManager(bus as never), undefined);
});

test("总线抛错也不能把工具本身弄崩", () => {
  const events = { emit: () => { throw new Error("bus is gone"); } };
  assert.equal(requestMcpManager(events), undefined);
});

test("工具清单按服务器分组，名字不脱离出处", () => {
  // 两个服务器同时有 search 是常事，不写清楚是哪一个等于请模型调错。
  const rendered = describeTools({
    tools: [
      { server: "github", tool: { name: "search", description: "搜索仓库" } },
      { server: "github", tool: { name: "read" } },
      { server: "notion", tool: { name: "search", description: "搜索页面" } },
    ],
  });
  assert.match(rendered, /^github\n {2}- search：搜索仓库\n {2}- read\n\nnotion\n {2}- search：搜索页面$/);
});

test("用不了的服务器会被点名，并带上原因", () => {
  // 悄悄不列出来，模型只会以为这个工具不存在，然后继续瞎猜。
  const rendered = describeTools({
    tools: [{ server: "github", tool: { name: "search" } }],
    unavailable: [
      { server: "notion", status: "needs-auth" },
      { server: "local", status: "failed", failure: "spawn ENOENT\n栈信息若干" },
    ],
  });
  assert.match(rendered, /notion（暂时用不了：需要在设置里完成认证）/);
  // 只取第一行：栈信息对模型没用，还挤掉真正有用的部分。
  assert.match(rendered, /local（暂时用不了：spawn ENOENT）/);
  assert.doesNotMatch(rendered, /栈信息若干/);
});

test("一个工具都没有的时候说清楚可能是为什么", () => {
  const rendered = describeTools({ tools: [] });
  assert.match(rendered, /没有可用的 MCP 工具/);
  assert.match(rendered, /还没配置|已停用/);
});

test("直接注册的工具名字带着服务器，横杠换成下划线", () => {
  // `mcp__` 这个前缀是 CoilCoil 其他地方（上下文统计）认 MCP 工具的依据。
  assert.equal(directToolName("github", "search"), "mcp__github__search");
  assert.equal(directToolName("my-server", "read"), "mcp__my_server__read");
});
