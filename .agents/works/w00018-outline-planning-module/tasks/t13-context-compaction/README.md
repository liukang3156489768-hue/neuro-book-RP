---
schema: nbook.task/v2
taskId: t13-context-compaction
---

# 规划会话上下文压缩

## 2026-10-13：500k 与上下文优化

开发者先批准将默认维护触发线提高至 256000，并实施 DeepSeek Harness 研究建议：规划工具按需分页、旧结果去重、摘要前缀复用、压缩动画及独立用量展示。完成用户验收后，开发者明确要求最终默认值提高至 500000，并将本轮改动合入主工作区。执行仍在同一 worktree/分支，不改真实用户会话、不调用真实模型。下方 200k、9 文件及 2026-10-12 证据为上一阶段历史，当前默认值以 500k 为准。

当前交付：500k 默认值及本轮 29 个文件已按文件差异合入主工作区，包含 DeepSeek Harness 研究补充；主工作区仍在 master，HEAD 为 4778ba3a。目标文件中存在继承的其他任务修改，本次未整文件暂存或创建 Git 提交。合入前后哈希检查确认任务文件与 worktree 一致，其他已登记跟踪及未跟踪文件未变。500k 调整后的 worktree 压缩/Harness 2 文件 219 项通过，主工作区压缩/投影/估算/规划工具/UI 状态 6 文件 43 项通过；docs:check failures 为空，定向 diff --check 通过。未推送或发布，未修改用户会话和本机配置。

实现：

- get_planning_context 默认紧凑概览；条目索引、方案、挂载、图节点/边、线路和伏笔按需分页，支持版本前提。entryIds 保持可用，只返回目标完整正文、CAS、元数据及必要关联；结果有作用域和哈希。
- 维护边界先无模型消除规划读取中的相同内容，重新计量后仍越线才摘要；追加有源指纹及引用的 custom 记录，JSONL 原文不删除。当前分支投影保留完整工具身份、不同正文和用户决定，保护本轮尾部及已有完整引用来源，避免连续维护形成引用链。
- 请求估算包含 system、tools 与动态资料；中文采用保守 Unicode 估算，Provider 校准值不重复计入固定前缀。替换前 usage 仅在模型投影失效，原调用累计费用不变。
- 摘要回放原 system/tools/message 角色，可见自定义消息保留，摘要指令置尾；能在安全预算内处理就一次摘要，超长才成对分批，巨型组完整序列化分片。摘要带会话身份，费用记录于收据，失败/取消/空/length/tool-call 不保存部分摘要。
- 首轮和连续工具轮均计入即时资料；投影刷新按源条目及整消息指纹匹配，不能依赖可复用的 toolCallId。手动压缩也先去冗余。
- 大纲和通用聊天展示实际整理/摘要阶段、Spinner、批次、耗时、前后 tokens 与独立摘要输入/输出/缓存/费用。SSE 先公布活动 invocation，再公布进度，recovery/live 恢复状态，停止取消 Provider，旧事件过滤且终态停止动画。
- 酒馆写手继续使用其冻结编排与预设输出预算；本文通用维护不改写其预设结构。

本轮涉及的独立边界：

- server/agent/tools/planning-tools.ts 及测试。
- server/agent/harness/compaction.ts、neuro-agent-harness.ts 及测试；server/agent/profiles/profile-runtime-settings.ts。
- server/agent/session/session-repo.ts、types.ts；新增 tool-context-projection.ts/test。
- 新增 server/agent/messages/request-tokens.ts/test。
- shared/dto/agent-session.dto.ts。
- app/components/novel-ide/agent/useAgentSession.ts/test、AgentChatSurface.vue/md；新增 AgentCompactionStatus.vue/md/test、agent-compaction-state.ts/test。
- app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue/md；docs/specs/outline/agent-assistance.md；本快照。继承修改仍不算本轮差异。

验证：

- 完整运行链路 7 文件 262 项通过：harness、prepare-run、outline-planner 黑盒、session-repo、projection、request-tokens、profile 配置。另规划工具 2 文件 17 项、摘要/profile-summarizer 2 文件 19 项、UI 5 文件 58 项通过；这些分组有后续重跑与重叠，不相加计总数。
- 源码独立审查发现的源身份、下一轮动态资料漏计与连续引用链问题已修复，并补回归。最终 Harness 全文件 203 项通过；工具投影 6 项通过；酒馆相关 2 文件 14 项通过、5 项按既有条件跳过；UI session 最终 14 项通过。摘要引入会话身份后 faux 会产生实际模拟缓存读取，历史费用断言已改为保持原历史且允许新请求额外缓存用量。
- 实际生产状态组件/nb-ui 资产的隔离浏览器验证：1440 和 390 宽度下 running/completed/failed 无横向溢出，真实 spin 动画，终态停止，主题状态色解析正常，长错误换行，pageerror 为空。证据位于系统 Temp 的 neuro-book/acceptance/product-runtime/compaction-ui；fixture、服务器与浏览器已清理。这不是用户会话或模型质量验收。
- 文档检查 failures 为空，旧历史警告保留；定向 diff --check 无错误。全应用 typecheck 默认 Node 堆不足后以 8GiB 重试，最终仅剩继承的 MaterialConflictResolver.vue(70,118) state/main 索引诊断；本轮类型诊断已修复。

开发者已从 E:/neuro-book-windows-x64/neuro-book/.worktree/w00018-outline-planning-module 完成验收并确认效果达到预期。已有会话可继续使用，显式压缩配置优先于 500k 默认；合入后应从主工作区重新启动项目。真实缓存提升、实际费用和长会话时延未由 Agent 单独量化。

授权：2026-10-12，开发者报告规划工作台单次输入约868k tokens，要求实现上下文压缩，触发线约200k。本地修改与验证已授权；不包含真实模型调用、修改用户历史、提交、远端写入或自动合入主树。

执行位置：`.worktree/w00018-outline-planning-module`，分支 `codex/w00018-context-compaction`。基线是master `4778ba3a`及本轮开始时主树未提交工作态的只读继承副本。任务差异单独维护，不覆盖其他模块修改。

实证：用户会话84为outline.planner；97条turn trace，无compaction记录。最后调用input=469、cacheRead=865024，缓存历史计入单次上下文。默认策略为窗口减25600，而配置模型窗口为1000000；自动检查只在继续同一次invocation的下一turn前执行，首轮无检查。

范围：默认约200k触发、模型小窗口保护、发送首轮前压缩、压缩后真实上下文估算、保留近期对话与完整工具边界；失败/取消不写摘要、不发送未经压缩的超预算请求。复用当前Session和配置入口，保留历史和累计费用；酒馆写手的冻结请求继续使用其独立预算。

行为合同：[规划Agent](../../../../../docs/specs/outline/agent-assistance.md)。本地实现和隔离回归已完成；主工作区未合入，真实模型与用户原会话未执行验收。源码生效后，已有会话的下一条指令也会检查阈值，无需另建会话。

实现：通用默认触发线200000，保留近期24000，小窗口按输出预留提前触发；显式配置仍优先。首轮持久接收用户输入后、主请求之前摘要，完整保留本轮AppendingSet与当前输入，重注入规划合同并保持ModelContext/附加条目/用户输入顺序。旧巨型读取不再为凑满近期预算而被整条保留。历史按UTF-8字节预算分批摘要、逐批合并，全部成功才保存一份收据；失败、取消、空摘要和输出截断不保存部分结果。压缩后仍超模型窗口时拒绝主请求，不截断当前内容。

额外根因：逐turn动态上下文/提醒可能固定transcriptParentLeafId在压缩前，下一回复会分叉并丢失有效压缩。现在下一轮transcript接续摘要及合同补写后的leaf。Session仅在压缩投影中清除旧assistant usage，原始历史和累计费用保持。

独立差异共9文件，不包含627项继承工作态及其4个既有删除：

- `packages/neuro-book/server/agent/profiles/profile-runtime-settings.ts`
- `packages/neuro-book/server/agent/harness/compaction.ts`
- `packages/neuro-book/server/agent/harness/compaction.test.ts`
- `packages/neuro-book/server/agent/harness/neuro-agent-harness.ts`
- `packages/neuro-book/server/agent/harness/neuro-agent-harness.test.ts`
- `packages/neuro-book/server/agent/session/session-repo.ts`
- `packages/neuro-book/server/agent/session/session-repo.test.ts`
- `docs/specs/outline/agent-assistance.md`
- 本Task快照

有效验证（2026-10-12）：

- 8文件受影响回归：280通过、5跳过。命令：`bun run --cwd packages/neuro-book test server/agent/harness/compaction.test.ts server/agent/session/session-repo.test.ts server/agent/harness/neuro-agent-harness.test.ts server/agent/harness/prepare-run.test.ts server/agent/profiles/prompt-order.test.ts server/agent/profiles/outline-specialist-profiles.test.ts app/components/novel-ide/settings/sections/agent-profile/profile-runtime-settings.test.ts server/agent/harness/prompt-management.test.ts`。覆盖868k旧缓存首轮、连续工具后压缩持久、附加条目保护、中文与代理对分批完整性、取消/失败/输出截断、用户输入超窗口拒绝、历史与费用保留、配置覆盖和规划Profile。
- 酒馆编排回归：15文件、109通过、13跳过。命令：`bun run --cwd packages/neuro-book test server/agent/harness/prompt-management.test.ts server/prompt-management server/writing/tavern-agent-port.test.ts shared/prompt-management`。这些是faux和合同测试，不是模型输出质量验收；与上一组有重叠，不相加。
- `bun run docs:check`通过，failures为空，既有历史Task链接/合同警告仍存在；本轮Spec成熟度保持planned。
- 类型检查仅剩继承的`MaterialConflictResolver.vue(70,118)` state/main索引错误，本轮类型诊断已修复。worktree已独立安装依赖、Nuxt prepare及Prisma Client generate；锁文件与继承基线一致。曾出现esbuild系统临时路径sandbox读取错误，在获自动批准的隔离重跑后测试通过。
- 8个产品/文档文件的`git diff --check`通过。

交付边界：未提交、未推送、未合入主树、未写用户会话84、未调用真实模型。下一步是开发者从该worktree验收，或明确授权仅将上述独立产品差异合入主树；主树其他未提交修改必须保护。
