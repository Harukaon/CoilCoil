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

/** 品牌列表里那个故意写得很怪的占位项，Chrome 自己也会发，用来防止站点写死品牌名。 */
const GREASE_BRAND = { brand: "Not)A;Brand", version: "8" } as const;

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
 * 只删 `Electron/x.y.z` 和应用自己那一段（`CoilCoil/x.y.z`），其余原样保留——
 * 剩下的正好就是一条真实的 Chrome UA。多余的空格一并收掉，免得留下双空格这种
 * 同样显眼的痕迹。
 */
export function cleanUserAgent(raw: string): string {
  return raw
    .replace(/\s*\bElectron\/[^\s]+/gi, "")
    .replace(/\s*\bCoilCoil\/[^\s]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const userAgent = cleanUserAgent(input.rawUserAgent);
  const fullVersion = chromeFullVersion(userAgent);
  const major = majorVersion(fullVersion);
  return {
    userAgent,
    userAgentMetadata: {
      brands: [
        GREASE_BRAND,
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
      ],
      fullVersionList: [
        GREASE_BRAND,
        { brand: "Chromium", version: fullVersion },
        { brand: "Google Chrome", version: fullVersion },
      ],
      fullVersion,
      platform: clientHintPlatform(input.platform),
      platformVersion: input.platformVersion,
      architecture: clientHintArchitecture(input.architecture),
      model: "",
      mobile: false,
    },
  };
}

/** 只要求「能发 CDP 命令」，这样单测不用造一个真的 WebContents。 */
export interface CdpSender {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** 同上：只要求「能读能写 UA」，这样这个文件不必 import electron。 */
export interface UserAgentSession {
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
}

/**
 * 整个进程只算一次身份，算完存在这里。
 *
 * 之所以放模块级：真正需要它的是每个新 guest 附加调试器的那一瞬间，而那段代码在
 * BrowserRuntimeManager 深处，一路把它当参数传下去只会让那个文件更长。启动时由
 * 主进程调一次 configureBrowserIdentity，之后各处直接取。
 */
let configured: UserAgentOverride | undefined;

/**
 * 启动时调一次：把浏览器 session 的 UA 换成干净的那条，并记下整套身份备用。
 * 返回值只是方便调用方打日志或断言，正常不需要用。
 */
export function configureBrowserIdentity(ses: UserAgentSession, runtime: {
  platform: string;
  platformVersion: string;
  architecture: string;
}): UserAgentOverride {
  configured = userAgentOverride({ rawUserAgent: ses.getUserAgent(), ...runtime });
  ses.setUserAgent(configured.userAgent);
  return configured;
}

/** 当前身份；没配置过就是 undefined（测试和早期启动阶段）。 */
export function browserIdentity(): UserAgentOverride | undefined {
  return configured;
}

/**
 * 给一个已经 attach 好的 guest 盖上身份。
 *
 * 每个新 guest 都要盖一次：这条覆盖是按页面算的，不像 session 那样设一次就够。
 * 失败不抛出——身份没盖上最多是又看见验证页，不该连带把开标签页这件事弄挂。
 */
export async function applyGuestUserAgent(debug: CdpSender, override = configured): Promise<void> {
  if (!override) return;
  try {
    await debug.sendCommand("Emulation.setUserAgentOverride", {
      userAgent: override.userAgent,
      userAgentMetadata: override.userAgentMetadata,
    });
  } catch (error) {
    console.error("[browser] 设置浏览器身份失败", error);
  }
}
