# SuoCode 提示词缓存实现审核

审核日期：2026-10-27；代码复审更新：2026-10-28；开源客户端对照更新：2026-10-29。参照对象是 [README](README.md) 分析的 Claude Code 2.1.302 安装产物、下列固定提交的开源客户端，以及官方 Prompt caching 协议。范围是模型缓存、上下文去重和观测。

实现状态按下表逐项记录。请求载荷、生命周期、计费规则通过离线回归验证；真实请求费用从服务端 usage 统计。

当前 macOS 安装版本为 **0.1.0-beta.163.local.20261028.3**，包含本报告的缓存修复和后续稳定性审查修复。新版启动、签名、安装包完整性及打包后 MCP 检查通过；840 个主目录和旧目录中的会话文件保持原 SHA-256。已清理被替换的 `.2` 应用和安装包。后续稳定性验证见 [architecture.md](../architecture.md#regression-verification-2026-10-28)。

## 2026-10-30：首个输出等待与 Claude Code 的差异

数据来自用户指定的 `01a18d64-802d-737c-a971-7cd701394cbf` 会话，以及 Orb 中的 Claude Code `661e1d89-be15-4847-a575-3f927f88ef72` 会话。完整数值、请求关联和计时定义见 [首个输出证据](evidence/latency-comparison-20261030.json)。本轮没有发起新的模型请求，没有修改应用行为。

- Coil 固定截取前 22 条 response metrics，排除其中一条零用量取消记录，保留 21 个有效响应。通过 I/R/W/O 四个桶的精确一致性匹配缓存账本及 response ID，首个非空 delta 的中位耗时为 **6.58 秒**，范围 **2.19～12.96 秒**，第一条为 **11.21 秒**。计时开始到实际 HTTP 发出的近似差值为 **1.20～6.40 毫秒**，中位 **4.41 毫秒**；该差值由结束时墙上时钟和 monotonic duration 重建，毫秒值只作近似。主要等待区间位于 HTTP 发出之后、首个非空内容到达之前，包含网络、上游处理及推理，现有记录没有将这三者分别计时。
- Coil 会话配置与 assistant 返回的 `providerThinkingLevel` 均为 **max**。Orb 样本的 `effort`、`perTurnEffort`、system effort 控制消息均为 **high**，usage 的 speed 为 **standard**。只读 `params.output_config` 的顶层 high 基线不足以判断实际强度，本轮同时核对了消息内覆盖值。
- Orb 的 21 个匹配响应，从 `api-request` 到首个含非空正文、思考文本或工具名的完整内容块落盘，中位 **4.43 秒**。空 thinking 块排除。该时间是内容块完成时刻，区别于 Coil 的首个 delta 到达时刻；两份任务、上下文、网络环境也不同，本报告不计算客户端速度倍率。
- 实际安装的 `.3` 版本中，Anthropic SDK 默认请求 `thinking.display: "summarized"`，类型仅支持 summarized/omitted；Orb 的实际请求使用 **updates**，且带 `thinking-display-updates-2026-08-18`。Coil 的思考区域默认折叠，完整摘要传输与默认展示需求存在不匹配。[官方说明](https://platform.claude.com/docs/en/build-with-claude/thinking#controlling-thinking-display) 指出，omitted 可缩短正文开始流出的等待，updates 在隐藏推理摘要的同时保留面向用户的进度文字；隐藏思考文本不减少其推理计费。
- 现有 `firstTokenMs` 同时接受非空 text/thinking/toolcall delta，而界面标为“首字”；它没有单独测量正文首字和屏幕首次显示。前端批处理预算为 **60 毫秒**，空闲后的首个事件走下一个任务。相近时间段的两次 renderer_behind 记录均为 124 个事件合并成一个、timer lag 为 0；这些日志没有记录端到端首次绘制耗时。

后续优化有两个明确落点：为支持该能力的 Claude 路线提供与默认界面相符的 thinking display 策略，并按会话固定，避免中途改变请求基线；将请求计时拆为 HTTP 发出、首个协议事件、首个非空内容、正文首字和界面首次绘制。推理强度属于用户选择，速度对照应在双方选择相同强度后进行。

## 2026-10-29：四个官方开源客户端的缓存实现对照

本轮实际读取四个官方仓库的源码与测试，固定提交后比较；没有运行外部仓库代码，没有调用模型 API，没有修改应用行为。文件 SHA-256、源码行号及证据说明见 [源码证据清单](evidence/open-source-cache-20261029.json)。测试代码的存在、录制响应的断言、真实服务端的缓存 usage 是三种不同证据，本报告分别记录。

| 对象 | 分支与固定提交 | 许可证 |
| --- | --- | --- |
| [Codex CLI](https://github.com/openai/codex/tree/5c0e42161ee26af222eb3e9853f9c898706b375b) | main / `5c0e42161ee2` | Apache-2.0 |
| [OpenCode](https://github.com/anomalyco/opencode/tree/b6c43a524265496086fc0fdd83180bfa47d4d22e) | dev / `b6c43a524265` | MIT |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3) | master / `f3803c96974a` | MIT |
| [Grok Build](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | main / `2bdd1d6a6369` | Apache-2.0 |

这里的 Grok Build 是 Rust CLI/TUI 与 Agent runtime 源码，区别于模型权重或系统提示公开；其仓库按快照从内部 monorepo 同步。OpenCode 此提交的缓存实现位于 `packages/ai`，会话实现位于 `packages/core`；网络搜索中常见的旧 `packages/opencode/src/provider/transform.ts` 不属于本次提交。

### 已核实的做法及与 CoilCoil 的区别

**OpenCode：统一分配断点预算，并根据协议选择策略。** 默认自动策略标记最后一个工具、首尾 system 分块、最后一条消息的可缓存内容；system 只有一块时去重。已有手动标记占用四个槽位，自动策略仅补剩余槽位；对 OpenAI 等路线不发送 Anthropic 的分块标记。TTL 服从请求配置，没有对所有提供商强制 1h。[缓存策略源码](https://github.com/anomalyco/opencode/blob/b6c43a524265496086fc0fdd83180bfa47d4d22e/packages/ai/src/cache-policy.ts#L17-L31)。达到执行步数上限时仍保留工具定义，通过 `toolChoice: "none"` 禁止继续调用，避免删掉整个工具头。[最后一步的处理](https://github.com/anomalyco/opencode/blob/b6c43a524265496086fc0fdd83180bfa47d4d22e/packages/core/src/session/runner/llm.ts#L243)。

CoilCoil 的 Anthropic 策略在 [wire.ts](../../packages/workflow/extensions/cache/wire.ts) 使用工具头、system 尾、已确认的父边界、当前尾部，最多四点。两者位置分配不同：OpenCode 为 system 分区多留一个点；我们为历史父边界留一个点，用于跨越 20 个内容块的回看限制。我们已经冻结整个 system，不宜为了模仿分区而额外添加第五点。Anthropic 的自动缓存本身也占一个槽位，[官方协议](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#combining-with-block-level-caching) 对自动和显式标记合计超额返回 400；我们的默认重规划路径先移除原顶层自动标记，调用者自有混合 TTL 等策略则保持原样。

OpenCode 还有可选的后台摘要预计算：接近窗口上限时，用已有前缀生成摘要并暂存，到真正需要压缩时才替换历史；默认 `precompute: false`。这是降低压缩等待时间的策略，会增加提前发出的摘要请求，不能按“启用就省钱”处理。[默认值与执行条件](https://github.com/anomalyco/opencode/blob/b6c43a524265496086fc0fdd83180bfa47d4d22e/packages/core/src/session/compaction.ts#L259-L265)、[保留旧前缀直至压缩](https://github.com/anomalyco/opencode/blob/b6c43a524265496086fc0fdd83180bfa47d4d22e/packages/core/src/session/compaction.ts#L330-L387)。

**DeepSeek Harness：稳定输入顺序，同前缀生成摘要。** 工具按确定顺序排列，system sections 也排序，避免注册完成顺序改变输入。摘要请求复制原消息和工具，在末尾追加摘要指令。[工具排序](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/system-prompt/src/index.ts#L231-L243)、[摘要请求](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/compaction/compaction-basic/src/summarizer.ts#L130-L164)。原生 DeepSeek 的缓存匹配由服务端默认提供，不能将它的原生路线与 Claude 显式断点互换。[DeepSeek 协议](https://api-docs.deepseek.com/guides/kv_cache/)。

它对 system 更新做能力分支：支持 `in-history` 且仍处于同一执行序列时追加新 system；不支持、清空 system 或开始新序列等分支会替换头部节点。[实际分支](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent-loop/src/runtime-context.ts#L85-L114)。CoilCoil 采用首轮固定并持久化 system、恢复时重放 MCP schema 的规则，符合用户要求；Anthropic 共享摘要还检查同模型、账号、路由、请求头、TTL 和实际请求前缀。我们的共享摘要目前限定 Anthropic，DeepSeek 的摘要实现按自身路由选择模型，覆盖范围不同。

**Codex CLI：保持旧输入，显式维护会话身份和配置更新。** 缓存 key 有 session-derived、自定义和省略三种策略；订阅后端另维护 Responses 的 `session-id` 亲和信息。上下文变化通过新消息表达，测试验证原输入前缀和 key 保持一致。[身份策略](https://github.com/openai/codex/blob/5c0e42161ee26af222eb3e9853f9c898706b375b/codex-rs/core/src/client.rs#L703-L737)、[请求前缀测试](https://github.com/openai/codex/blob/5c0e42161ee26af222eb3e9853f9c898706b375b/codex-rs/core/tests/suite/prompt_caching.rs#L473-L558)。支持的模型用追加 `configuration_update` 改变 reasoning effort，压缩成功后建立新基线。[配置更新](https://github.com/openai/codex/blob/5c0e42161ee26af222eb3e9853f9c898706b375b/codex-rs/core/src/session/reasoning_effort.rs#L1-L7)。WebSocket 增量续传的复用检查属于传输层，不是服务端缓存命中计数。

CoilCoil 已经在 `openai-codex-responses.ts` 发送 `prompt_cache_key`；通用 `openai-responses.ts` 也有模型能力分支，包括 `prompt_cache_options` 和 reasoning 配置更新，且为不接受该项的 ChatGPT 登录路线禁用追加。没有必要再次添加同一个 key 字段。当前 [OpenAI 文档](https://developers.openai.com/api/docs/guides/prompt-caching#cache-location) 还区分了新旧模型：GPT-5.6 及之后的模型自动处理缓存路由，key 可用于隔离缓存计量；旧模型的 key 有路由优化作用。不能用旧模型的 key 解释所有新模型表现。

**Grok Build：Claude 兼容通道显式保留上一轮附近的断点。** Messages 转换器标记 system 尾部、最新可缓存内容，以及按对话角色向前找到的用户边界；源码注明这是为跨过 20-block 回看窗口，并为可能开启自动缓存的网关保留第四槽位。Responses 转换器则把会话 ID 用作默认 cache key。[三点算法](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src/conversation/messages.rs#L1-L77)、[Responses key](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src/conversation/responses.rs#L133-L140)。我们父边界使用连续前缀指纹和实际 usage 确认，无需再按角色位置猜测。

Grok 的其他路径包括裁剪旧工具结果，以及原地替换 system 中的 memory reminder。这会改动旧输入，和用户要求的“普通运行不修改 system 或历史消息”冲突，本项目不采用。[具体改写路径](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-chat-state/src/actor/request_builder.rs#L125-L198)。

### 验证方式与后续优先级

- Codex 的前缀测试使用 mock server；Grok 的稳定性 helper 只比较序列化后的 `input` 数组。后者即使在名为工具或模型切换的测试中通过，也只说明 input 未被重写，工具定义、模型与真实服务端命中应另查。
- OpenCode 有 Anthropic 录制响应测试；DeepSeek 有需要 `DEEPSEEK_API_KEY` 的真实命中测试。这些外部测试本轮均未执行。真实测试检查后续请求 `cacheReadTokens > 0`，它仍不是完整旧前缀复用率或节省费用的基准。
- CoilCoil 已有实际 SDK 加离线 HTTP 的工具循环、MCP 恢复、压缩摘要、TTL、混合策略和费用 fixture 测试。下一步的验证改进应复用这些场景，补上同模型、同账号、同任务的可回放真实请求对照，分别报告：旧前缀重新处理量、新增尾部量、摘要调用成本、总 API 等价成本。已有两份用户日志的 46 次相邻请求均复用了上一轮已缓存前缀；这次源码对照没有把“订阅消耗更快”定位到新的具体缺陷。
- 后续实现候选是把当前以 Anthropic 为主的请求指纹与归因账本推广到其他协议，统一比较口径；以及按提供商能力扩展共享摘要。它们是明确的覆盖范围差异，不是已确定的 Claude 缓存修复。
- 暂不采用后台预摘要、原地裁剪历史或动态 system 重写；先用同任务成本基准评价收益，避免额外请求和前缀重写造成反向效果。

## 2026-10-28 晚：真实请求的缓存指标口径核验

核验用户指定的 `01a182ce-dc54-70d8-bb7b-ffecf4fe9329`、`01a182ca-3c64-70d8-bb7b-ffe8c7381749` 两份会话，分别截至 22:03:33、22:12:45（Asia/Shanghai）。本节统计有输入 usage 的主会话请求，排除零用量取消请求。

- Anthropic 的普通输入 `I`、缓存读取 `R`、缓存创建 `W` 是三个不重叠的桶，总输入是 `I + R + W`。OpenAI 的 `input_tokens` 已包含读取和写入；Pi 先减去两者得到普通输入，再使用同一个显示函数。两家显示的 token 缓存命中率均为 `R / 总输入`。[Anthropic 字段说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)、[OpenAI 字段与指标说明](https://developers.openai.com/api/docs/guides/prompt-caching)。
- 新增尾部首次进入模型时需要处理；下一轮保留相同前缀后，这部分可以成为缓存读取。已有 100k token 全部命中、另追加 5k 新输入时，总输入的缓存读取占比为 95.24%，原有缓存前缀的复用仍为 100%。这个分母效应适用于两家服务商，不意味着新增内容本身修改了旧前缀。
- 两份 Claude 会话分别有 12、36 次有效请求，累计读取占比 89.81%、95.85%。全部 46 次相邻请求均满足 `R_next = R_previous + W_previous`；本地系统、工具、参数和路由指纹保持稳定，没有压缩记录。
- 同一 Coil 客户端的两份 Codex 会话 `01a1824e-cc2e-70d8-bb7b-ffe42f9914d1`、`01a1823f-5c2d-70d8-bb7b-ffe192fc7ad3`，各取前 36 次有效请求，读取占比分别为 94.42%、94.83%。会话的任务、工具返回内容和初始前缀不同；相同请求数量用于统一统计区间，不构成相同工作负载的性能测试。
- Orb 中两份常用 Claude Code 长会话累计为 98.32%、98.85%；其中各取前 36 次 Opus 请求的片段分别为 93.60%、96.47%。长会话累计值不能作为每次请求固定的缓存复用比例。
- 这两份 Coil Claude 会话与取样的 Claude Code 官方订阅主会话均使用 1h 写入。1h 相比 5m 的 API 写入价格差是独立的成本取舍，不能据此归因两客户端的耐用差异。[Claude Code TTL 策略](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)。

MCP 整台服务器的工具列表确实带来额外输入，指定长会话的三次工具列表合计 59,386 字符；它是已确认的输入开销和优化点。此前将它直接认定为 Claude 相对 Codex 缓存差、订阅消耗更快的根因，属于需要撤回的推断。后续诊断分别记录新增尾部、旧前缀重新处理和实际服务端 usage，避免用一个百分比代替三者。

Anthropic 的结构诊断与实际命中也需分别读取：`diagnostics` 检查请求前缀是否变化，`usage.cache_read_input_tokens` 报告实际读取量。[官方诊断说明](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#reading-diagnostics-alongside-usage)。

## 2026-10-28 代码复审与修复

- **缓存发送边界**：共享摘要在实际发送、SDK 延迟重试、diagnostics 降级重发前复核父缓存 TTL、最新主请求边界、路由及凭据。API key 更换时使用独立文本摘要；同账号别名的 OAuth 刷新保持可复用状态。凭据指纹只存内存。
- **缓存并发与回溯**：乱序完成不倒退缓存点时间、不覆盖更新的主请求基线；回溯合并同一边界时保留最新刷新时间；诊断开关按请求固定。
- **压缩触发预算**：保留模型专属 reserve/keepRecent 覆盖；按实际路由模型窗口计算默认保留量。8k 窗口有有效默认预算，显式配置超出可用窗口时给出配置错误；第一层压缩同时满足 35% 目标和真实触发线。
- **摘要内容完整性**：压缩切点越过缓存请求之后生成的回复时，改用包含新增回复/结果的独立摘要。存档包含 split-turn 前缀、终端命令/输出和旧摘要正文。
- **摘要失败与额度**：分块失败取消同批请求、停止排队，等待在途请求退出再报告失败。输出受模型上限约束；小窗口按完整提示、SDK 预留和输出共同预算。8k SDK 请求验证有有效输出空间；窗口不大于 SDK 的 4096 预留时在发送前报配置错误。
- **MCP 恢复与用户操作**：持久化完整 direct schema/description、注册顺序和激活名单，普通恢复重放快照；用户主动开关或修改工具写刷新标记。首轮请求、压缩期间均排队到空闲再重载；用户修改绑定当前会话，后台刷新不覆盖它。异步读取配置后再次检查会话身份和运行状态，避免中断刚开始的请求。
- **子会话与后台记忆**：子会话系统提示在首次请求固定，重开沿用原 AGENTS/profile；新会话读取更新。记忆任务完成时保留文件写入和锁释放，终态经 runtime 持有的独立通道发布；扩展重载或切换会话后照常结束，界面不会残留“运行中”，已退役扩展不访问旧 UI。
- **打包导入**：摘要模型目录使用 Pi 扩展加载器支持的入口，避免开发环境可用而安装包加载失败。

最终相关回归共 **297 项通过**（workflow 213 项、runtime-core 84 项），全项目 `npm run check` 通过。验证采用实际 SDK 与 AgentSession、模拟 HTTP、真实后台记忆子进程，以及 macOS 安装包的会话/MCP 检查。所有模型测试使用本地响应，未发送付费模型请求。

该轮缓存复审安装的是 **0.1.0-beta.163.local.20261028.2**。签名、DMG/ZIP 完整性、安装包浏览器隔离及 MCP 后台生命周期检查通过；原有 **779 个会话文件**逐一通过原内容 SHA-256 校验，并删除了被替换的 `.1` 应用与安装包。当前版本已更新为上方记录的 `.3`。

## 逐项对照

| 功能 | Claude 安装产物的证据 | 本项目当前行为 | 判断 |
| --- | --- | --- | --- |
| 系统提示、记忆的稳定性 | README 4.4、5.2 的 prompt snapshot／稳定前缀 | 首轮固定整个系统提示并持久化，压缩后仍沿用；更新记忆等新会话生效 | 目标相同，按用户要求更严格，不是同一刷新时机 |
| 基础断点 | README 3、4.5：前缀缓存、有限 marker、可标记 block | 默认工具头／系统头／父边界／尾部，最多四个 | 同一协议；位置选择算法不同 |
| 父前缀保护 | README 4.5 的 divergence、parent、条件 fork pin | 用完整 wire 顺序指纹匹配有 usage 支持的历史边界 | 原理相近，不是逐项复刻 UUID／flag 逻辑 |
| 压缩共享缓存 | README 5.3：继承 system/tools/betas，cache-safe fork，失败走独立 summarizer | 兼容模型、同账号同模型且父边界仍可复用时追加摘要指令；转换后前缀或 HTTP 路由／beta 改变则在网络前拒绝，回退独立摘要 | 关键缓存安全约束对齐；资格更保守 |
| 回溯分支总结 | 参照实现按条件选择父前缀／分叉断点路径 | Pi 分支总结使用独立 system＋序列化材料，并显式关闭 cache；用量计入账本 | 分支总结的共享缓存路径未移植 |
| TTL | README 4.3：OAuth scope、querySource、env/settings、overage、remote allowlist、live 5m 等分流 | 订阅主会话默认 1h，API key 默认不变，显式 PI 配置优先，保留请求已设定的混合 TTL | 基础默认相近；完整分流和独立 system/messages 配置未移植 |
| 静态／动态 system 分区、global scope | README 4.4，受 provider、beta 和账号条件限制 | 不主动创建 global 分区；已有 scope 原样保留 | 自动分区未移植，复用范围按当前请求显式配置决定 |
| 工具 schema／description 回放 | README 5.2、6.1 的 recorded description/schema 与兼容性检查 | MCP 完整定义、顺序与激活名单持久化重放；用户主动刷新更新快照；GOAL 完成保持定义 | MCP 回放已实现；内建工具定义随用户安装的客户端版本更新 |
| Read 去重 | README 5.1：mtime＋范围＋模型可见性快路径、压缩反向失效 | 实际读取后比较正文摘要和范围，再核对原结果仍在上下文；短结果不缩写 | 省入模正文的目标相同；磁盘 I/O、状态模型和 CPU 开销不同 |
| 缓存账本／归因 | README 7：200 条环形记录、分类器、低开销指纹与预期 drop | 40 条记录、完整 wire 摘要、HTTP 元数据摘要和紧凑检查点；包含主会话及摘要回退，不包含命名与保活 | 原理相近，统计集合与检测器不是同一个实现 |
| 保活 | README 4.6：账号／flag／server 确认后以 request ID 轻量 touch | Pi 受经济性和时间窗口约束的完整请求重放，输出上限 1 token | 明确不同；Pi 重放产生模型用量，不等于轻量续租 |

## 本轮发现并修正的反向风险

1. **请求自有缓存策略被覆盖。** 原规划器删除原有 `cache_control`，统一写入当前 TTL，会破坏混合 TTL／scope／自动缓存。现在这些配置原样通过，默认策略才自行布点。把 5m 写入升为 1h 会让对应写入单价从基价 1.25 倍升至 2 倍，并非免费优化。
2. **前缀转换不一致仍可能发出冷摘要。** Provider 会在 Context 之后继续转换请求。新增转换后指纹和实际 HTTP 路由／缓存相关请求头的发送前校验；不匹配不发长请求。SDK 会把 fetch 抛错包装成 Connection error，本地拒绝原因现会保留，避免误当网络错误重试。
3. **把首 token 当计时起点。** 长 prefill 会使缓存寿命被高估。现在从准备／HTTP 发出时记录，首 token 不再重置时钟。
4. **仅头部命中被当成整段已缓存。** 新尾边界需要覆盖消息末尾，并满足普通输入最多 16 token 的收尾余量；否则不据此启用整段共享摘要。辅助调用不足以覆盖父边界时不续记时间。这个判断仍是客户端推断，服务端没有逐点存活保证。
5. **短 Read 的提示比文件更大。** 现在只有原结果字节数超过提示两倍才缩写；旧结果和文件变化、范围变化、压缩失效等检查保留。
6. **MCP 发现阻塞首轮。** 取消无期限等待；就绪工具进入首轮，首轮后才发现的定义不偷偷回填。通用 MCP 通道继续可用，直接定义等下次加载。
7. **账本写放大与漏计。** 原先每轮重存最近 40 条记录，现在只存本条和小检查点，恢复时合并；冷摘要回退及分块也接入账本，避免只统计漂亮的缓存共享请求。
8. **忽略 JSON 键顺序。** 对真正 wire 前缀保留键顺序做摘要，能够识别 tool input/schema 序列化顺序变化；这不是服务端缓存 key 的逆向恢复。
9. **订阅通道未经确认即加诊断字段。** 本地指纹始终可用；订阅默认不主动添加 diagnostics。官方 API key 通道可用诊断，明确拒绝字段时才降级一次。

## 验证及边界

- 实际 SDK＋离线 HTTP：订阅别名、前缀和请求头分歧在发 HTTP 前拒绝、不重复重试、独立摘要回退计账、完整工具循环、Read 去重与压缩／重开恢复。
- 独立协议计费 fixture：按精确 wire、20 个位置回看、仅 marker 写入和混合 TTL 的 A/B/C 规则计算。普通追加与 SDK 尾断点费用相同；超回看窗口的父断点减少重写；一次性摘要指令走普通输入；混合 TTL 到期后也不被自动升价。
- fixture 以文本字符代表合成输入单位，验证缓存布点和计费规则。实际命中率及费用收益按服务端返回的 usage 计算。
- 本次复审使用实际 AgentSession 和 SDK 发送到本地模拟 HTTP，验证最终请求内容及完整生命周期；移植范围按上表逐项记录。
- 剩余未移植项已在对照表直接列明：完整 TTL 分流、静态 system 分区、分支总结共享和私有 cache touch。

官方协议：[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)。客户端证据均可从本目录 README 和 evidence 文件复核，不把条件代码存在当成该账号已启用。
