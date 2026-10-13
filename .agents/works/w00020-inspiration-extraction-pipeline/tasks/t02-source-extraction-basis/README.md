---
schema: nbook.task/v2
taskId: t02-source-extraction-basis
---

# 细纲“来源提取”采用依据

## 目标与范围

按 [outline.planning-library](../../../../../docs/specs/outline/planning-library.md)“细纲的采用依据”和 [outline.writer-handoff](../../../../../docs/specs/outline/writer-handoff.md) 为细纲增加第二种正式依据：**来源提取**。提取流水线（后续切片）将用它写入正式细纲。

要交付：

1. **依据字段**：细纲条目记录采用依据（分析审阅／来源提取），解析、序列化与旧文件读取兼容（缺失视为分析审阅）。
2. **写入资格**：只有提取流水线的领域入口可以写入“来源提取”依据，且必须带落在本章范围内的原文引用；用户与普通 Agent 工具不能直接设置该依据。
3. **审阅判定**：`assertDetailReviewed` 把来源提取依据视为已审阅；写作交接据此判定细纲可写。
4. **失效规则**：上游链变化时，来源提取细纲不退回草稿（`analysis-invalidation.ts` 与 `detailReviewScope` 对其豁免）；其余细纲规则不变。
5. **编辑转换**：用户修改来源提取细纲的正文后，该细纲回到草稿并转为分析审阅依据；仅移动、重排或改变所属方案不改变依据。

## 非目标

- 不实现提取流水线本身，不写入任何提取内容。
- 不改动普通细纲的分析、偏差与审阅规则。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 现状与改动落点（从代码推断）

- `packages/neuro-book/server/outline/writer-context.ts`：`assertDetailReviewed`；
- `packages/neuro-book/server/outline/detail-analysis.ts`：`detailReviewScope`；
- `packages/neuro-book/server/outline/analysis-invalidation.ts`：上游变化时撤回已采用细纲（`invalidateDependentDetails`）；
- `packages/neuro-book/server/outline/format.ts`：条目 schema（`nbook.outline-entry/v2`）的字段扩展；
- 与 t01 触及相同文件（尤其 `format.ts`），顺序执行，t01 完成后再开始，避免冲突。

## 验证

- 聚焦测试覆盖 Spec 新增的验收条目：来源提取细纲无需分析即可写；改所属章节大纲后仍为正式；编辑正文后回到草稿并要求常规审阅；缺少原文引用被拒绝；用户路径不能设置该依据；旧细纲读取不变。
- 大纲模块与写作交接既有测试通过；应用 `typecheck` 通过。
- 完成后更新 Spec 的“实现合同”事实，并运行 `bun run docs:check`（不新增失败）。

## 当前状态

2026-10-02 完成实现与验证（未提交）：

- `format.ts`：细纲可选 frontmatter `basis`（`source-extraction` 加 `sources[{path, locator}]`），解析、序列化与校验（仅正式、无分析报告的细纲，引用非空）。
- `library.ts`：新增领域入口 `prepareSourceExtractionDetail`（非 `LibraryAction`，HTTP／Agent 到不了）；`edit-entry` 清除 `basis`，`move-entry` 对带 `basis` 的细纲保留依据与正式状态；`fork.ts` 分叉清除 `basis`。
- `writer-context.ts` 的 `assertDetailReviewed` 对带 `basis` 的细纲视为已审阅；`analysis-invalidation.ts` 跳过它们。`detailReviewScope` 只服务分析审阅，未改动（与登记时的设想不同，豁免放在失效判断处）。
- 新增 `server/outline/source-extraction.test.ts`（8 例）；验证：`server/outline`、`server/api/projects/outline`、`server/writing`、`planning-tools` 共 340 例通过，`typecheck` 通过。
- Spec：`planning-library.md` 的“实现合同”已补依据字段与入口，并把“依据存于 `references`”改为 `basis.sources`。
- 范围说明：引用是否落在本章 P 范围内由后续提取流水线校验，本 Task 只保证引用存在。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
