import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  MCP_MANAGER_CHANNEL,
  describeServerTools,
  describeServers,
  directToolName,
  requestMcpManager,
} from "../extensions/mcp-tools.ts";

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

test("列 Server 这一步明说自己没联网，并指路下一步", () => {
  // 慢的根子就是「看看有什么」把每个服务器都连一遍。现在这一步是免费的，
  // 但必须告诉模型：想知道具体工具，得再走一步，而那一步要等几秒。
  const rendered = describeServers([
    { server: "firecrawl", status: "not connected", tools: [] },
    { server: "beeswax", status: "needs-auth", tools: [] },
    { server: "local", status: "connected", tools: [{ name: "echo" }, { name: "read" }] },
  ]);
  assert.match(rendered, /没有联网/);
  assert.match(rendered, /- firecrawl（未连接/);
  assert.match(rendered, /- beeswax（需要先在设置里完成认证）/);
  // 已经连着的就顺手把工具名给了，没必要瞒着已经知道的事。
  assert.match(rendered, /- local（已连接，2 个工具：echo、read）/);
  assert.match(rendered, /action="tools"/);
});

test("一个 Server 都没有的时候说清楚可能是为什么", () => {
  const rendered = describeServers([]);
  assert.match(rendered, /没有可用的 MCP Server/);
  assert.match(rendered, /还没配置|已停用/);
});

test("某个 Server 的工具清单带描述", () => {
  const rendered = describeServerTools("github", {
    status: "connected",
    tools: [{ name: "search", description: "搜索仓库" }, { name: "read" }],
  });
  assert.match(rendered, /github 提供的工具/);
  assert.match(rendered, /- search：搜索仓库/);
  assert.match(rendered, /- read$/m);
});

test("连不上就把服务器自己那句话的第一行带出来", () => {
  // 「连接失败」打发不了模型；「Invalid API key」它才知道下一步该干嘛。
  const rendered = describeServerTools("local", {
    status: "failed",
    tools: [],
    failure: "spawn ENOENT\n一堆栈信息",
  });
  assert.match(rendered, /local 连不上：spawn ENOENT/);
  assert.doesNotMatch(rendered, /栈信息/);
});

test("需要认证和已停用各有各的说法", () => {
  assert.match(describeServerTools("a", { status: "needs-auth", tools: [] }), /需要先在设置里完成认证/);
  assert.match(describeServerTools("a", { status: "disabled", tools: [] }), /已停用/);
  assert.match(describeServerTools("a", { status: "connected", tools: [] }), /没有提供任何工具/);
});

test("直接注册的工具名字带着服务器，横杠换成下划线", () => {
  // `mcp__` 这个前缀是 CoilCoil 其他地方（上下文统计）认 MCP 工具的依据。
  assert.equal(directToolName("github", "search"), "mcp__github__search");
  assert.equal(directToolName("my-server", "read"), "mcp__my_server__read");
});
