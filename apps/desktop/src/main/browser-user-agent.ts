/**
 * 让内置浏览器对外看起来就是一个普通的 Chrome。
 *
 * Electron 默认的 UA 里带着 `Electron/<版本>` 这一段，而 `navigator.userAgentData`
 * 里的品牌列表同样会把它报出去。Google 一类的站点把这一段当成「自动化程序」的
 * 标记：同一条网络、同一台机器，系统自带的 Chrome 打开好好的，内置浏览器却每次
 * 都被丢到「检测到异常流量」的验证页。用户没有做错任何事，是我们自己在报身份的
 * 时候多说了一句话。
 *
 * 这里做的只有一件事：把那一段去掉，并让 UA 字符串和客户端提示（client hints）
 * 说的是同一件事。两边对不上本身也是一个可疑信号，所以必须一起改：
 *
 * · `session.setUserAgent` 管请求头和 `navigator.userAgent`；
 * · CDP 的 `Emulation.setUserAgentOverride` 管 `navigator.userAgentData` 和
 *   `Sec-CH-UA` 这一族请求头——这部分 session 层改不到。
 *
 * 注意：这里不伪造任何「不是自己」的东西。Chromium 内核版本、操作系统、架构全部
 * 用运行时的真实值，只是不再把 Electron 这个外壳报出去。
 *
 * 函数保持纯粹，不 import electron，方便单测。
 */

/**
 * 品牌列表里那个故意写得很怪的占位项（Chromium 管它叫 GREASE），用来防止站点写死
 * 品牌名。它不是随便取的：Chromium 按主版本号算出来，同一个大版本的每一台 Chrome
 * 算出来都一模一样。所以这里照它的算法算，而不是抄一个固定值——抄错了就等于在说
 * 「我是 Chrome 150，但我的占位项长得像 Chrome 137 的」。
 *
 * 算法和两个实测点对得上：150 → `Not;A=Brand` v8（Electron 自己的 Chromium 150
 * 原生就是这个），152 → `Not?A_Brand` v24（本机真 Chrome 152 就是这个）。
 */
const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"] as const;
const GREASE_VERSIONS = ["8", "99", "24"] as const;
/** 三个品牌的排列也由版本号定，Chromium 用的就是这张表。 */
const GREASE_ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;

export function greaseBrand(major: number): UserAgentBrand {
  const brand = `Not${GREASE_CHARS[major % GREASE_CHARS.length]}A${GREASE_CHARS[(major + 1) % GREASE_CHARS.length]}Brand`;
  return { brand, version: GREASE_VERSIONS[major % GREASE_VERSIONS.length] };
}

/** 把三个品牌按这个版本该有的顺序排好：占位项、Chromium、Google Chrome。 */
function orderedBrands(major: number, grease: UserAgentBrand, chromium: UserAgentBrand, chrome: UserAgentBrand): UserAgentBrand[] {
  const order = GREASE_ORDERS[major % GREASE_ORDERS.length];
  const slots: UserAgentBrand[] = [];
  slots[order[0]] = grease;
  slots[order[1]] = chromium;
  slots[order[2]] = chrome;
  return slots;
}

export interface UserAgentBrand {
  brand: string;
  version: string;
}

export interface UserAgentMetadata {
  brands: UserAgentBrand[];
  fullVersionList: UserAgentBrand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

export interface UserAgentOverride {
  userAgent: string;
  userAgentMetadata: UserAgentMetadata;
}

/**
 * 去掉 UA 里的外壳标记。
 *
 * 删的是整个词，不是词里的一截。应用的包名带作用域（`@coilcoil/desktop/0.1.0`），
 * 原来那条正则从 `coilcoil/` 开始匹配，`@` 被留在了原地——发出去的 UA 长这样：
 * `(KHTML, like Gecko) @ Chrome/150…`。全世界只有我们这一个浏览器会发出带一个孤零
 * 零 `@` 的 UA，这比不改还显眼。所以前后都吃掉非空白字符。
 */
export function cleanUserAgent(raw: string): string {
  return raw
    .replace(/\s*\S*\bElectron\/\S*/gi, "")
    .replace(/\s*\S*\bCoilCoil\/\S*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Chrome 的 UA 字符串里只报大版本，后面三段永远是 `0.0.0`。
 *
 * 这是 Chrome 自己从 2022 年起做的「UA 缩减」，为的是少泄露一点指纹。本机真
 * Chrome 报的是 `Chrome/152.0.0.0`，而我们原样透出了 `Chrome/150.0.7871.212`——
 * 一个精确到构建号的 UA 在今天的网上是独一份。完整版本号照常走客户端提示里的
 * `uaFullVersion`，那才是它该待的地方。
 */
export function reduceUserAgentVersion(userAgent: string): string {
  return userAgent.replace(/\bChrome\/(\d+)(?:\.[\d.]+)?/i, (_match, major: string) => `Chrome/${major}.0.0.0`);
}

/** 从 UA 里取 Chromium 的完整版本号（`150.0.7871.212`）。取不到就返回空串。 */
export function chromeFullVersion(userAgent: string): string {
  return /\bChrome\/([\d.]+)/i.exec(userAgent)?.[1] ?? "";
}

/** 品牌列表只报大版本号，这是 Chrome 的规矩（完整版本走 fullVersionList）。 */
function majorVersion(fullVersion: string): string {
  return fullVersion.split(".")[0] ?? "";
}

/** Chromium 的平台名和 Node 的 process.platform 不是一套写法。 */
export function clientHintPlatform(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

/** Chromium 的架构名同理：arm64 报 "arm"，x64 报 "x86"，位数单独在 bitness 里。 */
export function clientHintArchitecture(arch: string): string {
  if (arch === "arm64" || arch === "arm") return "arm";
  return "x86";
}

/**
 * 拼出一整套自洽的身份：UA 字符串、品牌列表、平台信息。
 *
 * 品牌里写 "Google Chrome" 是为了和 UA 字符串里的 `Chrome/<版本>` 对得上——UA 说
 * 自己是 Chrome、客户端提示却说不是，比什么都不改还可疑。
 */
export function userAgentOverride(input: {
  rawUserAgent: string;
  platform: string;
  platformVersion: string;
  architecture: string;
}): UserAgentOverride {
  const cleaned = cleanUserAgent(input.rawUserAgent);
  const fullVersion = chromeFullVersion(cleaned);
  const major = majorVersion(fullVersion);
  const grease = greaseBrand(Number(major) || 0);
  const greaseFull = { brand: grease.brand, version: `${grease.version}.0.0.0` };
  return {
    userAgent: reduceUserAgentVersion(cleaned),
    userAgentMetadata: {
      brands: orderedBrands(
        Number(major) || 0,
        grease,
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
      ),
      fullVersionList: orderedBrands(
        Number(major) || 0,
        greaseFull,
        { brand: "Chromium", version: fullVersion },
        { brand: "Google Chrome", version: fullVersion },
      ),
      fullVersion,
      platform: clientHintPlatform(input.platform),
      platformVersion: input.platformVersion,
      architecture: clientHintArchitecture(input.architecture),
      model: "",
      mobile: false,
    },
  };
}

/**
 * 每个请求都该带的那三个客户端提示头。
 *
 * 这是实测里最响的一处：我们一条 `sec-ch-ua` 都没发，而真 Chrome 每一个请求都带
 * 这三个。原因是 Electron 的 `session.setUserAgent` 只换了 UA 字符串，Chromium 就
 * 不再替这个 session 生成提示头了；CDP 那条覆盖管得到 `navigator.userAgentData`，
 * 管不到导航请求的头。所以这三个由我们自己补上，取的还是同一套身份，两边不会打架。
 *
 * 只补低熵的这三个。高熵的那些（架构、完整版本、平台版本）真 Chrome 也要等站点用
 * `Accept-CH` 点名才发，我们跟着这个规矩走。
 */
export function clientHintHeaders(override: UserAgentOverride): Record<string, string> {
  const list = override.userAgentMetadata.brands
    .map((item) => `"${item.brand}";v="${item.version}"`)
    .join(", ");
  return {
    "sec-ch-ua": list,
    "sec-ch-ua-mobile": override.userAgentMetadata.mobile ? "?1" : "?0",
    "sec-ch-ua-platform": `"${override.userAgentMetadata.platform}"`,
  };
}

/**
 * Accept-Language，以及由它派生出来的 `navigator.languages`。
 *
 * 实测我们报的是 `zh-CN` 一项、`navigator.languages` 是 `["zh-CN","zh-Hans-CN"]`；
 * 真 Chrome 是 `zh-CN,zh;q=0.9` 和 `["zh-CN","zh"]`。`zh-Hans-CN` 这个写法在
 * 浏览器里几乎见不到，是 Electron 按系统区域推出来的。补上基础语言这一项，两边
 * 就一致了——q 值由 Chromium 自己加。
 */
export function acceptLanguages(locale: string): string {
  const primary = locale.trim() || "en-US";
  const base = primary.split("-")[0];
  return base && base !== primary ? `${primary},${base}` : primary;
}

/** 只要求「能发 CDP 命令」，这样单测不用造一个真的 WebContents。 */
export interface CdpSender {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** 同上：只要求「能读能写 UA」，这样这个文件不必 import electron。 */
export interface UserAgentSession {
  getUserAgent(): string;
  setUserAgent(userAgent: string, acceptLanguages?: string): void;
  webRequest?: {
    onBeforeSendHeaders(listener: (details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void): void;
  };
}

/**
 * 整个进程只算一次身份，算完存在这里。
 *
 * 之所以放模块级：真正需要它的是每个新 guest 附加调试器的那一瞬间，而那段代码在
 * BrowserRuntimeManager 深处，一路把它当参数传下去只会让那个文件更长。启动时由
 * 主进程调一次 configureBrowserIdentity，之后各处直接取。
 */
let configured: UserAgentOverride | undefined;
/** 同上，语言那一份：guest 的 `navigator.languages` 要用它。 */
let configuredLocale: string | undefined;

/**
 * 启动时调一次：把浏览器 session 的 UA 换成干净的那条，并记下整套身份备用。
 * 返回值只是方便调用方打日志或断言，正常不需要用。
 */
export function configureBrowserIdentity(ses: UserAgentSession, runtime: {
  platform: string;
  platformVersion: string;
  architecture: string;
  locale?: string;
}): UserAgentOverride {
  const override = userAgentOverride({ rawUserAgent: ses.getUserAgent(), ...runtime });
  configured = override;
  configuredLocale = runtime.locale;
  ses.setUserAgent(override.userAgent, acceptLanguages(runtime.locale ?? ""));
  // 提示头得自己补：换过 UA 的 session，Chromium 就不再替它生成这几个头了。
  const hints = clientHintHeaders(override);
  ses.webRequest?.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const [name, value] of Object.entries(hints)) {
      // 站点自己点名要的高熵提示、以及 Chromium 已经填好的，都不覆盖。
      if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === name)) requestHeaders[name] = value;
    }
    callback({ requestHeaders });
  });
  return override;
}

/**
 * 这台机器的身份参数。
 *
 * 抽出来是因为现在有两个地方要配身份：启动时配一次，换工作区换 cookie jar 时再
 * 配一次——两边取的必须是同一套值。
 */
export function browserIdentityEnvironment(locale?: string): {
  platform: string;
  platformVersion: string;
  architecture: string;
  locale?: string;
} {
  return {
    platform: process.platform,
    platformVersion: process.getSystemVersion(),
    architecture: process.arch,
    locale,
  };
}

/** 当前身份；没配置过就是 undefined（测试和早期启动阶段）。 */
export function browserIdentity(): UserAgentOverride | undefined {
  return configured;
}

/**
 * 真 Chrome 在每个页面上都挂着的那个 `window.chrome`。
 *
 * 实测：本机真 Chrome 的 `window.chrome` 上有 `loadTimes`、`csi`、`app` 三样，我们
 * 的是个空对象。「自称 Chrome，却没有 window.chrome.loadTimes」是各家检测脚本最先
 * 查的一条，因为没有任何一个真的 Chrome 长这样。这几样东西本身早就废弃了，谁也不
 * 靠它们干活，缺的只是「在场」这件事。
 *
 * 函数用 `bind` 造出来，是为了 `toString()` 天然就是 `[native code]`——不必去改
 * `Function.prototype.toString`。动那个全局才是真正显眼的事：它会让页面上每一个
 * 函数的自述都经过我们的手，检测脚本反而专门查它。
 */
const CHROME_OBJECT_SCRIPT = `(() => {
  const w = window;
  if (!w.chrome) Object.defineProperty(w, "chrome", { value: {}, writable: true, enumerable: true, configurable: true });
  const chrome = w.chrome;
  const nativeish = (name, impl) => {
    const bound = impl.bind(null);
    Object.defineProperty(bound, "name", { value: name, configurable: true });
    Object.defineProperty(bound, "length", { value: impl.length, configurable: true });
    return bound;
  };
  const define = (key, value) => {
    if (key in chrome) return;
    Object.defineProperty(chrome, key, { value, writable: true, enumerable: true, configurable: true });
  };
  const started = Date.now() / 1000;
  define("loadTimes", nativeish("loadTimes", () => {
    const nav = performance.getEntriesByType("navigation")[0];
    const base = performance.timeOrigin / 1000;
    // 还没发生的阶段，真 Chrome 报 0，不是报「页面开始的那一刻」。
    const seconds = (value) => (value ? base + value / 1000 : 0);
    const protocol = (nav && nav.nextHopProtocol) || "";
    return {
      requestTime: base,
      startLoadTime: seconds(nav && nav.startTime),
      commitLoadTime: seconds(nav && nav.responseStart),
      finishDocumentLoadTime: seconds(nav && nav.domContentLoadedEventEnd),
      finishLoadTime: seconds(nav && nav.loadEventEnd),
      firstPaintTime: seconds(nav && nav.responseEnd),
      firstPaintAfterLoadTime: 0,
      navigationType: (nav && nav.type) || "Other",
      wasFetchedViaSpdy: protocol === "h2" || protocol === "h3",
      wasNpnNegotiated: protocol === "h2" || protocol === "h3",
      npnNegotiatedProtocol: protocol,
      wasAlternateProtocolAvailable: false,
      connectionInfo: protocol || "unknown",
    };
  }));
  define("csi", nativeish("csi", () => ({
    startE: Math.round(performance.timeOrigin),
    onloadT: Math.round(performance.timeOrigin + performance.now()),
    pageT: performance.now(),
    tickCount: Math.round(started),
  })));
  // outerWidth/outerHeight 说的是浏览器窗口，innerWidth/innerHeight 说的是页面。
  // 后台标签页那个视口是我们按 1280x720 发下去的，而窗口是应用自己的尺寸，于是
  // 出现了「窗口比页面还小」——真浏览器里不可能，页面装不进窗口。这里只在数对不上
  // 的时候补一个说得通的值：窗口至少和页面一样宽，高出去的那截是地址栏和标签栏。
  const CHROME_UI_HEIGHT = 87;
  const repair = (key, floor) => {
    const own = Object.getOwnPropertyDescriptor(w, key) || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w) || {}, key);
    const read = own && own.get ? own.get : null;
    if (!read) return;
    const getter = (() => {
      const real = Number(read.call(w)) || 0;
      const least = floor();
      return real >= least ? real : least;
    }).bind(null);
    Object.defineProperty(getter, "name", { value: "get " + key, configurable: true });
    try { Object.defineProperty(w, key, { get: getter, set: undefined, enumerable: true, configurable: true }); } catch {}
  };
  repair("outerWidth", () => w.innerWidth);
  repair("outerHeight", () => w.innerHeight + CHROME_UI_HEIGHT);

  define("app", {
    isInstalled: false,
    InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
    RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
    getDetails: nativeish("getDetails", () => null),
    getIsInstalled: nativeish("getIsInstalled", () => false),
    runningState: nativeish("runningState", () => "cannot_run"),
  });
})();`;

/**
 * 把上面那段挂到 guest 上，之后每一个新文档都会先跑它。
 *
 * 失败不抛出：缺了 `window.chrome` 顶多是又被某个站点认出来，不该连带把开标签页
 * 这件事弄挂。
 */
export async function installChromeObject(debug: CdpSender): Promise<void> {
  try {
    // Page 域得先开着，这条注册才认。不开的话它安静地什么也不做——第一版就是这样
    // 过去的，测出来 window.chrome 还是个空对象。
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_OBJECT_SCRIPT });
  } catch (error) {
    console.error("[browser] 安装 window.chrome 失败", error);
  }
}

/**
 * 给一个已经 attach 好的 guest 盖上身份。
 *
 * 每个新 guest 都要盖一次：这条覆盖是按页面算的，不像 session 那样设一次就够。
 * 失败不抛出——身份没盖上最多是又看见验证页，不该连带把开标签页这件事弄挂。
 */
export async function applyGuestUserAgent(
  debug: CdpSender,
  override = configured,
  locale = configuredLocale,
): Promise<void> {
  if (!override) return;
  try {
    await debug.sendCommand("Emulation.setUserAgentOverride", {
      userAgent: override.userAgent,
      userAgentMetadata: override.userAgentMetadata,
      // 请求头归 session 管，`navigator.languages` 只认这里。两处都设，页面里读到的
      // 和发出去的才是同一句话——原来读到的是 `zh-Hans-CN`，真浏览器里几乎见不到。
      ...(locale ? { acceptLanguage: acceptLanguages(locale) } : {}),
    });
  } catch (error) {
    console.error("[browser] 设置浏览器身份失败", error);
  }
}
