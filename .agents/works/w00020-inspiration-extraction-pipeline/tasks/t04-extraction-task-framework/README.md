---
schema: nbook.task/v2
taskId: t04-extraction-task-framework
---

# 后台提取任务框架

## 目标与范围

为 [outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md) 与 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md) 提供共用的后台任务框架。本 Task 只交付与具体提取内容无关的机制（含单元测试用的 Mock 流水线），不实现任何大纲或素材的提取逻辑、不含 UI。

要交付：

1. **任务与单元模型**：任务记录（种类 outline／material、来源路径与哈希、参数、状态、逐单元状态与错误摘要、时间戳）；单元状态“等待／运行中／完成／失败”（可扩展跳过）；流水线可在运行中追加单元（素材整合单元要等分块完成后才知道）。
2. **持久化与恢复**：任务状态保存在项目内部状态目录 `.nbook/inspiration/extractions/<任务 ID>/`（任务 JSON，素材中间产物后续也放此目录），经项目 mutation gate；项目关闭或进程重启后读到的“运行中”但无活动执行者的任务呈现为“已中断”，已完成成果保留。
3. **调度与控制**：按流水线给出的就绪单元顺序串行执行；取消（停止调度新模型调用，已写入成果保留）、继续（从未完成单元）、单元重试（只重做该单元）；同一来源同一种类同一时刻只有一个运行中任务（重复启动返回冲突，不创建第二个）；运行由项目生命周期信号与取消共同终止，不绑定 HTTP 请求（用 `startReadyProjectOperation` 一类长生命周期入口，需核实）。来源哈希在启动、继续与每次模型调用前复核，变化则拒绝继续。
4. **模型调用端口**：流水线通过窄接口调用模型（无工具、一次性文本补全）。端口类型本身不暴露思考开关，真实适配器固定关闭思考（沿用 `outline/direction-model.ts` 的做法：`reasoning: undefined`，但支持指定 modelKey、较长超时与较大输出上限）；测试用 Mock 实现。
5. **提示词结构与校验重试**：提示词由三段加一个预留位组成——前缀（本单元原文）、追加材料、任务目标，预留位在末尾（平时为空）。每次产出先经流水线提供的校验；不通过时把本次产出与错误信息写入预留位再调用一次；同一单元连续两次失败则标记失败并记录错误摘要，不再自动重试（手动重试重新计数）。同一单元不同类别共享相同前缀以利缓存命中，由提示词构造函数保证前缀字节一致。
6. **进度查询**：返回整体、按分组（卷）、逐单元状态汇总的纯函数；供后续 API 与 UI 使用。

## 非目标

- 不实现大纲／素材流水线内容、HTTP 路由、界面（切片 5、7、8）。
- 不改变现有 Inspiration 的 generate／refine／extract 流程与其既有问题（只记录）。
- 不做真实模型调用，不做数据库迁移。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 现状与改动落点（从代码推断）

- 现有 Inspiration 运行入口与存储：`packages/neuro-book/server/inspiration/runtime.ts`、`storage.ts`（对话经 `writeWorkspaceTextFile` 与 `withProjectTargetMutation` 写 `.nbook/inspiration/`）；
- 一次性模型调用参考：`server/outline/direction-model.ts` 的 `completeDirectionWithModel`；
- 项目长生命周期操作：`server/workspace-files/project-session.ts` 的 `startReadyProjectOperation`；
- 建议新增目录 `server/inspiration/extraction/`；具体以实施时代码为准。

## 验证

- 聚焦测试（Mock 模型与内存／临时目录存储）：校验失败后带错误信息重试、两次失败标记失败且其余单元继续；取消后继续只跑未完成单元；单元重试不影响已完成单元；重复启动冲突；来源哈希变化拒绝继续；进程“重启”（新建运行时读同一存储）后运行中任务呈现已中断；提示词前缀字节一致且预留位在末尾；真实适配器请求中思考关闭（可对底层补全函数做模拟断言）。
- `server/inspiration` 既有测试通过；应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 完成后在两个提取 Spec 增补“实现合同”事实（共用机制写在其中一处并互相链接），运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-02 实现与验证完成（未提交）。

### 实现记录

新增 `packages/neuro-book/server/inspiration/extraction/` 与 `shared/dto/inspiration-extraction-task.dto.ts`（独立 DTO 文件，未改 t06 的 `inspiration*.dto.ts`）；未改 `server/outline`、`direction-model.ts`、Profile、数据库。共用机制事实写在 [outline-extraction.md 的“实现合同”](../../../../../docs/specs/inspiration/outline-extraction.md#实现合同)，素材侧在 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md#共用任务框架) 链接。

| 文件 | 内容 |
|---|---|
| `types.ts` | `ExtractionPipeline`、`ExtractionModelPort`、`ExtractionTaskStore`、提示词与补丁类型 |
| `errors.ts` | `ExtractionTaskError`（稳定 `code`）、`ExtractionFatalError`（任务级）、`ExtractionValidationFailure` |
| `prompt.ts` / `repair.ts` | `buildExtractionPrompt`、`renderSourcePrefix`、`callWithRepair` |
| `task-model.ts` / `progress.ts` | 单元创建、补丁应用、重试／跳过、读时归一化；`summarizeExtractionProgress` |
| `store-file.ts` / `store-memory.ts` | `.nbook/inspiration/extractions/<id>/task.json` 与内存实现 |
| `model-adapter.ts` / `source-guard.ts` | 真实模型适配器、来源哈希复核 |
| `run.ts` / `manager.ts` | 单个任务的活动执行者、任务控制面 `ExtractionTaskManager` |
| `runtime.ts` | 流水线注册表与按 ready generation 组合的管理器（`startReadyProjectOperation`） |
| `testing.ts` | 脚本化 Mock 模型、测试宿主、分层（大纲形）与归类（素材形）演示流水线 |

验证（2026-10-02）：`bun run test server/inspiration` 13 个文件 126 个用例通过（本 Task 新增 7 个测试文件）；`NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` 通过；`docs:check` 结果见 Work 报告。全部使用 Mock 模型与内存／临时目录存储，未做真实模型调用。

### 已知限制

- `task.json` 非原子写入：进程在写入途中崩溃可能留下损坏记录，`list` 会跳过它，单独 `read` 会抛出具体错误。
- 项目关闭瞬间 mutation gate 拒绝写入时，磁盘上保留的最后一条“运行中”由读取方推导为“已中断”；读取不写回存储，继续任务时才落盘。
- “有无活动执行者”按 ready generation 判断（管理器以 ready 引用为键）。多进程同时打开同一项目不在本框架范围。
- 单元取消或项目关闭时进行中的单元回到“等待”，因此流水线的 `execute` 必须能整体重做；单元成果只有 `execute` 返回后才计入。
- 未提供 HTTP 路由、事件推送与界面；`useProjectExtractionManager` 是服务端调用入口。

### 流水线接口与用法（切片 5、7 依赖）

流水线实现 `ExtractionPipeline`（`types.ts`），所有任务状态存在 `ExtractionTask` 里，实例不持有：

```ts
interface ExtractionPipeline {
    prepare(input: {params; source}): Promise<{units: NewExtractionUnit[]; state?}>; // 创建前一次；创建大纲方案等副作用放这里
    readyUnits(task): ExtractionUnit[];            // 当前可执行的 pending 单元，按序；依赖关系在这里表达
    execute(unit, ctx): Promise<{appendUnits?; state?} | void>; // 必须幂等；ctx.generate 调用模型
    settle(task): {kind: "finished"} | {kind: "awaiting-input"; reason} | {kind: "continue"; patch};
    acceptInput?(task, input): {appendUnits?; state?}; // 非法输入抛 ExtractionTaskError("INVALID_INPUT")
}
```

- **大纲形**（`testing.ts` 的 `createLayeredPipeline` 是范例）：`prepare` 返回章节单元（`group` 为卷）、每卷一个汇总单元、一个总纲单元；`readyUnits` 让卷汇总在“本卷所有章节为完成或已跳过”后才就绪，总纲等所有卷汇总完成。章节失败时卷汇总留在等待，任务以部分失败结束；用 `manager.skipUnit` 明确跳过失败章节后卷汇总按已完成部分继续；`manager.retryUnit` 只重做该章节并清零计数。
- **素材形**（`createClassifyingPipeline`）：`prepare` 返回块 × 类别单元；`settle` 在全部完成且 `state.classified` 未置位时返回 `awaiting-input`，任务停为 `awaiting-input`；`manager.provideInput(taskId, input)` 经 `acceptInput` 校验后继续；之后 `settle` 返回 `continue` 并追加整合单元（`appendUnits` 的 ID 不得重复）。
- 单元内调用模型：`ctx.generate({system?, prompt: {prefix, supplements?, goal}, validate})`，`validate` 返回 `{ok: true, value}` 或 `{ok: false, error}`；失败时错误文本原样进入预留位重写一次，连续两次失败抛 `ExtractionValidationFailure`，单元标记失败。同一单元不同类别传入逐字节相同的 `prefix`（用 `renderSourcePrefix`）。单元内可多次 `generate`，每次独立最多两次尝试，`attempts` 为累计模型调用数。
- 单元结果通过返回值的 `state`（浅合并）保存；`execute` 返回即视为完成，抛错则失败（取消／项目关闭／`ExtractionFatalError` 例外，单元回到等待）。写大纲库等外部副作用必须在 `execute` 内自行保证幂等。

注册与使用（生产）：

```ts
registerExtractionPipeline("outline", ({target, ready}) => createOutlinePipeline(target, ready)); // 模块加载时一次
const manager = await useProjectExtractionManager(projectRoot);
const task = await manager.start({kind: "outline", source: {path, sha256}, params, modelKey});
await manager.cancel(task.id);   // 取消：已完成成果保留
await manager.resume(task.id);   // 从未完成单元继续（cancelled / interrupted / partial-failed）
await manager.retryUnit(task.id, unitId); await manager.skipUnit(task.id, unitId);
await manager.provideInput(task.id, input);                 // awaiting-input
const progress = await manager.progress(task.id);           // 整体、按 group、逐单元；运行中读内存真值
```

错误：`ExtractionTaskError.code` 为 `CONFLICT`（同来源同种类已有运行中任务，且不会调用 `prepare`）、`NOT_FOUND`、`INVALID_STATE`、`INVALID_INPUT`、`SOURCE_CHANGED`、`PIPELINE_UNREGISTERED`，路由层按 `code` 映射 HTTP。任务级停止（`interrupted`）带 `stopReason.code`：`source-changed`、`model-unavailable`、`unexpected`；项目关闭为 `interrupted` 且无 `stopReason`。

测试用法：`createScriptedModel(handler)`、`createTestLaunch()`（`closeProject()` 模拟项目关闭）、`createMemoryExtractionStore()` 加 `new ExtractionTaskManager({store, model, verifySource, resolvePipeline, launch})` 即可不依赖项目会话测试流水线。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
