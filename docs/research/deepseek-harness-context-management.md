---
title: "DeepSeek Harness 上下文管理研究"
source: "https://github.com/deepseek-ai/deepseek-harness"
source_commit: "5badb15009ae1756c3afe0ae0cef1faafc290ccc"
source_snapshot: "2026-10-03"
kind: "research"
reviewed_commit: "d743267388641bc76f17c45ce8b4c231aed1d32c"
reviewed_on: "2026-10-13"
---

# DeepSeek Harness 上下文管理研究

## 研究范围与资料版本

本记录只依据 DeepSeek AI 官方仓库 `deepseek-ai/deepseek-harness` 的 README、源码、测试和仓库内设计文档。研究快照为提交 [`5badb15009ae1756c3afe0ae0cef1faafc290ccc`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)，仓库最近提交时间为 2026-10-03。该项目 README 标明当前处于开发者预览阶段，接口可能继续变化，因此以下内容适合作为设计参考，不能当作 NeuroBook 的直接 API 合同。

## 结论先行

DeepSeek Harness 的核心思路不是把会话历史永久截断，而是把“完整、可审计的追加日志”和“发送给模型的当前 surface”分开：

1. 所有原始事件继续进入持久日志；压缩或工具结果修剪通过新的替换事件改变模型可见的 surface。
2. 上下文压力由统一 token meter 按当前路由模型定价。压缩在请求派生前触发；提供方确认上下文溢出时还会走一次更激进的压缩并重试。
3. 早期 surface 范围替换为一个摘要 checkpoint，近期尾部逐字保留；系统提示词 surface 节点 0 不被压缩，工具调用和工具结果边界不能被拆开。
4. 超大工具结果先做无需模型调用的确定性头部／尾部修剪；若仍超预算才调用摘要模型。
5. 摘要是替换而不是追加，因此后续请求不会同时携带原文和摘要。替换点之后的 KV cache 前缀会失效，但未改变的前缀仍可复用。
6. DeepSeek 专用扩展（会话日志上传、插件清单等）位于请求 JSON 的模型输入之外，不能被误当成模型上下文压缩。DeepSeek 适配器会报告缓存读取用量，但缓存命中不等于减少了请求上下文中的历史内容。

## 官方实现的关键事实

### 1. 压缩是独立能力，统一接缝承载策略

仓库把压缩拆成 capability seam：共享定义包 [`packages/compaction/compaction`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction/README.zh.md)、自动后端 [`packages/compaction/compaction-basic`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.zh.md)、可选工具结果修剪器，以及 `/compact` 手动命令。压缩不属于 agent loop 的业务分支；只挂载一个后端，由后端集中拥有触发、保留和摘要策略。

这提供了一个适合 NeuroBook 的深模块边界：各工作台只声明任务资料和 profile 预算，最终模型请求前由同一个 Context Assembly/Compaction 接缝生成消息。不要在大纲、设计、写作三个 Agent 内分别实现历史截断。

### 2. 路由模型预算与默认策略

[`compaction-basic/src/config.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/config.ts) 对每个精确 `provider/model` 解析容量和策略。其默认值为：

- `thresholdRatio = 0.8`；
- `headroomTokens = 65,536`，用于压缩余量；
- `retainRatio = 0.16`，保留 `W - O` 中约 16% 的近期历史；
- `maxTokens` 默认跟随 `headroomTokens`；
- `compactionRetries = 1`、`maxOverflowRetries = 1`、`auto = true`。

上下文窗口为 `W`、单次请求输出预留为 `O`、额外余量为 `B` 时，压力阈值为：

```text
floor(min(W × thresholdRatio, W − O − B))
```

策略按真实路由模型解析的 `contextWindow` 计算，不查询建议性的模型目录。配置会拒绝没有正消息预算、保留预算不小于触发阈值、输出预留和余量耗尽窗口等情况。这个设计把“模型最大窗口”与“应用侧提前压缩策略”分开，但默认策略仍以模型窗口为基准；产品可以通过 exact model policy 降低实际工作预算。

### 3. 自动触发、溢出恢复和跨轮维护

[`compaction-basic/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/index.ts) 注册两类自动入口：

- `agent/pre-step`：请求派生前按 token meter 检查压力，先剪枝工具结果，再重新测量，必要时摘要早期范围；
- `agent/request-error`：仅响应提供方明确的 `CONTEXT_WINDOW_EXCEEDED`，绕过普通阈值选择可平衡范围，压缩后只有 surface replacement generation 前进才重试。

它还提供 `compactNow()`，在 Agent 空闲、下一轮提示词进入前运行一次手动维护；`/compact` 命令调用这个入口。这个入口说明：压缩不能只放在一次 Agent 内的工具循环里；用户跨轮继续会话时，也要在下一次模型请求派生前执行同一预算检查或维护。

### 4. 摘要是可回放的 surface 替换

[`compaction-basic/src/region.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/region.ts) 选择一个包含工具配对边界的 surface 范围，将其替换为一个带 `<compacted-summary>` 的 `user/message` checkpoint。`compaction/start`、`compaction/summary`、`compaction/end` 只写入事件日志，不直接进入 surface；替换消息通过 `sourceEventSeqs` 指向被遮蔽的源事件。

压缩摘要的前导要求模型把摘要当作既定背景继续任务，而不要复述 checkpoint。摘要请求是单独的模型调用，但会回放原会话的系统消息、工具声明和被遮蔽历史前缀；摘要调用的生成与推理输出只保留安全文本摘要，推理和工具调用不会进入 checkpoint。摘要失败会留下可检测的事务状态，不会伪造已完成的替换。

默认情况下 surface 的第一个 `system/message` 不被范围选中。工具调用／结果配对边界由 `toolPairingBalancedBefore/After` 检查，防止模型收到没有对应结果的调用或孤立结果。

### 5. 超大工具结果先修剪，且原文可审计

[`compaction-tool-result-pruner/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/index.ts) 提供不调用模型的确定性修剪：默认文本超过 8,192 个 Unicode 码点时，保留前 4,096、后 1,024，中间替换为 `[... tool result middle pruned ...]`。非文本块保持顺序，工具调用和错误元数据保留。

修剪通过新的 `tool/result` 替换事件落盘，替换消息引用原始 `sourceEventSeqs`，前置 `compaction/prune` 影子计价事件。原始工具结果仍保留在追加日志中，回放可以恢复完整输入；第二次扫描已收敛，不会重复扩大或改写结果。README 明确指出字符预算只是近似，是否缓解压力仍由 token meter 验证。

### 6. Token meter、历史回放和 UI 使用量

[`packages/llm/token-meter`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/token-meter) 通过回放持久日志计算当前请求和表层压力，不发起模型调用。压缩、占用显示和遥测共用同一测量结果；在路由有图片定价时会把图片价格也纳入。适配器真实返回的 usage 仍是权威值，meter 是请求前的确定性估算。

因此产品界面应区分至少三类数字：

- 当前最终请求的估算上下文（包含系统提示词、工具定义、动态资料和会话 surface）；
- provider 返回的 `inputTokens`、`cacheRead`、`cacheWrite` 等本次 usage；
- 会话累计输入／缓存读取量。

不能把 `cacheRead` 当作“没有发送这些历史”；它表示 provider 对已有前缀的缓存读取计量。

### 7. DeepSeek 适配器与缓存的特有假设

官方适配器说明：此前 assistant 轮次的推理内容可原样回传到后续请求；DeepSeek 的 Messages 投影会省略用户和工具结果中的 reasoning／tool-call 块，但保留 assistant 侧推理历史。路由条目可声明 system prompt update 和工具更新方式，默认 `deepseek-flash` 是 addition-only 工具更新；这些变化会影响请求前缀和缓存复用。

[`docs/deepseek-llm-api-wire-extensions.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/deepseek-llm-api-wire-extensions.zh.md) 定义的 `x-deepseek-harness-compact: 1` 仅标识摘要用途；`dsh_session_log`、`dsh_plugin_packages` 等顶层字段位于 `messages`、系统提示词和工具 schema 之外，不增加模型输入 token。`dsh_session_log` 采用会话事件的连续后缀、水位和最多 8 MiB 的每请求字段限制，属于远端审计交付，不是模型上下文裁剪。

仓库没有规定一个额外的 DeepSeek 私有“自动摘要 API”。摘要通过普通 `ctx.llm.stream()` 请求发起；DeepSeek 专用部分主要是 Messages 投影、思考参数、缓存用量映射和请求扩展。对 NeuroBook 来说，可复用的是压缩协议和路由预算，不应假设存在可直接调用的 DeepSeek 服务器端上下文管理接口。

## 与 NeuroBook 当前问题的对应关系

本节保留 2026-10-03 研究时的历史诊断，不代表当前运行状态；200k 压缩已经触发后的问题与建议见下方“2026-10-13 复查”。

根据现有 NeuroBook 诊断记录，大纲规划改编会话的 500K 主要来自多份 `get_planning_context` 工具结果和跨用户 invocation 的完整历史重复注入；DeepSeek 约 2.56M 的模型窗口使基于最大窗口的默认压力线迟迟不触发。DeepSeek Harness 的做法可以直接映射为：

| NeuroBook 问题 | Harness 可借鉴的边界 | 应用到 NeuroBook 的建议 |
|---|---|---|
| 用户跨轮后没有在第一轮请求前压缩 | `agent/pre-step` + `compactNow` 的统一入口 | 在每个最终 provider 请求组装后、发送前执行预算闸门，覆盖新 invocation、恢复会话和工具循环 |
| 同一个规划快照被多次完整写入历史 | surface 替换、source event 引用和完整日志分离 | 保留 JSONL 原文；模型 surface 只保留最新 revision，旧结果换成带 revision/hash 的短引用 |
| 大段 `get_planning_context` 工具结果占满窗口 | model-free tool-result pruner | 按工具类型设置可解释的结构化裁剪；规划条目按 ID、章节和 revision 按需读取，完整正文留在 durable store |
| 只看 provider 最大窗口，逻辑成本过高 | exact provider/model policy + threshold/retain/headroom | 为 `outline.planner` 等 profile 设置独立逻辑预算；实际预算小于模型窗口，且保留输出、工具和当前任务资料余量 |
| UI 估算低于 provider trace | token meter 与真实 usage 分离 | 单独展示估算请求上下文、输入／输出、缓存读取／写入和累计用量 |
| 摘要改变缓存前缀造成误判 | 摘要替换而非追加、前缀复用说明 | 保持固定系统／工具前缀；把经常变动的规划资料放到尾部并去重，记录压缩导致的 cache 前缀失效 |

## 建议的 NeuroBook 实施顺序（仅设计建议）

本研究不修改业务代码。若进入实现阶段，建议按下面顺序形成一个统一模块：

1. **定义最终请求预算合同**：每个 profile／provider-model 有 `contextBudget`、输出预留、摘要预留和近期尾部预算；预算不是 DeepSeek 宣称的最大窗口。
2. **在唯一模型请求接缝执行**：完整组装 system、工具、动态资料和 surface 后，统一测量；压缩／修剪后重新组装和重新测量。
3. **先做无模型修剪**：超大规划工具结果和重复 revision 结果按结构化字段收窄；保留来源、revision、hash 和重新读取指引。章节正文按需分页读取，当前编辑需要的正文及 CAS 版本／哈希不可静默头尾截断。
4. **再做 durable surface 替换摘要**：摘要消息替换旧范围，原始会话记录保持可审计；明确保留工具调用结果成对边界。
5. **跨 invocation 维护**：上一轮结束后仍可执行 `compactNow` 语义，下一轮用户消息进入模型前重新检查预算。
6. **把长期状态结构化**：模式、来源方案、目标方案、当前章节、当前 revision 等进入 session state；模型每轮读取当前状态和按需资料，而不是重复全文工具结果。
7. **补充回归证据**：覆盖多轮用户消息、跨 invocation、工具结果剪枝、摘要失败／取消、压缩后重试、缓存 usage 展示，以及单个不可分超大消息无法修复的提示。

## 官方实现的边界与限制

- 压缩无法缩减系统提示词、工具定义或会话固定前缀；如果这些内容本身过大，需要单独优化。
- 单个不可分消息／工具单元过大时，表层压缩无法修复请求；需要工具输出限额或拆分工具接口。
- 工具结果修剪是头尾启发式，不理解中间语义；规划数据更适合按 ID、章节和字段结构化读取。
- 修剪阈值按字符而不是 token，必须重新通过 token meter 验证。
- 摘要依赖额外模型调用，会增加一次输入／输出费用；可以先做无需模型的剪枝，或提供手动压缩。
- 摘要和替换会使被替换位置之后的 KV cache 复用失效；保持稳定前缀、缩小变化尾部可以降低代价。
- DeepSeek Harness 为开发者预览，官方仓库未来可能调整事件和配置接口。

## 2026-10-13 复查：工具冗余、缓存与压缩反馈

### 版本与证据边界

本轮通过官方 GitHub API 核实默认分支为 `master`，最新提交为 [`d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/commit/d743267388641bc76f17c45ce8b4c231aed1d32c)，提交时间为 2026-10-09 09:31:32 UTC，对应 `0.2.1-alpha.2`。对两个快照的完整 Git tree/blob SHA 比较表明，`packages/compaction/` 的 60 个文件中有 6 个发生变化：5 个 `package.json` 与 `compaction-basic/tests/runtime-context-admission.spec.ts`；`config.ts`、`index.ts`、`region.ts`、`summarizer.ts` 和工具修剪器源码均未改变。本轮通过 HTTP 只读研究源码，没有执行上游代码或调用真实模型。

主 Agent 提供的当前 NeuroBook 诊断为：200k 自动压缩已生效，现有 3 份压缩收据；首次压缩为 13 批、约 294 秒；复查 18 次摘要调用输入共 1,105,899 tokens，`cacheRead = 0`；33 次主请求总体缓存命中率约 90.8%，普通后续轮次约 97%～99%。`get_planning_context` 即使指定 `entryIds` 仍附带全项目资料，示例目标详情约 8,465 字符、总返回约 95,807 字符，含 147 条索引及 2 个方案的挂载关系。这些属于本地诊断输入，本研究没有独立重新测量；上文 500K 与 2.56M 窗口的描述属于历史问题。

### 可直接参考的上游机制

1. **超过压力线后先做无模型修剪，重新测量，再决定摘要。** [`compaction-basic/src/index.ts:269`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/index.ts#L269) 的普通路径先检查 `measurement.totalTokens >= thresholdTokens`，执行 pruner 后再次测量；低于阈值即返回，不产生摘要请求（319～327 行）。这适合用户确定的“优先去工具冗余”：无需因为最初越线就必然支付摘要费用。

   工具修剪器对于独立 `compaction-basic` 后端是可选服务（289～292 行），但官方 [`bundle/base/cordis.patch.yml:418`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/bundle/base/cordis.patch.yml#L418) 实际挂载了它，显式使用 8,192 Unicode 码点阈值、保留头 4,096 与尾 1,024。[`pruner/index.ts:153`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-tool-result-pruner/src/index.ts#L153) 以新的替换事件修改模型 surface，保留原事件、调用 ID、错误元数据和非文本块。这是工具观察结果的裁剪，不是工具调用删除，也不是按 revision 自动去重。

2. **摘要请求复用原会话的前缀，而非把历史重新序列化成独立文本。** [`region.ts` 的 `buildSummarizationInput`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/region.ts) 从 surface 节点 0 回放系统消息，取 request header 中的工具 schema，再按顺序投影待摘要历史原消息。[`summarizer.ts:145`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/summarizer.ts#L145) 将摘要指令作为**最后一条 user 消息**追加，传递原 tools、toolHistory 与 sessionId，默认跟随当前路由 provider/model。源码 25～30、74～77 行明确说明其目的是复用已热的 KV 前缀。

   这比“单独保持一段固定摘要系统提示词”更具体：角色、顺序、工具定义和消息内容都需与主请求前缀对齐。不同提供方的序列化、缓存键、TTL，以及指定另一摘要模型仍可能破坏复用；上游源码描述设计意图，不构成 NeuroBook 当前接口上的命中率保证。压缩后主请求的旧历史被替换，首次缓存下降仍有客观原因。

3. **保留工作状态与关键决定，合并旧 checkpoint。** [`summarizer.ts:32`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/summarizer.ts#L32) 要求固定摘要结构：用户意图、技术概念、文件、错误与修复、未完事项、当前工作、下一步和关键上下文。关键上下文明确包括决定及理由、约束、偏好、开放问题；66 行要求保留旧 checkpoint 中仍成立的事实、去掉过期事实并合并新信息。它是逐次压缩时合并旧摘要的滚动 checkpoint，默认 `summarizeWithLlm` 为一次 `llm.stream()`；未发现默认分层摘要或逐批摘要机制。

   65 行以提示词要求模型不要调用工具；请求没有设置 `toolChoice: none` 这样的硬禁用参数。该函数直接消费模型流，不进入 Agent 工具执行循环，输出仅提取文本，reasoning/tool-call 不写入 checkpoint（213～220 行）。同时明确拒绝 `max-tokens` 截断回复（197～210 行）。因此不能把“保留 tools 用于缓存”误认为摘要阶段会实际执行工具。

4. **将生命周期作为反馈依据，不把历史未闭合标记当成正在运行。** [`compaction/src/types.ts:24`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction/src/types.ts#L24) 定义 `compaction/start`、`compaction/summary`、`compaction/end`、`compaction/prune`；没有逐批 progress 事件。当前 Web [`trajectory-compaction-definition.ts:40`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-trajectory/src/client/trajectory-compaction-definition.ts#L40) 投影开始／完成时间及 `running/complete/error`，可查看摘要、路由和用量。聊天 [`conversation-nodes/compaction.ts:51`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/conversation-nodes/compaction.ts#L51) 只有 checkpoint 落地后才生成 marker，[`CompactionItem.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/chat/CompactionItem.tsx) 展示完成数量及可展开摘要；不能据此宣称聊天已有自动压缩专属 spinner 或逐批进度。

   历史的 [TUI 进度设计记录](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/archived/feature/2026-07-30-compaction-progress-visibility.zh.md) 已归档，说明实时 start/end、用时和动画的设计，以及进程退出后旧 start 不能证明任务仍活跃。它可作为恢复语义参考，不能当作当前 Web 产品已具备该动画的证据。

### 对 NeuroBook 下一阶段的建议（尚未实施）

- **保留已确认的 200k 触发线。** 上游默认 80% 窗口、65,536 headroom、16% 尾部并不等于本项目应该采纳的预算；仅参考输出预留、尾部预算与压力线分离、修剪后重新测量的合同。
- **工具先收窄，再裁剪旧历史。** 指定条目详情不要附全项目索引；概览、分页索引与目标详情拆开，保留目标必要关联。相同对象／revision 结果去重、旧结果换引用属于 NeuroBook 的设计建议，上游 pruner 没有此语义。需先保证按 ID／版本可重新读取；原日志能供人审计不等于模型已有回读工具。摘要中的用户决定不能当作可回读工具资料去掉。
- **编辑数据完整保留。** 当前写入所需正文、revision、hash/CAS 前置条件不适合上游通用头尾截断；采用按需分页读取和结构化投影，保证模型能知道资料不完整及获取后续资料的方式。避免用裁剪后的正文覆盖完整内容。
- **缓存优化优先借鉴原消息回放和尾部摘要指令。** 新工具输出从源头变小，能在首次发送就减少用量且无需改动已缓存历史；对已发送的旧工具结果集中在压缩边界替换，减少频繁前缀失效。真正超过摘要模型容量的旧会话仍需要有预算的恢复分批，但分批属于 NeuroBook 的策略，不是上游默认行为。
- **摘要模板按写作领域适配。** 保留用户创作约束、关键决定及理由、当前规划方案与条目 ID、未完成事项、关键版本和下一步；区分过期快照与仍有效决定。上游要求英语工程摘要不适合作为小说创作摘要的产品约束。
- **进度反馈采用真实生命周期。** 开始、阶段／批次、完成、失败和取消应来自后端实际执行；逐批事件是本项目新增能力。重连依赖服务端当前 invocation 所有权或活动快照，避免从旧持久 start 推导永久动画。完成可显示压缩前后估算上下文与摘要费用，主请求与摘要缓存用量分别统计。
- **保持本项目既定失败语义。** 上游普通 pre-step 摘要失败会记录警告并继续（`index.ts:158`～175）；不要照搬这一点。本项目面对超大请求的既定处理是摘要失败／取消停止主请求，避免重新发送原巨量历史。上游 `max-tokens` 拒绝不完整摘要可独立借鉴。

这些建议仅为源码研究和设计讨论，未修改 NeuroBook 产品代码，未验证模型输出质量、实际缓存提升或端到端时延。

## 一手资料索引

- [DeepSeek Harness README（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.zh.md)
- [Compaction 家族 README（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/README.zh.md)
- [自动压缩 README（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.zh.md)
- [自动压缩配置源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/config.ts)
- [自动压缩后端源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/index.ts)
- [范围选择和事务源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/region.ts)
- [摘要器源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/summarizer.ts)
- [工具结果修剪器源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/index.ts)
- [工具结果修剪器配置源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/config.ts)
- [Compaction 子系统参考](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/compaction.zh.md)
- [Token meter README（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/token-meter/README.zh.md)
- [DeepSeek API wire extensions（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/deepseek-llm-api-wire-extensions.zh.md)
- [DeepSeek LLM adapter README（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-deepseek/README.zh.md)
- [自动压缩测试](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/tests)
- [工具结果修剪测试](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/tests)
