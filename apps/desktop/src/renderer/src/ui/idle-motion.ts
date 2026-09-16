/**
 * 没人在看的时候，把纯装饰的动画停下来。
 *
 * ## 为什么需要这个
 *
 * 带滤镜的装饰动画是浏览器里最贵的那一类。当初挨这一刀的是侧边栏底部那枚墨团标志
 * （`CoilLogo`）：`<mask>` 里 7 个三角形各自 `filter: blur(12px)`，其中 6 个在无限
 * 旋转，外面再套一层被 keyframes 改着的 `filter: contrast()`——**整条滤镜链每帧都得
 * 重算，一帧也缓存不了**。
 *
 * 实测（Chromium，两个实例 = 侧边栏 26px + 空态 40px，对照组是同一份 DOM 只把
 * 动画关掉）：
 *
 * | 场景                          | Renderer + GPU 合计 CPU |
 * | ----------------------------- | ----------------------- |
 * | 无动画                        |  0.7%                   |
 * | 现状（60fps）                 | 39~44%                  |
 * | 只留三角形旋转                | 40%   ← 开销几乎全在这   |
 * | 只留 contrast 脉冲            |  7%                     |
 * | `animation-play-state: paused`|  0.5% ← 与无动画等价     |
 *
 * 一枚 26px 的装饰图标能稳定吃掉三分之一个核心，而且**窗口在后台时照跑**——这正是
 * 「挂了一夜，能耗榜比浏览器还高」的来源。后来用户看了这笔账，直接要求把标志改成
 * 静态的，所以那枚标志已经不动了，这里也就不再管它。
 *
 * 现在归这里管的是等回复时那团墨（`.coil-loader`）：同样是 blur + 陡 alpha 的滤镜
 * 链每帧重算，一条长回复能画上好几分钟，而这几分钟里用户完全可能已经切去别的 App。
 *
 * ## 为什么是暂停，而不是降帧或换实现
 *
 * 这团墨的观感是明确定过的（见 styles.css 里那段注释：曾经改成边缘卡实的版本，用户
 * 看了要求改回模糊的原版）。降帧或换 SVG 滤镜结构都是在改动画本身，会改变叠加结果。
 * 暂停不一样：它只在**用户看不到**的时候生效，看得见的每一帧和原来逐像素相同，所以
 * 不需要在观感上做任何取舍。
 *
 * `animation-play-state: paused` 而不是 `animation: none`：前者保留播放进度，切
 * 回来是从停住的地方接着走，不会跳一下。
 *
 * ## 两个信号，各自管一段
 *
 * - `document.hidden`：窗口最小化、被别的窗口完全盖住、切到别的 Space，以及手机
 *   远程端切后台。这是「真的渲染不到屏幕上」。
 * - 窗口焦点：窗口还露着、但用户在别的 App 里干活。这一段占的时间最长，省下来的
 *   电也最多。
 *
 * 焦点必须问主进程（`onWindowFocusChange`），不能用 Renderer 自己的 window blur：
 * 内置浏览器的页面是挂在同一个窗口里的另一份 WebContents，用户点进网页时 Renderer
 * 会收到 blur，照它停就会在用户正用着的时候把界面停住。BrowserWindow 的 focus/blur
 * 只在整个窗口失去焦点时才触发，才是这里要的语义。
 *
 * 拿不到这个桥（手机远程端、或者气泡窗口这种主进程没往里发的）时 `focused` 保持
 * true，退化成只看 `document.hidden`——宁可不省，也不能停错。
 *
 * 焦点桥从 `target.defaultView` 上取而不是全局 `window`：也让这段逻辑能在没有 `window` 的环境里被测到。
 */

/** 装饰动画此刻该不该走。 */
export type MotionState = "running" | "paused";

export interface MotionInputs {
  /** 页面是否根本渲染不到屏幕上（最小化、被完全遮挡、切走的 Space、手机切后台）。 */
  hidden: boolean;
  /** 整个窗口是否持有焦点，由主进程判定，焦点落进内置浏览器不算失去。 */
  focused: boolean;
}

/** 看不见，或者用户压根在别的 App 里，就没有理由继续画。 */
export function motionStateFor({ hidden, focused }: MotionInputs): MotionState {
  return hidden || !focused ? "paused" : "running";
}

/**
 * 把 `:root` 上的 `data-motion` 跟窗口状态绑起来，样式表据此暂停装饰动画。
 *
 * 返回卸载函数：移掉监听并把属性删掉，免得留下一个永远停着的状态。
 */
export function installIdleMotionPause(target: Document = document): () => void {
  const inputs: MotionInputs = { hidden: target.hidden, focused: true };
  const apply = (): void => {
    target.documentElement.dataset.motion = motionStateFor(inputs);
  };
  const onVisibilityChange = (): void => {
    inputs.hidden = target.hidden;
    apply();
  };
  target.addEventListener("visibilitychange", onVisibilityChange);
  // 两层可选链都不是多余的：测试里的 document 没有 defaultView，手机远程端的桥
  // 则是另一份实现，未必有这个方法。
  const stopWatchingFocus = target.defaultView?.coilcoil?.onWindowFocusChange?.((focused) => {
    inputs.focused = focused;
    apply();
  });
  apply();
  return () => {
    target.removeEventListener("visibilitychange", onVisibilityChange);
    stopWatchingFocus?.();
    delete target.documentElement.dataset.motion;
  };
}
