---
schema: nbook.task/v2
taskId: t05-outline-extraction-pipeline
---

# 大纲提取流水线

## 目标与范围

按 [outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md) 在 t04 任务框架上实现大纲提取流水线：创建提取方案与空结构，自下而上填充细纲、章节大纲、卷纲、总纲，并处理重复提取的数据去向。本 Task 只交付服务端流水线与领域层接入，不含 HTTP 路由、界面，不做真实模型调用。

要交付：

1. **启动与结构预建**：以 t03 的提取结构（章节、卷）和用户确认的划卷创建任务；在大纲库新建方案“提取方案N·<作品名>”（N 在同一作品的提取方案中递增），预建空总纲、卷纲、章节大纲结构。重复确认不创建第二个方案。
2. **流水线单元**：每章“细纲”“章节大纲”两个独立单元（共用同一份系统提示，前缀为本章原文，章节大纲追加该章细纲）；每卷“卷纲”单元（输入只含本卷章节大纲，不读原文）；“总纲”单元（输入只含全部卷纲）。就绪规则：章节大纲依赖本章细纲；卷纲依赖本卷全部章完成（失败章暂缓，被明确跳过则按已完成章汇总并标注缺失章）；总纲依赖全部卷纲。
3. **校验**：产出须模板字段完整；细纲与章节大纲的原文引用（P 范围）必须落在本章范围内，卷纲、总纲不要求原文引用。校验错误信息为中文，可直接拼入 t04 的修复重试。
4. **写入**：细纲经 t02 的 `prepareSourceExtractionDetail` 写入，章节大纲、卷纲、总纲经大纲领域操作写入，进入工作区历史；已完成单元重复执行不产生重复条目。
5. **数据去向**：新建方案；补充已有方案（只填充空缺章节，不改已有内容）；覆盖已有方案（先产出新旧对比数据，用户确认后才覆盖，未确认项保持原样，写入失败保留原内容并说明失败项）。新旧章节按来源文件与章节序号对应；来源哈希变化时只允许新建。覆盖或补充章节大纲后给出“所属卷纲与总纲已过期”的信息和“重新汇总本卷与总纲”的入口数据。
6. 全部模型调用经 t04 模型端口，思考关闭。

## 非目标

- 不做 HTTP 路由、界面、Agent 工具（切片 8 处理接入）。
- 不改变大纲库既有语义；不提取伏笔库条目与线路。
- 不做真实模型调用，不做数据库迁移。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 依赖

t01（每方案一个总纲）、t02（来源提取细纲依据）、t03（提取结构）、t04（任务框架；流水线接口见其“当前状态”）。

## 验证

- 聚焦测试（Mock 模型、临时项目）：10 章 2 卷的来源跑完后每章有来源提取细纲与章节大纲、每卷有卷纲、方案有总纲；引用越界重试一次再失败则该章失败其余继续；失败章使其卷纲暂缓，跳过后按已完成章汇总；取消后继续只做未完成单元；补充只填空缺；覆盖在确认前不写入、拒绝项不变；哈希变化只能新建；总纲／卷纲输入不含原文；所有模型请求思考关闭。
- `server/inspiration`、`server/outline` 既有测试通过；应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 完成后更新 [outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md)“实现合同”，运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-02 实现与验证完成（未提交）。

### 实现内容

代码在 `packages/neuro-book/server/inspiration/extraction/`，只经 t04 的 `ExtractionModelPort` 调用模型；没有 HTTP 路由、界面、数据库迁移，没有改 `runtime.ts` 的既有导出。

| 文件 | 职责 |
|---|---|
| `outline-pipeline.ts` | `createOutlinePipeline(deps)`（`kind: outline`）：`prepare` 建立或定位方案并生成单元；`readyUnits` 表达依赖；`execute` 分派细纲、章节大纲、卷纲、总纲、对比、覆盖单元；`settle`／`acceptInput` 处理覆盖确认；`readOutlineExtractionOutcome(task)` 读出结果 |
| `outline-params.ts` | 任务参数解析（`SOURCE_CHANGED`、结构校验）、单元 ID 与 `state` 键、`OutlineState` |
| `outline-destination.ts` | 提取方案命名 `nextExtractionPlanTitle`、数据去向选项 `listOutlineDestinations`、校验 `assertDestinationAllowed`、结构预建 `prepareOutlinePlan` |
| `outline-planning.ts` | `OutlinePlanningPort`（快照、动作、来源提取细纲、删除条目与方案）；`createReadyOutlinePlanning(ready)` 经 ready Project 宿主入口；方案层级读法 |
| `outline-writer.ts` | 幂等写入、覆盖章节大纲（失败恢复）、覆盖细纲（先建后删）、对比数据 |
| `outline-summary.ts` / `outline-prompts.ts` / `outline-validation.ts` | 卷纲与总纲的汇总请求（流水线与重新汇总共用）、提示词、中文校验 |
| `outline-resummarize.ts` | `resummarizeVolumesAndTotal`：重新汇总本卷与总纲 |
| `outline-register.ts` | `registerOutlineExtractionPipeline()` 幂等注册，`createParagraphLoader` 按来源哈希读取段落 |
| `outline-planning.fixture.ts` | 测试用内存端口（记录写入、可注入失败） |
| `shared/dto/inspiration-outline-extraction.dto.ts` | 参数、数据去向、覆盖确认、对比条目的 zod schema 与类型 |

要点：

- 方案与结构：`prepare` 新建“提取方案N·<作品名>”（N 取该作品已有提取方案最大序号加 1，标题仍冲突则继续递增）并预建空总纲、卷纲、章节；方案 ID 写入 `state.planId`。管理器保证同来源同种类只有一个运行中任务且先复核唯一性才调用 `prepare`，所以重复确认不会产生第二个方案。预建失败会尽力撤销刚建的方案并在错误里说明。
- 单元：每章 `chapter-<i>:detail` 与 `chapter-<i>:outline` 共用 `CHAPTER_SYSTEM_PROMPT`，前缀为本章原文，章节大纲在目标之前追加细纲；`volume-<v>:summary` 的输入只含本卷章节大纲，`total` 的输入只含各卷卷纲，均不含原文。就绪规则按 `readyUnits` 表达；章节失败使其卷纲留在等待，跳过后按已完成章汇总并标注缺失。
- 校验：细纲与章节大纲末行必须是 `【引用】P3-P8、P12`，范围必须有序且落在本章内，正文里的越界 P 编号同样拒绝；各层模板标题必须出现且非空；细纲不得带伏笔小节。错误信息为中文，直接进入 t04 的修复重试。
- 写入：细纲经 `prepareSourceExtractionDetail` 写入（来源依据为 `source-extraction`），其余经大纲领域动作；条目写入后即为正式条目。重复执行幂等：条目已有正文只补上采用，细纲已存在相同正文则复用。
- 补充：只为缺细纲的章节、没有正文的章节大纲、卷纲、总纲生成；已有内容不动。缺失的章节与卷会新建。
- 覆盖：先对所有映射章节提取新内容但只存入任务 `state`，由对比单元生成对比数据后任务进入 `awaiting-input`（原因“等待确认覆盖”），此前不写大纲库。确认后只为被确认且内容有变化的项追加覆盖单元。覆盖章节大纲时写入失败会恢复原正文与状态；覆盖细纲先建新再删旧。失败单元的错误点名章节与项并说明原内容是否保留，任务以部分失败结束，可 `retryUnit`。
- 来源哈希变化：`assertDestinationAllowed` 只允许新建，补充与覆盖在 `prepare` 前以 `INVALID_INPUT` 拒绝，不产生任何写入；`listOutlineDestinations` 同样据此给出可用性与原因。
- 过期提示：补充或覆盖写入章节大纲之后，开始时有正文的所属卷纲与总纲记入 `state` 的过期标志，`readOutlineExtractionOutcome` 返回 `staleNotice` 与 `canResummarize`。

### 供切片 8（路由、界面、Agent 工具）使用的接口

- 启动：路由先调 `registerOutlineExtractionPipeline()`，再 `manager.start({kind: "outline", source, params})`；`params` 为 `OutlineExtractionParamsDto`（`workTitle`、t03 的 `structure`、`corrections`、`destination`）。
- 数据去向选项：`listOutlineDestinations({snapshot, tasks, source})` 返回可补充或覆盖的方案及不可用原因；界面选择后填入 `destination: {kind: "new"} | {kind: "supplement", planId} | {kind: "overwrite", planId}`。
- 对比数据：任务为 `awaiting-input` 时 `readOutlineExtractionOutcome(task).comparison` 是 `OutlineComparisonItem[]`（`chapterIndex`、`chapterTitle`、`kind` 为 detail 或 outline、`oldText`、`newText`、`changed`、`locator`）。确认经 `manager.provideInput(id, {confirmedItems: [{chapterIndex, kind}]})`；不在对比里的项抛 `INVALID_INPUT`，任务保持暂停。
- 结果：`readOutlineExtractionOutcome(task)` 返回 `planId`、`planTitle`、`destination`、`confirmed`、`failedOverwrites`（点名失败项）、`unmappedChapters`、`staleVolumes`、`staleTotal`、`staleNotice`、`canResummarize`。
- 重新汇总本卷与总纲：`resummarizeVolumesAndTotal({task, store, planning, model, signal})` 返回更新的卷序号与总纲；只重做过期的卷纲，总纲总是重做，输入同样只来自库内下级大纲；完成后清除过期标志。任务运行中或等待输入时拒绝，没有过期内容时抛 `INVALID_STATE`。该函数不经管理器，直接写任务记录，路由层需要自行避免与同任务的管理器操作并发。
- 其他：`createReadyOutlinePlanning(ready)` 提供真实端口，首次读取会走 `openReadyPlanning` 完成大纲规划初始化与事务恢复（从未打开过大纲工作台的项目没有 manifest）。

### 对 `server/outline` 的最小补充

只改 `server/outline/host.ts`，均为已有领域能力的 ready Project 入口，没有改领域语义：

- `applyReadySourceExtractionDetail(ready, input, expectedRevision, actor)`：在 mutation gate 内调 t02 的 `prepareSourceExtractionDetail` 并发布，返回 `{transactionId, entryId}`。该入口此前只有领域函数，没有宿主入口。
- `readReadyPlanningSnapshot(ready)`：在 mutation gate 内只读快照，不恢复 journal、不重建索引。`openReadyPlanning` 每次都重建索引，对每个单元都读快照的长任务过重。

### 取舍与已知限制

- 骨架创建每个条目一个领域事务，章节很多时 `prepare` 较慢；每个单元读取完整快照，大库上较重。
- 编辑条目会把它退回草稿，采用是第二步，两步之间的中断会留下有正文的草稿；单元重做时只补上采用。
- 覆盖的候选内容和对比数据存在任务记录里，`task.json` 会随章节数变大。
- 共享总纲（被多个方案挂载）不能在提取里原地修改，对应单元会带着领域错误失败。
- 新旧章节按序号对应，无法发现用户在方案中间删掉了章节；方案章节比结构少时，补充会新建缺的章节，覆盖忽略多出的结构章节（记入 `unmappedChapters`）。
- 覆盖时某章细纲或章节大纲单元失败，对比单元会等待，需要重试或跳过后才能进入确认。
- `latestTaskOfPlan` 以最近创建的任务为准判断来源哈希，同一方案被不同来源文件提取过时以最近一次为准。
- 提取写入的章节大纲 `references` 指向来源文件（`reference/` 下的原作），未验证写作交接会不会把它当作素材加载。

### 验证

- `bun run test server/inspiration server/outline`：39 个测试文件、368 个用例全部通过。本切片新增 4 个文件 24 个用例：`outline-pipeline.test.ts`（13，覆盖验证清单：10 章 2 卷完整运行、引用越界重试与失败章不阻塞其余、失败章暂缓卷纲及跳过后汇总、取消后继续只做未完成单元、补充只填空缺与重新汇总、覆盖确认前不写入与拒绝项不变、覆盖写入失败保留原内容、哈希变化只能新建、卷纲与总纲输入不含原文、所有请求只含 system／prompt／signal／modelKey）、`outline-host.test.ts`（1，经 ready 宿主在临时项目里跑 2 章 1 卷）、`outline-validation.test.ts`（6）、`outline-destination.test.ts`（4）。
- 类型检查：`bun run typecheck`（`nuxt typecheck --logLevel silent`）在本机即使有故意引入的类型错误也返回 0，不能作为判据；实际使用 `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit -p .nuxt/tsconfig.server.json`，本切片文件（`extraction/outline-*`、`inspiration-outline-*`）零错误，其余文件的错误为既有。
- `bun run docs:check`：失败项均为既有文件，未新增与 w00020 本 Task 相关的失败。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
