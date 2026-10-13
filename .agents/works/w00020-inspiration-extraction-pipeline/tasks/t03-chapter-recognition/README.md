---
schema: nbook.task/v2
taskId: t03-chapter-recognition
---

# 章节识别与划卷

## 目标与范围

按 [outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md)“输入与前置条件”实现大纲提取的结构前置：从来源识别章节、卷标题，支持用户修正，并把章节划分为卷。本 Task 只交付纯函数与服务端结构（不含 UI、不含提取任务、不调用模型）。

要交付：

1. **章节识别**：在现有“第X章/回/节”“Chapter N”“序章/楔子/尾声/番外”基础上，增加“单独一行仅有数字”标题形式；该形式只在上下文支持时判定（与前后数字行呈连续递增），孤立数字行不判定为标题。“第X卷”改为卷标题：作为默认划卷建议，不再计为章节。
2. **用户修正**：设置／取消某行为章节标题、合并相邻章节、拆分章节。修正是一份作用于识别结果的列表，不改动来源。
3. **划卷**：章节模式下按章节范围划卷（卷由连续章节组成、不重叠、不遗漏，可整部作品为一卷）；字数模式（无可识别章节）下一个切分块视为一章，每 N 个块一卷（N 为正整数）。
4. **划卷校验**：对不合法划卷返回明确错误；产出稳定的“提取结构”（来源哈希、章节列表含 P 范围与字数、卷列表），供后续提取任务持久化。

## 非目标

- 不实现提取任务、持久化文件、HTTP 路由、界面（后续切片）。
- 不改动现有 `splitInspirationSource` 的对外行为与 `InspirationSourcePrepareResponse`（旧提取流程仍在使用，切片 8 才替换）；需要复用其段落编号与分块时只做不改变行为的最小抽取。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 现状与改动落点（从代码推断）

- `packages/neuro-book/server/inspiration/source-split.ts`：现有段落编号（P1 起、空行附着前一段）、章节标题正则（把“第X卷”也当章节）与按约五万字分块；
- `packages/neuro-book/shared/dto/inspiration-source.dto.ts`：来源 DTO；
- 建议新增 `server/inspiration/outline-structure.ts`（识别、修正、划卷）及 DTO；具体以实施时的代码为准。

## 验证

- 聚焦测试覆盖 Spec 验收条目：10 章加 2 个卷标题的来源得到 10 章与默认卷建议；数字行 `1`…`10` 识别为 10 章而孤立数字行不是标题；设置／取消／合并／拆分后章节列表更新；无章节时每块一章、每 N 块一卷；非法划卷（重叠、遗漏、N 非正整数、章节为空）被拒。
- `server/inspiration` 既有测试通过；应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 完成后更新 Spec“实现合同”事实（如无该节则在 Spec 末尾补一节），运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-02 登记；同日实现完成（未提交）。

实现记录：

- 新增 `packages/neuro-book/server/inspiration/outline-structure.ts`（`recognizeChapters`、`applyChapterCorrections`、`suggestVolumeRanges`、`planChunkChapters`、`divideVolumes`、`buildExtractionStructure`、`OutlineStructureError`）与 `outline-structure.test.ts`（25 条），新增 `packages/neuro-book/shared/dto/inspiration-outline-structure.dto.ts`（zod schema、错误码）。
- `source-split.ts` 只做不改行为的抽取：导出 `countCharacters`、`headingLineText`、`chapterTitle`，并把分块循环抽成 `groupSourceUnits`；`splitInspirationSource` 对外行为不变，既有测试全部通过。
- 规则与语义以 [Spec“实现合同”](../../../../../docs/specs/inspiration/outline-extraction.md)为准。
- 验证：`bun run test server/inspiration` 6 个文件 74 条通过；`NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` 退出码 0；仓库根 `bun run docs:check` 仍有既有失败，但输出中无 w00020 或本 Spec 相关项。

已知限制：

- 数字行规则只看数字行之间的相邻关系，正文中恰好连续出现的 `1`、`2` 单行（如列表页码）会被判为标题，需用户修正取消。
- 卷标题与其后章节标题之间若隔有其他正文，卷标题行留在上一章末尾（不归入下一章），默认卷建议仍从下一章开始。
- 卷标题行不能设为章节标题；“第X部”仍按章节处理（未改变既有规则）。
- 未接入 HTTP、持久化、提取任务和界面。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
