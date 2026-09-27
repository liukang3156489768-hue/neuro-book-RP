---
schema: nbook.task/v2
taskId: t07-outline-agent-approval-and-streaming
---

# 规划 Agent 审批与流式协作

## 目标与范围

执行实施计划 Phase 5：为规划 Agent 提供 Project 作用域的受限上下文、草案与变更预览、用户审批、批量结果、撤销、审计、事件流、取消和迟到结果隔离。规划 Agent 只能经规划领域入口读写规划数据，不得写正文、`lorebook/` 或任意文件；删除始终需要影响预览和显式确认。

## 专用子 Agent（2026-09-26）

- **来源**：开发者决定，把《新小说编写计划》原始设计中的 `outline`、`Detailed outline`、`foreshadowing` 三个 Agent 作为规划助手的专用子 Agent 实装。它们是最终条目的产出者，可读写规划模块和 `lorebook/`；素材读取复用现有 `read` 工具。
- **Profile**：`outline.outline`、`outline.detailed`、`outline.foreshadowing`。
  - 工具：读取规划、预览、`read`、`commit_planning_change`、`write_lorebook`、`edit_lorebook`、`report_result`；`outline` 与 `foreshadowing` 另有伏笔上下文与标记建议工具；
  - 没有通用写、bash、撤销或 Agent 协作工具；
  - 输出报告：摘要、提案、已写入对象（含事务 id）、待澄清问题。
- **规划助手的两个委派工具**（`server/agent/tools/planning-specialist-tool.ts`）：
  - `consult_planning_specialist`（咨询）：只读；
  - `delegate_planning_task`（委派产出）：声明 `mutatesWorkspace`，讨论模式下 harness 先请用户审批委派，自动模式直接执行；
  - 两者都只允许 `outline.planner` 调用，按“主会话 + Project”复用子 Agent 会话，并沿用主会话模型。
  - 规划助手另加 `read`，用于读取素材。
- **写入门禁**（`planning-delegation.ts`）：写入授权只在一次委派产出调用期间按子 Agent 会话存在于进程内存；咨询和普通会话中调用写工具一律拒绝。
  - `commit_planning_change`（`planning-tools.ts`）只供子 Agent 使用：必须带预览 proposalId，只允许条目与伏笔的新增、编辑和确认，拒绝删除、解除关系与线路操作；
  - `write_lorebook`、`edit_lorebook`（`lorebook-file-tools.ts`）包装通用 write/edit：只允许当前 Project `lorebook/` 内的 Markdown 文件，按真实路径校验，拒绝多重硬链接。
- **提交修复**：`packages/neuro-book/.gitignore` 放开 `assets/workspace/`，同时继续忽略 `.compiled/` 编译产物和 `skills/llmlint/` 投影。四个规划 Profile 现在显示为普通未跟踪文件，可正常 `git add`。
- **验证**：
  - 新增和更新的 3 个测试文件共 23 项通过：委派授权的授予与撤回、专家提交门禁、真实 Project 下 lorebook 写入与越界拒绝、Profile 工具合同；
  - 应用 typecheck 通过。
- **未验证**：真实模型与真实 harness 的端到端委派，包括讨论模式下委派审批在工作台中的展示。
- **已知边界**：
  - 三个子 Agent 的 Profile 为 public，可能出现在普通 Agent 创建列表中；在普通会话里它们没有写入授权；
  - 规划助手自身的 `apply_planning_change` 仍始终要求审批，自动模式下也不例外，这是此前就存在的行为，本次未改。

## 条件审批（2026-09-26）

- **问题**：`apply_planning_change` 与 `undo_planning_change` 声明 `approvalRequired`，harness 在两个分支无条件注入审批，导致自动模式仍逐次打断，与设计不符。
- **改动**：
  - `NeuroAgentTool` 新增 `approvalConditional` 与 `requiresApproval({args, agentMode})`；
  - harness 注入审批与 resolution 续跑都改走 `requiresDeclaredApproval`：只读模式一律审批，自动模式交给工具自己判断；
  - `ToolExecutionContext` 新增 `agentMode`，由 `runToolBatch → executeTool*` 逐层透传；规划审计的 mode 字段同时按新映射记录真实模式（此前取不到上下文模式，一直记 unknown）；
  - 规划工具据此声明：`apply_planning_change` 在自动模式下只对删除类变更审批，`undo_planning_change` 在自动模式下直接执行；`run_workflow` 等既有 `approvalRequired` 工具行为不变。
- **验证**：应用 typecheck 通过；相关测试见“有效验证”。删除在任何模式下仍需审核。

## 工具 schema 与讨论模式审批修复（2026-09-26）

- **现象**：与工作台 Agent 对话时每轮返回 `400 Invalid schema for function 'get_foreshadowing_context' ... got 'type: null'`。
- **原因**：OpenAI 兼容 provider（DeepSeek）每次请求都校验全部函数定义，要求顶层 `type: "object"`。`get_foreshadowing_context` 与 `preview_planning_change` 的参数是顶层 `Type.Union`（`anyOf`），模型一轮都跑不起来。faux 模型不校验 schema，因此此前回归未暴露。
- **改动**：
  - `get_foreshadowing_context` 改为两字段可选的 object，“至少指定一项”由执行入口校验；
  - `preview_planning_change` 对外声明按 `operation` 区分的扁平 object（`PreviewParametersSchema`），执行时仍用 `PreviewSchema` 严格校验各分支；
  - `builtin-tools-smoke.test.ts` 新增合同：全部内置工具的参数顶层必须是 object。
- **同时发现的缺陷**：`initial.mode` 只进入提示词，harness 新会话运行模式默认 `normal`，`OutlineWorkbenchAgentPane` 对 mode 的 watch 不立即触发。结果是工作台“讨论”模式下非删除类写入不经审批就执行，faux 黑盒 3 项因此一直失败（期望 `waiting`，实际 `completed`）。`useOutlineWorkbenchAgent.ensureSession` 现在创建会话后立即 `runCommand({command: "mode"})` 同步（discuss→discuss，auto→normal）。黑盒测试同步补上这一步，工作台合同测试锁定该调用。
- **证据**：
  - 服务端大纲、规划工具、API 与 faux 黑盒单 worker 25 文件 204 项通过。
  - 真实模型 smoke `scripts/smoke/real-model/outline-planner.test.ts` 使用内置 `outline.planner` 源码定义、真实工具面和 `deepseek/deepseek-v4-pro`，通过：依次调用 `get_planning_context`、`get_foreshadowing_context`、`preview_planning_change`；`apply_planning_change` 停在审批，批准后写入总纲。
  - 对照：临时恢复旧 union schema 后，同一 smoke 复现同样的 400。
  - 应用 typecheck 通过。

## 审批提交后面板不消失修复（2026-09-26）

- **现象**：用户已处理审批请求（面板显示“此项已确认”），但“等待你的处理”面板一直停留，“提交全部”持续转圈，典型场景是 `delegate_planning_task`。
- **原因**：harness 在 `appendResolutions` 中同步执行已批准的工具，执行完才写 tool result。pending 由“有 tool call 无 tool result”派生，所以整个执行期间 live state 与 recovery 都还把它投影为待处理。前端只在服务端推送的 pending 为空时才移除面板。委派子 Agent 要跑完整个 specialist 运行，面板会停留到子 Agent 结束。这一问题对所有长耗时审批工具都存在，主对话面板同样受影响，不限于大纲工作台。
- **改动**（`server/agent/harness/neuro-agent-harness.ts`）：
  - 新增仅本进程有效的 `resolvingToolCalls`。`appendResolutions` 校验通过后先登记本批 tool call，并立即 `publishSessionState`，此时推送的是空 pending 加运行中状态；执行结束或失败后在 `finally` 中移除。
  - `resolveSessionRuntimeProjection` 投影 pending 时过滤掉登记中的 tool call。进程中断时登记随内存丢失，重启后按落盘事实重新成为待处理。
  - 原执行逻辑原样移到 `executeResolutions`。
- **证据**：
  - 新增 `neuro-agent-harness.test.ts`“批准后的审批工具执行期间不再对外投影为待处理，并立即推送运行态”。慢工具阻塞期间断言 live、recovery 与推送的 `session_state_changed` 中 pending 均为空且状态为 running，放行后 `completed`。
  - 对照：去掉过滤后该测试在执行期 live pending 断言处失败。
  - 回归：harness、大纲服务端、规划工具、黑盒与 outline API 单 worker 共 27 文件 402/403 通过。唯一失败的 `server/outline/line-planning.test.ts`（`PUBLISH_FAILED`）单独重跑 4 次均 6/6 通过，属于负载下的偶发失败，与本改动无关。
  - 其他审批相关测试 4 文件 102 项通过，前端 outline/agent 34 文件 298 项通过，typecheck 通过。
  - 未验证：浏览器实测与真实模型委派场景。
- **遗留风险（从代码推断，未改）**：审批执行期间用户中止时，abort 路径自行计算 pending，可能在工具仍在执行时为其写入中止结果。该行为改动前已存在。

## 工作台所选模型未生效修复（2026-09-26）

- **现象**：工作台选择 `deepseek-v4-flash`，实际调用的是 `deepseek-v4-pro`。
- **原因**：与运行模式同类。`initial.model` 和 `initial.thinking` 只写进 system prompt；harness 创建会话时按全局配置绑定默认模型（`resolveInitialSessionModel`）。`OutlineWorkbenchAgentPane` 对 modelKey 和 thinking 的 watch 只在设置变化且已有会话时才发命令：已保存的工作台设置不会触发 watch，没有会话时修改设置也会被 `updateRuntime` 直接忽略。结果是会话始终使用全局默认模型。
- **改动**：`useOutlineWorkbenchAgent.ensureSession` 创建会话后，依次同步 mode、model（经 `resolveModel` 校验后的 key）和 thinking，再发起首轮调用。
- **证据**：
  - 新增 `app/composables/useOutlineWorkbenchAgent.test.ts`（jsdom，mock 会话 API）：断言首轮 invoke 前依次发出 mode、model 为 flash、thinking 为 off 三条命令。
  - 对照：去掉 model 和 thinking 同步后该测试失败。
  - harness 按会话绑定模型发起调用，已有 `neuro-agent-harness.test.ts` 的 model 命令用例覆盖。
  - 前端 outline 8 文件 30 项通过，typecheck 通过。
  - 未验证：浏览器与真实 provider 下观察实际请求模型。
- **温度（同日开发者确认修复）**：Agent 会话 HTTP 合同原本不承载 temperature，工作台温度控件只写进提示词。现在 `AgentInvokeRequestDtoSchema` 新增可选 `temperature`（0–2），由 `toInvokeInput` 映射为 harness 已有的单次 `requestOptionsPatch`，不写入 session，与灵感模块同口径。工作台的 prompt 与 continue 调用都携带当前温度。
  - 证据：`server/agent/http.test.ts` 覆盖映射与越界拒绝；`useOutlineWorkbenchAgent.test.ts` 断言 invoke 携带温度；typecheck 通过。
  - 未验证：真实 provider 请求体。

## 当前快照（2026-09-25）

- `outline.planner` Profile、规划工具注册和 SDK 绑定已落地。`get_planning_context`、`get_foreshadowing_context`、`suggest_foreshadowing_marker`、`preview_planning_change`、`apply_planning_change`、`undo_planning_change` 形成受限工具面；建议不写盘，正式变更沿既有审批、CAS、事务、History 和索引路径执行。
- Agent 工具对删除、总纲二次确认、对象／关系影响预览、过期 proposalId、批量部分失败和撤销冲突保留服务端门禁；审计记录进入 Session custom state，事件进入 Agent event hub，取消或审批拒绝不会提交规划变更。
- faux Agent Session 黑盒回归覆盖读取、预览、审批执行、审批拒绝和等待中取消；规划工具合同覆盖 capability 白名单、无 ready Project fail-closed、伏笔建议 CAS 与审批、删除确认和批量结果。规划工作台在 Phase 6 通过现有 Session/SSE/审批容器消费该能力。

## 有效验证

- Phase 5 专项回归单 worker：4 个测试文件、18 项通过，覆盖规划工具、伏笔工具、faux Agent Session 黑盒和章级写作 workflow 的锚点传递。
- `bun run --cwd packages/neuro-book typecheck`：通过。
- Profile SDK 全量编译／Windows symlink fixture 仍未通过环境门禁，不能以静态 Profile 合同替代运行时证据；默认全包、完整 Nuxt／浏览器和真实模型未执行。

## 当前未完成边界

- 真实运行中的 Profile fixture、完整 Nuxt／浏览器审批与取消交互、默认全包和真实模型 smoke 尚未验收。
- 本 Task 不调用真实模型、不使用真实作品数据、不提交、不推送、不创建 PR；Phase 5 Spec 继续保持 `planned`，直到统一 Work 验收门禁闭合。

## Schema 扩展（一.2 — 已完成，2026-09-26）

- **结果**：条目与伏笔 schema 升至 v2，v1 读取时归一，新写入均为 v2。实际落地与中断时的计划不同：
  - 参考文件为 `references: {path?, locator?, purpose?, pending?}[]`，待补项可无路径但须有 `locator`，旧 `referenceFiles` 读取时转换；
  - 场景写作指导与场景篇幅合并为细纲正文内的 `<!-- nb:guidance marker scene words -->` 成对注释，不另设 `sceneBudgets`；快照校验只允许细纲携带；
  - 伏笔设计分项为 `surface`、`connection`、`plant`、`recover`，编辑时缺省沿用、null 清除；
  - 已过章节数由 `deriveForeshadowingElapsed` 按方案派生，经伏笔状态接口、规划 Agent 伏笔上下文返回，工作台卡片只读显示；
  - 待补参考文件以 `PENDING_REFERENCE` 告警随细纲分析报告与正文交接返回，不持久化、不阻止采用，且不能经素材读取接口读取。
- **兼容性发现**：采用细纲时会按 v2 重写文件，正文交接用规范序列化重算来源 hash，因此非规范格式（v1 或手工排版 YAML）的细纲草稿在分析入口即被拒绝，提示先保存一次。本 Work 尚未发布，已按 v1 采用的开发数据需重新保存并分析。
- **证据**：应用 `typecheck` 通过；`bunx vitest run server/outline server/agent/tools/foreshadowing-tools.contract.test.ts server/agent/tools/planning-tools server/api/projects/outline --maxWorkers=1` 22 文件 186 项通过。浏览器、默认全包和真实模型未验证。

## 下一步

1. 工作台编辑能力（一.1）已于 2026-09-26 完成前端界面，记录见 [t08](../t08-outline-workbench-ui/README.md)。
2. 补齐 Profile 运行时环境、浏览器人工验收和真实模型 smoke；若出现新的审批或事件语义缺口，再在领域工具和 Session owner 内补回归，不在 UI 增加旁路写入。

## 合同

- [实施计划](../../implementation-plan.md)
- [Agent 协助 Spec](../../../../../docs/specs/outline/agent-assistance.md)
- [大纲规划 Proposal](../../../../../docs/proposals/outline-planning-module.md)
