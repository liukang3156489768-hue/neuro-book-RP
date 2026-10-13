---
schema: nbook.spec/v1
kind: behavior
status: planned
capability: inspiration.outline-extraction
owners:
  - neuro-book
  - outline-planning
---

# 作品大纲提取

## 目标与非目标

用户选择一部作品（项目 `reference/` 内的来源文件），程序把它提取为大纲库中的一个提取方案：自下而上生成每章的细纲和章节大纲、每卷的卷纲和整部作品的总纲，供改编时被大纲模块编辑、被写作模块选用。

不承诺：原创设计接入大纲库（原创规划由大纲模块自身负责）；提取伏笔库条目与线路；由 Agent 编排提取过程；改变写作模块“按所选方案写作”的行为；工作台界面整理。

## 术语与参与者

- **来源**：用户选择的作品文件，只读。沿用现有 P 段落编号（P1 起连续）与内容哈希。
- **章节识别结果**：程序对来源识别出的章节列表，每章含标题、P 段落范围和字数。
- **卷**：用户划分的章节分组。按章节模式按章节范围划卷；按字数模式按每 N 个切分块为一卷，一个切分块视为一章。按字数模式的块与素材提取共用边界：完整章节不可拆分，超长章节独立成块，无章节时按完整段落分组。
- **提取方案**：本能力创建的大纲库方案，命名为“提取方案N·<作品名>”，N 在同一作品的提取方案中依次递增。
- **提取任务**：后台运行的一次提取，按章记录状态。
- **用户**：划卷、修正章节、选择数据去向、确认覆盖的人。**Agent**：只能向流水线下发任务或确认成果，不参与提取内容的生成编排。

## 输入与前置条件

- 项目已打开，且已配置可用的提取模型；来源为 `reference/` 内的 UTF-8 `.txt` / `.md` 文件，沿用 5 MiB 上限与路径保护。
- 选择来源后程序立即识别章节并展示章节列表。识别规则在现有“第X章/回/节”“Chapter N”“序章/楔子/尾声/番外”基础上增加“单独一行仅有数字”的标题形式；该形式只在上下文支持时判定为标题（例如与前后章标题编号连续或呈递增序列），孤立数字行不判定为标题。“第X卷”识别为卷标题，作为默认划卷建议，不再被当作章节。
- 用户可修正识别结果：把某行设为或取消章节标题、合并相邻章节、拆分章节。修正只作用于本次提取任务，不改动来源。
- 开始提取前，用户必须确认划卷结果。章节模式的卷必须由连续章节组成且不重叠、不遗漏；字数模式要求 N 为正整数。
- 来源内容哈希变化后，旧任务的章节划分视为失效。

## 输出与可观察行为

### 创建与结构预建

确认划卷后，程序在大纲库新建提取方案：先建立空的总纲、各卷卷纲和各章章节大纲结构，然后开始填充。结构建立后即可在大纲库看到，章节条目最初为空。

### 提取流程

提取是纯程序流水线，按固定顺序自下而上进行：

1. 逐章提取细纲：输入为本章原文。
2. 逐章提取章节大纲：输入为本章原文与该章已提取的细纲。
3. 逐卷汇总卷纲：输入只含本卷全部章节大纲，不读原文。
4. 汇总总纲：输入只含全部卷纲。

细纲与章节大纲是两条独立工作流，共用同一份系统提示；提示词前缀统一为本章原文，细纲等追加材料放在原文之后，任务目标放在末尾，以便前缀缓存命中。每章先于卷汇总完成；一卷的章节全部完成后才汇总该卷卷纲；全部卷纲完成后才汇总总纲。

### 写入结果

- 流水线写入的条目直接是正式条目，经大纲领域操作与工作区历史写入，不绕过它们。
- 每章的细纲采用依据为“来源提取”（见 [outline.planning-library](../outline/planning-library.md)）。
- 章节大纲与细纲的 `references.locator` 记录所依据的原文 P 段落范围，保证可追溯；引用必须落在本章范围内。
- 卷纲与总纲不带细纲，其依据是下级条目。

### 进度与失败呈现

模型选择旁提供当前来源的大纲任务列表、新建和删除按钮，与素材任务位于同一位置。列表按创建时间显示状态；切换任务只展示所选任务的进度、覆盖对比和结果方案。新建进入全新的设置，默认新建方案，不复用旧任务的状态或待确认结果。历史任务仍可重新选择；同来源同一时刻一个运行中大纲任务的约束保持。

删除任务需要用户确认。运行任务先停止并等待收尾，随后删除该任务记录及临时产物；已经通过大纲领域操作写入的方案和条目保留，删除任务不会删除大纲成果。删除失败保留界面状态并说明原因。切换、新建或来源变化后，旧请求的迟到结果不能覆盖当前任务的结果。

任务在后台自动运行，不要求用户在场。界面或查询接口展示整体进度、每卷进度和逐章状态（等待、运行中、完成、失败）。单章失败时只标记该章，流水线继续处理其他章；失败章可单独重试，重试只重做该章（细纲、章节大纲视失败位置而定），不丢弃已完成成果。某卷有失败章时，该卷卷纲汇总暂缓，待失败章处理后继续；失败章被用户明确跳过时，卷纲按已完成章节汇总并标注缺失章节。

“逐项状态”栏提供“一键重试（数量）”与“一键跳过（数量）”，与素材提取共用控件和任务操作。一次提交点击时所有失败单元的 ID，不受列表筛选影响；服务端整批核对当前状态后更新，暂停任务至多重启一次。已完成、已跳过和正在运行的单元保持不变，点击后新增且未被选中的失败不在处理范围。重复 ID 去重，未知 ID 整批拒绝并提示刷新。运行中、待确认和部分失败时可用；没有失败或请求进行中时禁用，已取消／中断时先继续任务。批量跳过后汇总按已完成内容继续，已保存的大纲成果保留；切换任务或来源后的迟到响应不能覆盖新页面。

### 重复提取与数据去向

同一来源再次提取时，用户选择数据去向：

- **新建方案**：新建“提取方案N·<作品名>”，不影响已有方案。
- **补充已有方案**：只填充空缺或缺失的章节，不修改已有内容。
- **覆盖已有方案**：逐项展示新旧内容对比，经用户确认后覆盖；未被确认的项保持原样。

新旧章节按来源文件与章节序号对应。来源内容哈希变化时章节划分可能已变，只允许新建方案。覆盖或补充章节大纲后，确认界面提示所属卷纲和总纲已过期，并提供“重新汇总本卷与总纲”；细纲与章节大纲在同一批次中重提取时，细纲不退回草稿。

## 状态与转换

任务状态：待确认划卷 → 运行中 → 完成 / 部分失败 / 已取消 / 已中断。

| 事件 | 结果 | 约束与幂等 |
|---|---|---|
| 确认划卷 | 新建提取方案与空结构，任务进入运行中 | 同一来源同一时刻只有一个运行中任务；重复确认不创建第二个方案 |
| 一章细纲完成 | 该章细纲写入并进入章节大纲阶段 | 已完成的单元重复执行不产生重复条目 |
| 一章章节大纲完成 | 该章标记完成 | 依赖该章已有细纲 |
| 一卷全部章完成 | 汇总该卷卷纲 | 有失败章则暂缓 |
| 全部卷纲完成 | 汇总总纲 | |
| 单元失败 | 标记失败，其余继续 | 同一单元重试次数见“失败与恢复” |
| 取消 | 停止调度新的模型调用，已写入成果保留 | 取消后可从未完成单元继续 |
| 项目关闭或进程中断 | 任务标记为已中断，已写入成果保留 | 重新打开后用户可继续或放弃 |
| 来源哈希变化 | 旧任务不可继续，只可新建 | 不自动改写已有方案 |

## 副作用与数据

- 任务状态（来源路径与哈希、章节识别与修正结果、划卷、逐单元状态、目标方案 id、错误摘要）持久化在项目内部状态目录，项目关闭后可恢复。
- 大纲库写入通过领域操作进行，进入工作区历史，可审计、可撤销。
- 流水线内每次模型调用（细纲、章节大纲、卷纲汇总、总纲汇总、修复重试）的思考能力固定关闭，由流水线设置，不受工作台思考开关影响；输出质量由格式校验与修复重试保证。
- 来源保持只读；提取不修改 `reference/`。

## 失败与恢复

- 每次模型产出先经程序校验：模板字段完整、引用的 P 编号有效且位于本章范围内。不通过时把本次产出和错误信息追加到提示词末尾的预留位置，再次调用；同一单元连续失败两次则标记失败并上报，不再自动重试，由用户或 Agent 单独重试。
- 模型超时、配置缺失、配额不足、项目关闭都不使任务静默成功；中断时已写入成果保留，未完成单元保持未完成。
- 覆盖操作在用户确认前不写入；确认后的写入失败保留原内容，并说明失败项。
- 来源被移动、删除或哈希变化时任务拒绝继续，不用模型猜测缺失原文。

## 边界与兼容

- 本能力不拥有大纲库语义，所有大纲写入遵守 [outline.planning-library](../outline/planning-library.md)，依赖其“每方案一个总纲”和“来源提取”细纲依据；这两项改动是本能力的前置。
- 取代 [inspiration.workbench](../ui/inspiration-workbench.md) 首版中“用户要求大纲或细纲时提取为 `note` 类资料”的行为；素材提取见 [inspiration.material-extraction](material-extraction.md)，两类任务状态、入口与进度分开。
- 提取方案对大纲模块和写作模块是普通方案，不设额外权限，不改变写作模块的选方案行为。
- 真实模型调用、数据库迁移和发布需另行授权，本 Spec 不构成授权。
- **实施范围**：实现本能力时只做本 Spec 及其 Task 规定的内容。实施中发现的其他模块问题不顺手修复，完成后集中报告；仅当该问题阻碍本能力开发时才处理，并在报告中单独说明。

## 验收与 Smoke

- Given 含 10 章、2 个“第X卷”标题的来源，When 选择该来源，Then 立即展示 10 章列表（标题、P 范围、字数），并把卷标题作为默认划卷建议。
- Given 来源章节标题为单独一行数字 `1`…`10` 且递增，Then 识别为 10 章；Given 正文中孤立的数字行，Then 不判定为标题。
- Given 用户把某行修正为章节标题，Then 章节列表更新，来源文件不变。
- Given 无可识别章节、设置每卷 3 个切分块，Then 每块对应一章、每 3 块成一卷。
- Given 划卷确认，Then 大纲库出现提取方案与空的总纲、卷纲、章节大纲结构，方案名为“提取方案1·<作品名>”。
- Given 运行完成，Then 每章有来源提取细纲和章节大纲，每卷有卷纲，方案有总纲；细纲与章节大纲引用均落在本章 P 范围内。
- Given 某章模型输出引用越界，Then 带错误信息重试一次；再失败则该章标记失败，其余章继续，已完成章成果保留。
- Given 任务运行中关闭项目再打开，Then 任务显示为已中断，已完成章保留，可从未完成章继续。
- Given 对同一来源再次提取并选择“覆盖”，Then 展示逐项新旧对比，未确认项不变；确认后提示卷纲与总纲已过期并提供重新汇总。
- Given 来源已被修改（哈希变化），Then 只能新建方案。
- Given 提取方案，When 写作模块选用它，Then 章节目录来自该方案，细纲可写。
- Given 任意提取模型调用，Then 请求的思考能力为关闭，不随工作台思考开关变化。

## 实现合同

以下是已落地部分的事实描述（章节识别、修正、划卷与提取结构；共用后台任务框架；大纲提取流水线；HTTP 路由与 Agent 工具；“作品提取”界面）。

- **模块**：`packages/neuro-book/server/inspiration/outline-structure.ts`（纯函数，无 IO），DTO 与 zod schema 在 `packages/neuro-book/shared/dto/inspiration-outline-structure.dto.ts`。输入是 `splitInspirationSource` 产出的段落（`id` 为 P1 起、空行附着前一段，`text` 为原文）；`source-split.ts` 对外行为不变，仅抽出并导出 `groupSourceUnits`（按目标字数分块）、`headingLineText`、`chapterTitle`、`countCharacters` 供复用。
- **识别规则**：沿用既有章节正则（第X章/回/节/部、Chapter/Book/Part N、序章/楔子/尾声/番外等，行首 Markdown `#` 标记忽略）；`第X卷` 识别为卷标题，进入 `volumeHeadings`，不计章节。单独一行仅含 1 至 6 位阿拉伯数字（含全角数字、可带 `#`）的行，仅当它与文档顺序上相邻的数字行构成步长为 1 的递增序列且该连续段不少于 2 个时才判为章节标题；孤立数字行、非步长 1 的序列不是标题，已被其他规则识别的行不参与。
- **章节范围**：章节 P 范围首尾相接并覆盖全文。第一个章节标题之前的正文成为“章前文字”章（`headingParagraphId` 为 null）；紧邻章节标题上方的卷标题行归入该章范围起点，使上一章不含下一卷的卷标题。没有任何章节标题时章节列表为空（字数模式）。
- **修正语义**（`applyChapterCorrections`，按顺序重放，不改动输入与来源）：`set-heading` 把 P 设为章节标题（缺省取该行文本，已是标题时改名；卷标题行不可）；`unset-heading` 取消章节标题，正文并入前一章，取消首章标题后成为“章前文字”，全部取消后回到无章节；`merge` 合并 `chapterIndex` 与其后一章（序号指此前修正后的列表），保留前一章标题；`split` 在章内非首行的 P 处拆开，该 P 成为新章标题。不存在的 P、越界章号、已是标题、会产生空章节等返回带稳定 `code` 的 `OutlineStructureError`。
- **划卷**（`divideVolumes`）：默认建议 `suggestVolumeRanges` 由卷标题给出（卷从其后首个章节开始；首个卷标题之前的章节为无标题前置卷；无卷标题则整部作品一卷）。章节模式要求卷按序给出、从第 1 章起首尾相接，错误码 `VOLUME_OVERLAP`、`VOLUME_GAP`、`VOLUME_OUT_OF_RANGE`、`VOLUME_EMPTY`、`VOLUME_NO_VOLUMES`、`VOLUME_NO_CHAPTERS`。划卷方式与来源模式不一致报 `VOLUME_MODE_MISMATCH`。
- **字数模式**（`planChunkChapters`）：按请求目标字数（默认 50 000 字）分块；有章节时以完整章节为不可拆单位，超长章节独立成块；无章节时按 `groupSourceUnits` 以完整段落为单位分块。每块为一章（标题“第N块”），`chunksPerVolume` 必须为正整数（`VOLUME_CHUNKS_PER_VOLUME_INVALID`），每 N 块一卷，最后一卷可较短。
- **提取结构**（`buildExtractionStructure`）：`{sourceSha256, mode: "chapters" | "chunks", chapters[{index,title,firstParagraphId,lastParagraphId,characterCount}], volumes[{index,title|null,firstChapterIndex,lastChapterIndex}]}`，确定性、可序列化，不含修正列表；修正列表与来源哈希由提取任务另行持久化。

### 共用后台任务框架

模块 `packages/neuro-book/server/inspiration/extraction/`，DTO 在 `packages/neuro-book/shared/dto/inspiration-extraction-task.dto.ts`。框架只负责调度、持久化、校验重试与进度，不含任何提取内容逻辑；两种提取各自实现 `ExtractionPipeline`（`prepare`／`readyUnits`／`execute`／`settle`／`acceptInput`）。素材提取的接入点见 [material-extraction.md](material-extraction.md#共用任务框架)。

- **任务记录**：`.nbook/inspiration/extractions/<任务 UUID>/task.json`，字段为 `version`、`id`、`kind`（outline／material）、`source{path,sha256}`、`modelKey`、`params`、`state`（流水线私有，JSON）、`status`、`awaitingInput`、`stopReason`、`units`、时间戳。写入经项目 mutation gate，使用 `writeWorkspaceTextFile`（不进工作区历史，与 Inspiration 对话更新一致）。素材中间产物放同一任务目录，由素材流水线自己写。
- **单元**：`{id, step, label, group|null, status, attempts, error|null, data}`，状态为等待／运行中／完成／失败／已跳过。`group` 用于按卷（大纲）或按块（素材）汇总进度。流水线可在运行中追加单元（`settle` 返回 `continue` 或单元返回 `appendUnits`），ID 不得重复。
- **任务状态**：运行中、等待输入（`awaiting-input`）、完成、部分失败（有失败单元且无可调度单元）、已取消、已中断。`stopReason.code` 为 `source-changed`、`model-unavailable`、`unexpected`；项目关闭得到已中断且无原因。
- **调度**：串行，按 `readyUnits` 顺序执行第一个就绪的等待单元，每次状态变化都落盘。依赖关系只在 `readyUnits` 表达（大纲：卷汇总等本卷章节完成或已跳过，总纲等全部卷汇总）；章节失败使其卷汇总留在等待，任务以部分失败结束，`skipUnit` 明确跳过后卷汇总按已完成部分继续。没有失败却仍有未完成单元视为流水线缺陷，任务中断为 `unexpected`，不静默完成。
- **控制**：`start`／`cancel`／`resume`／`provideInput`／`retryUnit`／`skipUnit`／`get`／`list`／`progress`。取消停止调度并中止进行中的调用，已完成成果保留，进行中的单元回到等待；`resume` 只允许已取消、已中断、部分失败的任务并只跑未完成单元；`retryUnit` 只重置该单元并清零重试计数；失败单元不会在 `resume` 中自动重做。同一来源路径同一种类同一时刻只有一个运行中任务，重复启动返回 `CONFLICT` 且不调用 `prepare`（避免第二份提取方案）。
- **生命周期**：运行通过 `startReadyProjectOperation` 绑定项目生命周期信号与取消，不绑定 HTTP 请求；管理器以 ready generation 为键，重新打开项目得到新管理器。持久化为运行中却无活动执行者的任务，在读取时呈现为已中断（运行中单元回到等待），读取不写回。
- **来源复核**：启动、继续与每次模型调用前以磁盘内容重新计算哈希（`prepareInspirationSource`）；变化或不可读则启动／继续被拒绝（`SOURCE_CHANGED`），运行中则任务中断并记录 `source-changed`。
- **模型调用**：流水线通过 `ExtractionModelPort.complete({system?, prompt, signal, modelKey?})`，请求类型没有思考开关。真实适配器使用 `inspiration` Profile 的模型（`modelKey` 可覆盖）、无工具、`reasoning: undefined`（排在 Provider 请求选项之后）、超时取 Provider 配置与 10 分钟中较大者、输出上限取模型上限与 64000 中较小者；未配置模型为任务级错误 `model-unavailable`，被截断的产出作为该单元失败。
- **提示词与校验重试**：`buildExtractionPrompt` 的结构为前缀（`renderSourcePrefix` 渲染的本单元原文，位于最开头且无包装）、追加材料、任务目标、预留位（平时为空且不留分隔符，所以首次请求是修复请求的严格前缀）。`callWithRepair` 对未通过校验的产出，把上次产出与校验错误写入预留位重写一次；连续两次失败抛 `ExtractionValidationFailure`，单元标记失败并保存错误摘要。模型端口自身错误（超时等）不触发修复，只使该单元失败。
- **进度**：`summarizeExtractionProgress` 为纯函数，返回整体、按 `group`（首次出现顺序）和逐单元计数与状态，不含 `state` 与 `data`。

### 大纲提取流水线

模块在 `packages/neuro-book/server/inspiration/extraction/outline-*.ts`，参数与覆盖确认的 DTO 在 `packages/neuro-book/shared/dto/inspiration-outline-extraction.dto.ts`。流水线 `kind` 为 `outline`，只经共用框架的模型端口调用模型，请求类型没有思考开关；HTTP 路由见本节末“路由”，界面见“界面”。

- **启动与方案**：参数为 `{workTitle, structure, corrections, destination}`，`destination` 为新建、补充（目标方案）或覆盖（目标方案）。`prepare` 新建“提取方案N·<作品名>”（N 取该作品已有提取方案最大序号加 1，标题冲突继续递增）并预建空总纲、卷纲、章节，方案 ID 写入任务 `state.planId`；管理器在唯一性复核通过后才调用 `prepare`，重复确认不创建第二个方案。补充与覆盖按序号对应已有方案的章节，目标方案必须有同来源路径的提取任务记录。
- **单元与依赖**：每章 `chapter-<i>:detail`、`chapter-<i>:outline` 共用同一份系统提示，前缀为本章原文，章节大纲在目标前追加该章细纲；`volume-<v>:summary` 只含本卷章节大纲，`total` 只含各卷卷纲，二者输入不含原文。章节大纲等本章细纲，卷纲等本卷全部单元，总纲等全部卷纲；失败单元使依赖者留在等待，明确跳过后按已完成部分汇总并标明缺失项。
- **校验**：细纲与章节大纲产出末行为 `【引用】P3-P8、P12`，范围须有序且落在本章内，正文中的越界 P 编号同样拒绝；章节大纲、卷纲、总纲的必需一级标题须存在且非空；细纲须通过细纲结构校验且不含伏笔小节。错误信息为中文，直接进入共用框架的修复重试。
- **写入**：细纲经来源提取细纲入口写入（带来源依据），其余经大纲领域动作写入并采用为正式条目，写入记入工作区历史；单元重复执行不产生重复条目。
- **补充**：只为缺失的细纲、没有正文的章节大纲、卷纲与总纲生成内容，已有内容不改动。
- **覆盖**：新内容先存入任务 `state`，对比单元生成逐章对比数据（旧文本、新文本、是否变化、引用定位、旧条目版本与哈希）后任务进入 `awaiting-input`，此前不写大纲库。确认 `{confirmedItems: [{chapterIndex, kind}]}` 后只为被确认且有变化的项追加覆盖单元；未确认项保持原样。写入失败恢复原正文与状态，单元错误点名章节与项，任务以部分失败结束并可重试。
- **来源哈希变化**：只允许新建方案，补充与覆盖在写入前以 `INVALID_INPUT` 拒绝。
- **过期提示**：补充或覆盖写入章节大纲后，开始时已有正文的所属卷纲与总纲被标为过期；`readOutlineExtractionOutcome` 返回过期卷序号、总纲标志、提示文案与 `canResummarize`。`resummarizeVolumesAndTotal` 只重做过期的卷纲并总是重做总纲，输入同样只来自库内下级大纲，完成后清除标志。
- **写作交接**：提取方案按 [outline.writer-handoff](../outline/writer-handoff.md) 的规则交接，无需额外适配。来源提取细纲与已审阅细纲资格等价，章节大纲采用后该章即可写。提取写入的章节大纲 `references` 指向 `reference/` 下的原作（`purpose` 为提取标记）：交接上下文只带路径与定位，不带原文；素材读取接口只在调用方显式给出 1 至 8 个路径、且每个文件不超过 64 KiB 时才读取，整本原作超限会被拒绝而不是截断，也不会自动加载。写作助手工具 `read_writing_material` 的可读范围包含本章交接列出的参考路径，该工具读取没有体积上限，助手主动调用时会整本返回带段号的原作文本；这是写作模块的既有行为，本能力不改变，已记入 Work 的待报告问题。
- **宿主入口**：`createReadyOutlinePlanning(ready)` 经 ready Project 宿主入口读写大纲库，首次读取完成大纲规划初始化与事务恢复；为此在 `server/outline/host.ts` 补充 `applyReadySourceExtractionDetail`（来源提取细纲的宿主入口）与 `readReadyPlanningSnapshot`（不重建索引的只读快照）。`registerOutlineExtractionPipeline()` 幂等注册，来源段落按任务来源哈希读取，哈希不符按 `source-changed` 中断。
- **路由**：位于 `packages/neuro-book/server/api/inspiration/extraction/`，请求与响应 schema 在 `shared/dto/inspiration-extraction-api.dto.ts`；GET 的 `projectRoot` 走查询串，POST 走请求体，请求体 strict，`taskId` 须为 UUID。服务经 `server/inspiration/extraction/host.ts` 的 `useProjectExtractionServices` 取得，取得时幂等注册两条流水线；任务运行绑定项目生命周期而非请求。
  - `POST /structure`：路径、显式切分方式（`chapters` 或 `chunks`）、修正与可选的字数目标，返回章节识别结果、章节（字数模式为块）与默认划卷建议，服务端不保存修正。`POST /structure-confirm`：同上再加划卷，返回提取结构；划卷违规 422。
  - `GET /outline/destinations`：某来源可选的数据去向（新建、补充、覆盖及不可用原因），来源哈希取自磁盘。
  - `GET /tasks`（可按 `kind`、`path` 过滤）、`POST /tasks`（202，大纲任务带来源、作品名、提取结构、修正、数据去向）、`GET /tasks/{id}`（任务与进度）、`POST /tasks/{id}/cancel`、`/resume`、`/retry-unit`、`/skip-unit`、`/input`。大纲任务的 `/input` 只接受 `{confirmedItems}`（覆盖确认），错种类的输入 422。
  - `POST /tasks/{id}/failed-units`：请求 `{projectRoot, action: "retry" | "skip", unitIds}`，ID 列表非空且至多 10,000 个。两类任务共用；重复 ID 去重，只更新当前仍失败的选中项，返回 `{task}`。不存在的 ID 整批 404，非法动作或空列表 400；已取消／中断且有选中失败项时 409。
  - `GET /tasks/{id}/outline`：`readOutlineExtractionOutcome`（方案、数据去向、覆盖对比、已确认项、过期卷与总纲）。`POST /tasks/{id}/outline/resummarize`：重新汇总过期的卷纲与总纲。
  - 取消、继续、单元重试、跳过、提供输入与重新汇总按任务 ID 进入同一串行队列，重新汇总不会与同一任务的管理器操作并发；排在长时间重新汇总之后的取消会等待它结束，重新汇总只在项目关闭时被中止。
  - 同一来源仅运行中的任务占用唯一性键，等待输入的任务不占用。领域错误映射到 `data.code`：`NOT_FOUND` 404，`CONFLICT`、`INVALID_STATE`、`SOURCE_CHANGED` 409，`INVALID_INPUT` 422，`PIPELINE_UNREGISTERED`、`MODEL_UNAVAILABLE` 503。
- **Agent 工具**：`start_inspiration_extraction` 下发大纲提取时不修正章节、按建议划卷、数据去向固定为新建方案（字数模式每卷块数固定为 5），因此不会覆盖已有内容；需要修正章节或覆盖、补充时由用户在界面里启动。查询进度与读取失败报告见素材提取 Spec 的“路由与 Agent 工具”。
  - **界面**：Inspiration 设计工作台顶部有“原创设计 / 作品提取”两个页签，“作品提取”页在首次切入时才挂载，之后切换保留状态。组件位于 `packages/neuro-book/app/components/novel-ide/inspiration/extraction/`，宿主为 `InspirationExtractionPanel`，服务调用与状态集中在 `app/composables/useInspirationExtraction.ts`（任务跟踪器 `useExtractionTaskTracker.ts`，请求入口 `app/utils/inspiration/extraction-api.ts`）。
  - 流程：选来源 → 选择按章节或按字数分块并查看块号、P 范围和字数预览 → 章节修正（仅章节模式）→ 划卷（章节模式按范围，字数模式按每卷块数；草稿改动后延迟向 `/structure-confirm` 校验，服务端错误原样显示，启动前再校验一次）→ 数据去向 → 作品名与开始。大纲始终覆盖整部作品，不支持排除块。
  - 进度每个任务只在状态为“提取中”时按固定间隔轮询，等待输入、完成、取消、中断或离开界面都会停止；显示整体、每卷与逐章状态，失败章可重试或跳过，支持取消与继续，已中断任务有提示。启动时自动恢复该来源最近的大纲任务。
  - 数据去向的补充与覆盖在服务端判定不可用时禁用并显示原因；覆盖时任务等待确认，逐项显示新旧对照，默认只勾选有变化的项，确认后只读。完成后给出“打开提取方案”（关闭本窗口并打开大纲工作台，暂不能按方案预选）与“重新汇总本卷与总纲”（有过期卷或总纲时可用）。
  - 界面请求不携带确认者或任何身份字段；大纲提取与素材提取各有独立的任务、进度与错误，互不阻塞。

## 证据

- [Proposal：Inspiration 作品大纲提取与大纲库接轨](../../proposals/inspiration-outline-extraction.md)
- 实现与验证记录：[Work w00020](../../../.agents/works/w00020-inspiration-extraction-pipeline/README.md)。服务端、路由、Agent 工具与界面均已实现；Mock 模型端到端冒烟见 `packages/neuro-book/server/inspiration/extraction/smoke.integration.test.ts`（真实来源与大纲库、重复提取三种去向、取消／继续／失败章重试、与素材任务并行、每次模型调用 `reasoning: undefined`）。真实模型验收与人工界面走查尚未进行，因此本 Spec 保持 `planned`。
