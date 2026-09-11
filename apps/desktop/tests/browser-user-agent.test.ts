import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptLanguages,
  applyGuestUserAgent,
  cleanUserAgent,
  clientHintArchitecture,
  clientHintHeaders,
  clientHintPlatform,
  configureBrowserIdentity,
  greaseBrand,
  reduceUserAgentVersion,
  userAgentOverride,
} from "../src/main/browser-user-agent";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/150.0.7871.212 Electron/43.3.0 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/150.0.7871.212 Safari/537.36";
/** 发出去的那一条：版本按 Chrome 自己的规矩缩到大版本。 */
const SENT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/150.0.0.0 Safari/537.36";

const runtime = { platform: "darwin", platformVersion: "15.3.1", architecture: "arm64" };

test("the Electron marker is the only thing removed from the user agent", () => {
  assert.equal(cleanUserAgent(ELECTRON_UA), CHROME_UA);
  // 去掉之后不能留下双空格——那本身就是一个显眼的痕迹。
  assert.ok(!cleanUserAgent(ELECTRON_UA).includes("  "));
  assert.ok(!/electron/i.test(cleanUserAgent(ELECTRON_UA)));
});

test("an app-name token is stripped too, and a clean user agent is left alone", () => {
  assert.equal(cleanUserAgent(`CoilCoil/1.4.0 ${ELECTRON_UA}`), CHROME_UA);
  assert.equal(cleanUserAgent(CHROME_UA), CHROME_UA);
});

test("带作用域的包名要整个词删掉，不能把 @ 留在原地", () => {
  // 真机上发出去过这条：`(KHTML, like Gecko) @ Chrome/150…`。包名是
  // `@coilcoil/desktop/0.1.0`，老正则从 `coilcoil/` 起匹配，`@` 就留下了。全世界
  // 只有我们这一个浏览器会发出带一个孤零零 @ 的 UA。
  const scoped = ELECTRON_UA.replace("Chrome/", "@coilcoil/desktop/0.1.0 Chrome/");
  assert.equal(cleanUserAgent(scoped), CHROME_UA);
  assert.ok(!cleanUserAgent(scoped).includes("@"));
});

test("UA 字符串只报大版本，完整版本留给客户端提示", () => {
  // Chrome 自己 2022 年起就这么做了（UA 缩减）。一个精确到构建号的 UA 在今天的网上
  // 是独一份，等于自报家门。
  assert.equal(reduceUserAgentVersion(CHROME_UA), SENT_UA);
  assert.equal(reduceUserAgentVersion(SENT_UA), SENT_UA, "已经缩过的不再动");
  assert.equal(userAgentOverride({ rawUserAgent: ELECTRON_UA, ...runtime }).userAgent, SENT_UA);
});

test("占位品牌按 Chromium 自己的算法算，不是抄一个固定值", () => {
  // 两个实测点：Electron 里的 Chromium 150 原生报 `Not;A=Brand` v8，本机真 Chrome
  // 152 报 `Not?A_Brand` v24。算法对得上这两个，才敢说别的版本也对。
  assert.deepEqual(greaseBrand(150), { brand: "Not;A=Brand", version: "8" });
  assert.deepEqual(greaseBrand(152), { brand: "Not?A_Brand", version: "24" });

  // 顺序也由版本定：152 是 [Chromium, 占位, Google Chrome]，和真 Chrome 一致。
  const at152 = userAgentOverride({ rawUserAgent: ELECTRON_UA.replace("150.0.7871.212", "152.0.7977.83"), ...runtime });
  assert.deepEqual(at152.userAgentMetadata.brands.map((b) => b.brand), ["Chromium", "Not?A_Brand", "Google Chrome"]);
});

test("每个请求都带上那三个客户端提示头", () => {
  // 实测里最响的一处：我们一条 sec-ch-ua 都没发，真 Chrome 每个请求都带。
  const headers = clientHintHeaders(userAgentOverride({ rawUserAgent: ELECTRON_UA, ...runtime }));
  assert.equal(headers["sec-ch-ua-mobile"], "?0");
  assert.equal(headers["sec-ch-ua-platform"], "\"macOS\"");
  assert.match(headers["sec-ch-ua"], /"Chromium";v="150"/);
  assert.match(headers["sec-ch-ua"], /"Google Chrome";v="150"/);
  assert.match(headers["sec-ch-ua"], /"Not;A=Brand";v="8"/);
});

test("Accept-Language 要带上基础语言那一项", () => {
  // 我们原来只报 `zh-CN`，真 Chrome 报 `zh-CN,zh;q=0.9`；q 值由 Chromium 自己加。
  assert.equal(acceptLanguages("zh-CN"), "zh-CN,zh");
  assert.equal(acceptLanguages("en-US"), "en-US,en");
  assert.equal(acceptLanguages("zh"), "zh");
  assert.equal(acceptLanguages(""), "en-US,en");
});

test("client hints say the same thing the user agent string says", () => {
  const override = userAgentOverride({ rawUserAgent: ELECTRON_UA, ...runtime });
  assert.equal(override.userAgent, SENT_UA);
  const brands = override.userAgentMetadata.brands.map((b) => b.brand);
  assert.ok(!brands.some((brand) => /electron/i.test(brand)));
  // 品牌报大版本、fullVersionList 报完整版本，和 UA 里的 Chrome/150.0.7871.212 对得上。
  assert.deepEqual(
    override.userAgentMetadata.brands.filter((b) => b.brand === "Chromium"),
    [{ brand: "Chromium", version: "150" }],
  );
  assert.equal(override.userAgentMetadata.fullVersion, "150.0.7871.212");
  assert.ok(override.userAgentMetadata.fullVersionList.some((b) => b.version === "150.0.7871.212"));
  assert.equal(override.userAgentMetadata.mobile, false);
});

test("platform and architecture use Chromium's spelling, not Node's", () => {
  assert.equal(clientHintPlatform("darwin"), "macOS");
  assert.equal(clientHintPlatform("win32"), "Windows");
  assert.equal(clientHintPlatform("linux"), "Linux");
  assert.equal(clientHintArchitecture("arm64"), "arm");
  assert.equal(clientHintArchitecture("x64"), "x86");
  const override = userAgentOverride({ rawUserAgent: ELECTRON_UA, ...runtime });
  assert.equal(override.userAgentMetadata.platform, "macOS");
  assert.equal(override.userAgentMetadata.platformVersion, "15.3.1");
  assert.equal(override.userAgentMetadata.architecture, "arm");
});

test("configuring the session rewrites its user agent and its languages", () => {
  let current = ELECTRON_UA;
  let languages = "";
  const ses = {
    getUserAgent: () => current,
    setUserAgent: (ua: string, accept?: string) => { current = ua; languages = accept ?? ""; },
  };
  const override = configureBrowserIdentity(ses, { ...runtime, locale: "zh-CN" });
  assert.equal(current, SENT_UA);
  assert.equal(override.userAgent, SENT_UA);
  assert.equal(languages, "zh-CN,zh");
});

test("提示头补在请求上，站点自己要过的不覆盖", () => {
  const listeners: Array<(details: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void> = [];
  configureBrowserIdentity({
    getUserAgent: () => ELECTRON_UA,
    setUserAgent: () => {},
    webRequest: { onBeforeSendHeaders: (listener) => { listeners.push(listener); } },
  }, { ...runtime, locale: "zh-CN" });
  assert.equal(listeners.length, 1);

  let sent: Record<string, string> = {};
  listeners[0]({ requestHeaders: { "User-Agent": SENT_UA } }, (r) => { sent = r.requestHeaders; });
  assert.match(sent["sec-ch-ua"], /"Google Chrome";v="150"/);
  assert.equal(sent["sec-ch-ua-platform"], "\"macOS\"");

  // Chromium 已经填好的那一份说了算，我们不去盖。
  listeners[0]({ requestHeaders: { "Sec-CH-UA-Platform": "\"Windows\"" } }, (r) => { sent = r.requestHeaders; });
  assert.equal(sent["Sec-CH-UA-Platform"], "\"Windows\"");
  assert.equal(sent["sec-ch-ua-platform"], undefined);
});

test("every new guest gets the same identity through CDP", async () => {
  // 显式配置一次，不依赖上一条用例留下的模块状态。
  configureBrowserIdentity({ getUserAgent: () => ELECTRON_UA, setUserAgent: () => {} }, runtime);
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  await applyGuestUserAgent({
    sendCommand: async (method, params) => { sent.push({ method, params }); return {}; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "Emulation.setUserAgentOverride");
  assert.equal(sent[0].params?.userAgent, SENT_UA);
  assert.ok(sent[0].params?.userAgentMetadata);
});

test("a failed override never takes the tab down with it", async () => {
  await applyGuestUserAgent({ sendCommand: async () => { throw new Error("guest gone"); } });
});
