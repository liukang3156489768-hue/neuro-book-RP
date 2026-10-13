---
schema: nbook.task/v2
taskId: t08-extraction-ui-integration
---

# 提取功能接入（路由与界面）

## 目标与范围

把 t03 到 t07 的服务端能力接入产品：HTTP 路由与运行时接线，以及 Inspiration 设计工作台内的“作品提取”界面。合同见 [outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md)、[material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md) 与 [inspiration.workbench](../../../../../docs/specs/ui/inspiration-workbench.md)（后者的修订在 t09）。只接入功能，工作台整体 UI 整理不在本 Work。

分两个阶段顺序完成（阶段 B 依赖 A 的接口）：

### 阶段 A：路由与运行时接线

1. 在 `server/api/inspiration/extraction/` 下新增路由（沿用 `source-prepare.post.ts` 的模式：`resolveWorkspaceFileTarget` + `withProjectTargetOperation`/ready 项目入口，zod 校验请求，项目错误经既有错误映射）：
   - 来源与结构：读取章节识别结果（含修正后的列表）、建议划卷、字数模式 N 校验、确认后的提取结构（t03）。
   - 任务控制：启动大纲／素材任务、读取任务与进度（t04 `progress`）、取消、继续、单元重试、跳过单元、提供输入（归类、覆盖确认）。
   - 大纲：数据去向选项（`listOutlineDestinations`）、覆盖对比数据与确认、重新汇总本卷与总纲（`resummarizeVolumesAndTotal`，路由层保证与同任务的管理器操作不并发）。
   - 素材：归类列表与候选（`listClassification`）、待写入清单读取与编辑（选择、编辑、删除、拆分、合并）、冲突与对比、确认写入（`MaterialReviewService`）。确认者身份由服务端按调用来源判定（用户界面请求为 `user`；Agent 工具为 `agent`），不信任请求体自报。
   - 启动前注册两条流水线（`registerOutlineExtractionPipeline`、`registerMaterialExtractionPipeline`，幂等）；任务运行绑定项目生命周期而非请求。
2. Agent 工具：按 Spec“Agent 只能下发任务、确认新条目写入、接收失败上报”，在不编排提取内容的前提下提供最小工具面（下发任务、查询进度、确认新条目写入、失败上报读取）；是否放入现有 Inspiration 或大纲工具集、权限与 Profile 变更以实施时代码为准，不手改 `.compiled`，需要 Profile 文案变更时核实构建再生方式。
3. 修复 `WorkspaceLorebookDetailPanel.vue` 的 `renderDraft` 丢弃 `origin`、`extraction`、`ext` 的问题（已知阻碍提取素材的可编辑性；该项属本 Task 授权的处理，处理范围限于保留这些字段）。
4. 路由测试：参数校验、未打开项目、冲突、确认者身份判定、取消／继续、哈希变化拒绝；全部用 Mock 模型。

### 阶段 B：界面

在 Inspiration 设计工作台内新增“作品提取”区域，大纲提取与素材提取入口、进度面板分开、互不阻塞（Spec）：

1. 选择来源 → 展示章节列表（标题、P 范围、字数）与默认卷建议；章节修正（设为／取消标题、合并、拆分）；划卷编辑（章节模式按范围，字数模式按每卷块数 N）；确认划卷后开始大纲提取。
2. 大纲提取进度：整体、每卷、逐章状态；失败章重试、跳过；取消／继续；已中断提示；完成后的结果入口（提取方案）与“重新汇总本卷与总纲”。
3. 重复提取的数据去向选择（新建／补充／覆盖，不可用时给出原因），覆盖时逐项新旧对比与确认。
4. 素材提取：类别选择（默认九类）、开始、进度；待归类列表（疑似同一实体候选标注，勾选合并，可跳过）；整合进度；待写入审阅清单（默认全选、编辑、删除、拆分、合并）；同名冲突的对比确认（覆盖／另存／跳过）；确认写入与失败项说明。
5. 遵循 `.agents/skills/ui-development/SKILL.md`、`docs/standards/code/components.md`、`packages/nb-ui/docs/ui-development-spec.md`；新增或修改组件时同步并列的同名 `.md`；使用既有设计令牌与共享组件。入口位置默认放在 Inspiration 工作台内新增的“作品提取”标签页，并保留旧“作品分析提取”入口直到 t09 修订 Spec 时一并处理（本 Task 不删旧流程）。

## 非目标

- 不整理工作台整体 UI（方向 1，另行进行）；不改变原创设计流程；不删除旧提取流程。
- 不改变 t03 到 t07 的服务端语义；发现需要改的以“待报告问题”记录，阻碍时才最小处理。
- 不做真实模型调用，不做数据库迁移。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 验证

- 阶段 A：路由测试通过；`WorkspaceLorebookDetailPanel` 保存后 `origin`／`extraction`／`ext` 保留的测试；既有相关测试通过；`bunx tsc --noEmit -p .nuxt/tsconfig.server.json` 对本 Task 触及的文件零新增错误（`bun run typecheck` 在本机不可靠，见 Work 待报告问题）。
- 阶段 B：组件契约测试与关键交互测试（章节修正、划卷校验、去向选择、归类勾选、审阅清单选择与确认）；`app` 相关既有测试通过；用 `nuxt typecheck` 之外的方式（`vue-tsc` 或 `bunx tsc` 对应 app 配置）核对新增组件类型；在可行时本地启动应用做一次 Mock 模型的人工走查并截图或记录（真实模型不使用）。
- 更新两个提取 Spec 的“实现合同”（路由与界面事实），运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-02 阶段 A（路由与运行时接线）已在主工作区完成，未提交；阶段 B（界面）同日实现与验证完成，同样未提交，见下文“阶段 B 实现事实”。依赖 t05、t07（已完成）。

### 阶段 A 实现事实

所有路由在 `packages/neuro-book/server/api/inspiration/extraction/` 下，请求／响应 schema 在 `shared/dto/inspiration-extraction-api.dto.ts`（新文件，未改 t03 到 t07 的 DTO）。GET 的 `projectRoot` 走查询串，POST 的走请求体；所有请求体 strict，多余字段（包括自报的 `confirmer`）一律 400。`{taskId}` 必须是 UUID，否则 400。路径前缀均为 `/api/inspiration/extraction`。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| POST `/structure` | `projectRoot, path, corrections[], targetCharacters?` | 预览：`source, mode(chapters/chunks), recognition, chapters, suggestedVolumes`（每次从来源重新识别，服务端不存修正） |
| POST `/structure-confirm` | 同上 + `division`（章节模式按范围；字数模式带每卷块数 N） | `{source, structure}`；划卷违规 422，来源变化 409 |
| GET `/outline/destinations` | `projectRoot, path` | `{source, options}`（哈希取自磁盘） |
| GET `/tasks` | `projectRoot, kind?, path?` | `{tasks: 摘要[]}`（不含 params、state、单元明细） |
| POST `/tasks` | `kind: "outline"` 带 `source, workTitle, structure, corrections, destination, modelKey?`；`kind: "material"` 带 `source, categories?, modelKey?` | 202 `{task}` |
| GET `/tasks/{id}` | `projectRoot` | `{task, progress}` |
| POST `/tasks/{id}/cancel`、`/resume` | `projectRoot` | `{task}` |
| POST `/tasks/{id}/retry-unit`、`/skip-unit` | `projectRoot, unitId` | `{task}` |
| POST `/tasks/{id}/input` | `projectRoot, input`；大纲任务为 `{confirmedItems}`（覆盖确认），素材任务为 `{skip?, groups?}`（归类） | `{task}`；错种类的输入 422 |
| GET `/tasks/{id}/outline` | `projectRoot` | `readOutlineExtractionOutcome`：方案、数据去向、覆盖对比、已确认项、过期卷／总纲 |
| POST `/tasks/{id}/outline/resummarize` | `projectRoot` | `ResummarizeResult`；与同任务的取消、继续、重试、跳过、输入串行 |
| GET `/tasks/{id}/material/classification` | `projectRoot` | `{categories, candidates}` |
| GET `/tasks/{id}/material/review` | `projectRoot` | 待写入审阅清单 |
| POST `/tasks/{id}/material/review/action` | `projectRoot, action`：`select / update / remove / split / merge` 之一 | 更新后的审阅清单 |
| GET `/tasks/{id}/material/review/conflicts` | `projectRoot` | 与现有条目的同名冲突及对比（确认者固定为用户，故 `overwriteAllowed` 对设计条目为真） |
| POST `/tasks/{id}/material/confirm-write` | `projectRoot, decisions?[{itemId, action: overwrite/save-as/skip, saveAsName?}]` | `WriteReport`（确认者由服务端固定为用户） |

错误：领域错误经 `server/inspiration/extraction/http.ts` 映射为 `data.code`（`NOT_FOUND` 404、`CONFLICT／INVALID_STATE／SOURCE_CHANGED／REVIEW_LOCKED` 409、`INVALID_INPUT／REVIEW_INVALID／MODEL_OUTPUT_INVALID` 422、`PIPELINE_UNREGISTERED／MODEL_UNAVAILABLE` 503）；项目未打开等由项目守卫映射。

服务装配只有一处：`server/inspiration/extraction/host.ts` 的 `useProjectExtractionServices(projectRoot)`。它在取得服务前幂等注册两条流水线，缓存按项目 ready 引用（项目关闭再打开得到新实例与新队列），任务运行绑定项目生命周期而非请求。路由、Agent 工具与测试共用它。

**Agent 工具**（`server/agent/tools/extraction-tools.ts`，已加入 `server/agent/tools/index.ts` 与 `profile-sdk` 的 `builtin.extraction`，未绑定任何 Profile）：`start_inspiration_extraction`（大纲不修正章节、按建议划卷、写入新方案；素材可选类别）、`get_inspiration_extraction_progress`、`confirm_inspiration_material_write`（确认者为 `{kind:"agent", sessionId}`，不带 decisions，只写无冲突的新条目；冲突原样返回，Agent 不能覆盖 `origin` 缺失或为 `design` 的条目）、`get_inspiration_extraction_failures`。下发与确认写入两个工具标记 `mutatesWorkspace`。未改任何 Profile 源，因此不涉及 `.compiled`：它由 profile-artifact-compiler 按 Profile 源哈希在构建期再生，以后需要给 Profile 加文案时随构建再生即可，不要手改（从代码推断，未实际执行构建）。

**`WorkspaceLorebookDetailPanel.vue`**：草稿新增 `preservedFields`，保存时原样写回 `origin`／`extraction`／`ext`，其余字段行为不变。

**阶段 B 的组合方式**：没有写客户端 composable。界面按 `$fetch` 直接调用上表路由即可，推荐顺序是：`/structure` 预览（可反复带修正与 N 重放）→ `/structure-confirm` 得到 `structure` → `/tasks` 启动（大纲）；素材直接 `/tasks`。进度靠轮询 `GET /tasks/{id}`（`progress` 含整体与分组计数、等待原因与停止原因）。任务处于 `awaiting-input` 时按 `awaitingInput` 与任务种类决定展示覆盖对比（`/outline`）或归类（`/material/classification`），再用 `/input` 提交；素材完成后用 `/material/review` 加 `/review/action` 编辑，`/review/conflicts` 看冲突，`/confirm-write` 写入。界面请求不要也不能带确认者。

**测试结果**：`server/api/inspiration/extraction/routes.test.ts` 17 条（参数校验、未打开项目、冲突、确认者身份、取消与继续、哈希变化拒绝、重新汇总与取消的串行）；`server/agent/tools/extraction-tools.test.ts` 6 条；`server/inspiration/extraction/http.test.ts` 14 条（错误映射、按任务串行队列、确认者）；`WorkspaceLorebookDetailPanel.test.ts` 3 条（去掉修复后其中 2 条失败，已核对）。`bun run test server/inspiration server/api/inspiration server/agent/tools/extraction-tools.test.ts app/components/novel-ide/workspace` 共 25 个文件 237 条通过。`tsc -p .nuxt/tsconfig.server.json` 共 388 条既有错误，本 Task 触及的文件零错误。app 侧 `.vue` 的可靠核对方式是 `NODE_OPTIONS=--max-old-space-size=8192 bunx vue-tsc --noEmit -p .nuxt/tsconfig.app.json`（含面板及其测试，仅 3 条既有的 `web-tools.ts` 缺类型声明错误）。

**已知限制**：
- 排在长时间“重新汇总”之后的取消会等它结束；重新汇总只在项目关闭时才会被中止。
- Agent 确认不能解决冲突或覆盖；Agent 下发的大纲提取不能修正章节，只写新方案，字数模式的每卷块数固定为 5（`DEFAULT_CHUNKS_PER_VOLUME`）。
- 路由测试中数据去向与重新汇总的真实实现被桩替换，它们由各自模块的测试覆盖。
- 等待输入的任务不占用同来源的 `CONFLICT` 键，只有运行中的任务才占用；界面应据此决定是否允许再次启动。

### 阶段 B 实现事实

**入口**：`InspirationWorkbenchDialog` 顶部新增“设计 / 作品提取”页签（`SegmentedControl`），“作品提取”页首次切入时才挂载 `InspirationExtractionPanel`，之后用 `v-show` 保留状态；原设计页与“作品分析提取”流程未改。对话框新增 `open-outline-plan` 事件，`pages/index.vue` 仅追加一处 `@open-outline-plan`（关闭灵感窗口并打开大纲工作台）。

**分层**：
- 请求：`app/utils/inspiration/extraction-api.ts`（`ExtractionApi` 接口与基于全局 `$fetch` 的默认实现，不夹带确认者）、`extraction-labels.ts`（状态、单元、停止原因、写入状态等中文文案与 `describeExtractionError`，服务端中文消息优先，缺失时按业务码兜底）。
- 状态：`app/composables/useExtractionTaskTracker.ts`（单个任务的轮询：只在 `running` 时安排下一次读取，非运行、读取失败、`dispose` 与卸载都会停止，用代际计数丢弃迟到响应）、`useInspirationExtraction.ts`（来源、章节修正重放、划卷草稿与延迟校验、大纲／素材两套独立控制器）。
- 组件（`app/components/novel-ide/inspiration/extraction/`，每个都有先写的同名 `.md`）：宿主 `InspirationExtractionPanel`；视图 `OutlineExtractionView`、`MaterialExtractionView`；纯展示组件 `ExtractionSourcePicker`、`ExtractionNotice`、`ChapterListEditor`、`VolumeDivisionEditor`、`OutlineDestinationPicker`、`ExtractionProgressPanel`、`OutlineOverwriteComparison`、`OutlineResultCard`、`MaterialCategoryPicker`、`MaterialClassificationPanel`、`MaterialReviewList`、`MaterialReviewItemEditor`、`MaterialReviewSplitForm`、`MaterialConflictResolver`、`MaterialWriteReport`。只有宿主声明 `io:` 标签，请求入口可经 `api` prop 替换。

**使用**：选来源 → 章节与修正 → 划卷 → 数据去向 → 确认划分并开始（大纲）；素材页选类别开始，等待归类时合并或跳过，结束后审阅清单、确认写入、处理同名冲突。大纲与素材可以同时进行。

**测试**：新增 38 条，全部通过。
- `useExtractionTaskTracker.test.ts` 5 条：只在运行时轮询、等待输入与中断不轮询、`dispose` 后不再请求、轮询失败停止并显示原因、控制操作失败保留任务。
- `useInspirationExtraction.test.ts` 9 条：来源与预览、划卷校验错误原样显示及恢复、章节修正重放与撤销、启动请求不含确认者字段、校验不通过不启动、素材类别顺序与两个任务独立、同名冲突先交给用户、恢复未完成任务、运行中轮询与 `dispose`。
- `extraction/extraction-components.test.ts` 20 条：组件合同（同名 `.md` 与标签、仅宿主有 io、无单行压缩 CSS 与确认者字段）；章节修正、划卷错误显示、去向选择与不可用原因、覆盖对比默认勾选、归类勾选与合并、审阅清单选择与确认写入、冲突决定。
- `extraction/extraction-views.test.ts` 4 条：两个视图联动渲染与互不阻塞、宿主无作品提示与卸载后无轮询。
- `bun run test app/components/novel-ide/inspiration app/composables`：22 个文件 156 条通过（含既有的 `InspirationWorkbenchDialog` 合同测试）。`vue-tsc --noEmit -p .nuxt/tsconfig.app.json` 本 Task 触及文件零错误，仅剩 3 条既有的 `web-tools.ts` 缺类型声明错误。

**人工走查**：未做人工走查。本次没有启动应用，因此未在真实界面核对 `390×844` 无横向滚动与主题表现，这两项是从代码与令牌使用推断，未验证。

**已知限制**：
- “打开提取方案”只关闭灵感窗口并打开大纲工作台：`OutlineWorkbenchDialog` 的 `focus` 要求 `{entryId, planId, token}`，仅凭 `planId` 无法预选方案，需用户在大纲工作台里自行切换。
- 章节修正按累积列表整体重放，只能撤销最后一项或全部还原，不能撤销中间某一项。
- 素材提取要求先成功载入章节预览（用其来源哈希启动任务）。
- 轮询读取失败后不自动重试，由用户刷新；没有为任务进度做服务端推送。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
