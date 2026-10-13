---
schema: nbook.task/v2
taskId: t07-material-extraction-pipeline
---

# 素材提取流水线

## 目标与范围

按 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md) 在 t04 任务框架与 t06 素材基础上实现素材提取流水线：逐块逐类提取、归类暂停点、整合、审阅与写入 `lorebook/`。本 Task 只交付服务端流水线与领域层接入，不含 HTTP 路由、界面，不做真实模型调用。

要交付：

1. **分块与调度**：沿用 `splitInspirationSource` 的约五万字分块；用户选择类别（默认九类）；角色先按块建立轻量发现单元，再按“角色 × 出现块”建立逐个提取单元；其他类别仍为“块 × 类别”单元。同一块的提示词前缀均为该块原文，任务目标在末尾。
2. **已知实体名单**：仅实体型类别（角色、势力、物品、地点、特殊规则）的调用在原文之后附带当前已知实体名单（名称与别称）；模型返回已有实体标准名称时追加到对应实体文件夹，不新建；名单不出现在文档型、逐条收录类别的上下文。
3. **校验**：用 t06 的 `validateMaterialTemplateFields` 与 P 引用规则，引用须在本块范围内；“不涉及剧情”规则的提示词与校验按 t06 的 `allowsPlotDevelopment` 取舍，仅写作手法与素材特点放开。校验失败走 t04 修复重试。
4. **中间产物**：存放于 `.nbook/inspiration/extractions/<任务 ID>/`——实体型每实体一个文件夹、逐块追加片段；文档型每类别一个文件夹、每块一份分析稿；素材特点每条一个文件记录所在块与 P 引用；角色另设经历与人际关系子目录。完成单元重复执行不产生重复片段。
5. **归类暂停点**：全部分块完成后任务暂停为“待归类”，列出各实体型类别的实体文件夹，按别称标出疑似同一实体的候选；用户（或 Agent）确认归类后继续；归类可跳过，跳过则每个文件夹独立。无实体型类别时跳过暂停。
6. **整合**：实体型每个实体（或归类后的实体组）一个整合单元，输入仅为其文件夹内容；文档型每类别一个整合单元；素材特点不整合；角色主文件只含基本人设，经历与人际关系按块顺序整理成时间线，保留 P 引用，不去重。整合同样校验并走两次失败上报。
7. **审阅与写入**：整合完成后产出待写入清单数据（默认全选；支持编辑、删除、拆分、手动合并——合并发起一次模型调用，思考关闭）；确认后经 tracked workspace writes 与项目 mutation gate 批量写入 `lorebook/`，元数据 `origin: extract` 带来源文件、哈希与 P 引用（t06 的 `buildExtractedMaterialFrontmatter`）。与已有素材同名时进入对比确认（覆盖／另存／跳过），Agent 只能确认新条目写入，覆盖用户设计条目必须用户本人确认；确认前不写入，部分写入失败说明失败项，已成功项不回滚也不重复写。
8. 全部模型调用经 t04 模型端口，思考关闭；素材任务与大纲任务状态互不影响。

## 非目标

- 不做 HTTP 路由、界面、Agent 工具（切片 8）。
- 不提取“事件”“参考资料”类别；不改变原创设计八类流程。
- 不做真实模型调用，不做数据库迁移。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 依赖

t04（任务框架；流水线接口与“待人工输入”终态见其“当前状态”）、t06（模板、校验、来源标记）。

## 验证

- 聚焦测试（Mock 模型、临时项目）：12 万字来源切三块，角色先发现再按角色逐块提取，其他类别按块提取且前缀均为块原文；别称返回标准名称时追加到已有文件夹；文风调用上下文不含实体名单；引用越界重试一次再失败则该单元失败其余继续；全部块完成后暂停并标出疑似候选，归类详情可读取成功片段；勾选两个文件夹为同一实体后整合为一个条目；角色整合后主文件只含基本人设、经历与关系带 P 引用且未去重；素材特点每条一个文件；审阅取消勾选不写入；与用户设计条目同名进入对比、Agent 不能覆盖、“另存”后原条目不变；中断后继续；所有请求思考关闭；与大纲任务并行互不影响。
- `server/inspiration` 既有测试通过；应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 完成后更新 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md)“实现合同”，运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-03 本轮验收反馈：按开发者要求，写作手法与素材特点正文分别写入 note 下“写作手法”“写作素材”目录；提取后 AI 分批读取完整字段生成分类、摘要、检索词，程序发布 note 根下两份索引并以真实写入路径生成链接。写作手法继续按块保存，不再跨块整合正文。当前行为以 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md#写作手法与写作素材的检索索引) 为准，下方首版记录只作为实现来源。

本轮验证：分次聚焦运行的素材模板16项、流水线17项、审阅22项、索引注释3项、HTTP路由18项、Agent工具6项、完整端到端Mock冒烟6项均通过，共88项独立用例。覆盖批量完整阅读、遗漏/重复/未知身份校验、摘要缓存与正文变更失效、部分写入、分类目录、另存为、多任务追加、重确认及索引补写。直接服务端 `tsc` 在本次改动文件零错误，全包仍有既有诊断；应用 `vue-tsc` 仍为 `web-tools.ts` 的3项缺类型声明。`docs:check` 为其他规范文件的6项已有错误，本轮规范与提案无错误记录。没有调用真实模型、移动既有用户文件、提交或远端写入。

2026-10-02 实现与验证完成（未提交）。

### 实现内容

代码都在 `packages/neuro-book/server/inspiration/extraction/`，只经 t04 的 `ExtractionModelPort` 调用模型；没有 HTTP 路由、界面、数据库迁移，没有改 `runtime.ts` 的既有导出。

| 文件 | 职责 |
|---|---|
| `material-pipeline.ts` | `createMaterialPipeline({target})`（`kind: material`）：`prepare` 生成角色发现与非角色块 × 类别单元；发现完成后动态追加逐角色逐块单元；`settle` 在全部提取完成后返回 `awaiting-input`（待归类）或追加整合单元；`acceptInput` 接收归类。`registerMaterialExtractionPipeline()` 幂等注册 |
| `material-extract.ts` | 角色发现、逐角色提取，以及其他实体类（附已知名单、别称并入已有文件夹）、文档类、逐条收录类（素材特点）；产出按 t06 的 `validateMaterialTemplateFields` 与本块 P 范围校验 |
| `material-consolidate.ts` | 归类视图 `listClassification`（含按名称/别称重合标出的疑似同一实体）、`listClassificationWithDetails`（读取成功片段投影详情）、`acceptClassification`、整合单元规划与执行 |
| `material-intermediate.ts` / `material-data.ts` / `material-prompts.ts` | 中间产物读写（`.nbook/inspiration/extractions/<任务 ID>/`）、类别规格与落盘 schema、提示词 |
| `material-review.ts` | 待写入清单的纯数据与纯函数：默认全选，编辑、删除、拆分、手动合并的数据变换 |
| `material-review-service.ts` | `MaterialReviewService`：把整合结果同步成清单并持久化到任务目录的 `review.json`，同一任务操作串行；手动合并发起一次模型调用 |
| `material-write.ts` | 确认写入、冲突预览、另存为、确认者规则 |
| `material.fixture.ts` / `material-pipeline.test.ts` / `material-review.test.ts` | 测试夹具与角色发现、逐角色提取回归用例 |

要点：

- 提取：同块各类别的提示词前缀逐字节为该块原文（t04 的 `renderSourcePrefix`），已知实体名单只追加在实体类调用的原文之后，不影响共享前缀。引用必须落在本块范围内，失败走 t04 的一次修复重试，再失败则该单元失败、其余继续。
- 幂等：提取单元重复执行时先清掉本块在所有文件夹的旧片段再整体写入，取消后整体重做不留重复片段；文档类同一路径整体覆盖；素材特点先删本块旧文件再写。
- 归类暂停：全部提取完成后若有实体文件夹则暂停，没有则跳过；归类可跳过（每个文件夹独立）。分组只允许同类别的文件夹，每个文件夹至多属于一个分组。
- 整合：实体（或归类后的实体组）与文档类各一个单元；素材特点不整合。整合输入只含对应文件夹内容，整合产出的引用不得超出草稿已有范围；只有一份草稿时直接沿用，不调用模型。角色主文件只含基本人设，经历与人际关系按块顺序保留 P 引用，不去重。
- 审阅与写入：确认前不写 `lorebook/`。写入经 `withProjectTargetMutation` 与记账写入（用户或 Agent 归因），frontmatter 用 t06 的 `buildExtractedMaterialFrontmatter`（`origin: extract`）。路径为 `lorebook/<类别目录>/<名称>/index.md`，角色另有 `experience/`、`relationship/` 子节点。
- 冲突：同路径内容不同视为同名冲突，必须有逐条决定（覆盖／另存为／跳过）。内容逐字相同视为已写入（恢复用，不重复写）。另存为默认命名“<名>（提取）”并避开已占用名称，原条目不动。
- 部分失败：逐条报告，成功的节点不回滚；失败条目的 `writtenRoles` 保留已写节点，重新确认只补写缺失节点。

### 供切片 8（路由、界面、Agent 工具）使用的接口

- 启动：`manager.start({kind: "material", source, params})`，`params.categories` 可选，为 `MATERIAL_CATEGORIES` 键的子集，缺省九类。路由层先调 `registerMaterialExtractionPipeline()`。
- 类别选择：`MATERIAL_CATEGORY_SPECS`（键、中文名、处理方式、目录）。
- 归类：任务为 `awaiting-input` 时调用 `listClassification(task)` 取得 `{categories: [{category, label, folders: [{key, name, aliases, blocks}]}], candidates: [{category, folders, reason}]}`；输入经 `manager.provideInput(id, input)`，`input` 为 `{skip: true}` 或 `{groups: [{category, folders: [文件夹键, …]}]}`。非法输入抛 `INVALID_INPUT`，任务保持暂停。归类期间可对失败单元 `retryUnit`；整合单元追加后再重试提取单元不会回流到已排队的整合。
- 待写入清单：`new MaterialReviewService({target, tasks: manager, model})`；`get(taskId)` 返回 `MaterialReview`（纯数据，`items[]` 含 `id`、`category`、`title`、`aliases`、`nodes`、`selected`、`directoryName`、`write`）；`setSelected`、`update`、`remove`、`split`、`merge(taskId, itemIds, signal)`。已写入的条目被锁定（`MaterialReviewError` 的 `LOCKED`）。
- 冲突对照：`conflicts(taskId, confirmer)` 返回 `ConflictComparison[]`（现有内容、拟写内容、`overwriteAllowed`）。
- 确认写入：`confirmWrite(taskId, {confirmer, decisions?})` 返回 `WriteReport {review, outcomes, conflicts}`；`confirmer` 为 `{kind: "user"}` 或 `{kind: "agent", sessionId}`；`decisions` 为 `{itemId, action: "overwrite" | "save-as" | "skip", saveAsName?}[]`。没有决定的冲突条目保持待写入，随 `conflicts` 返回，界面据此弹出对照后带决定再次确认。

### 取舍与已知限制

- “不涉及剧情”规则（写作手法与素材特点除外）只在提示词层面约束，没有程序校验：判断一段文字是否在讲剧情需要语义理解。
- Agent 与覆盖：Agent 确认不能覆盖 `origin` 缺失或为 `design` 的条目（只能另存为或跳过）；对 `origin: extract` 的旧提取条目允许覆盖，这是对任务描述“Agent 只能确认新条目写入”的略微放宽，需要更严时在 `canOverwrite` 一处收紧。
- 编辑清单时段落是否存在无法在编辑期知道，P 引用范围放宽到 P1 起，是否存在在写入时还原原文再校验，不存在则该条目失败并报告。
- 拆分只对角色的经历与人际关系记录有意义，其他类别没有可拆内容，会返回 `INVALID`。
- 写入台账在一批写入结束后落盘，进程在写入中途崩溃时已写文件靠“内容逐字相同”识别为已写入，不会重复写；但崩溃前未落盘的 `savedAs` 名称不会保留。
- 实体按块顺序处理，提取单元整体重做时会撤销本块在索引里的旧贡献再加入新结果。
- 项目 mutation gate 不可重入，所以台账不在写入回调里落盘。

### 验证

- `bun run test server/inspiration/extraction/material`：素材流水线与归类详情投影回归通过，覆盖角色发现、逐角色逐块提取、别称并入、越界重试失败、暂停与疑似候选、分组整合、角色时间线不去重、素材特点逐条、取消后继续、请求只含 system/prompt/signal/modelKey、与大纲任务并行。“思考关闭”由 t04 的适配器固定（`model-adapter.test.ts` 已验证 `reasoning: undefined`）。
- `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` 通过。
- `server/inspiration` 全量：素材相关用例全部通过；同期 t05 并行开发的 `outline-pipeline.test.ts` 有一个用例（跳过失败章节后卷纲）在运行时失败，属并行进行中的 t05，与本切片无关。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
