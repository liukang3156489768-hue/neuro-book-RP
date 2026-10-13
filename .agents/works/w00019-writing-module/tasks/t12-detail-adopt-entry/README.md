---
schema: nbook.task/v2
taskId: t12-detail-adopt-entry
---

# 细纲正式采用入口

## 目标与范围

切片 10。开发者验收时指出细纲层级没有把草稿正式采用的按钮：其他层级在条目操作行有“正式采用”，细纲只有表单最下方分析面板里、分析完成后才出现的“正式采用细纲”。按 2026-09-30 的建议实施：

- 草稿细纲的操作行也显示“正式采用”。点击先做偏差分析（修订号未变时沿用已有报告），没有偏离和冲突直接采用；否则停在分析面板，作者确认偏离、说明冲突处理后采用。
- 所属章节大纲未采用、或细纲结构检查有阻断问题时按钮不可点，下方写明原因。
- 采用仍必须附带分析报告，不新增服务端接口。

合同：[outline.workbench-ui](../../../../../docs/specs/outline/workbench-ui.md)。

## 非目标

- 不改分析与采用的服务端规则。

## 当前状态

- 2026-09-30：完成。`OutlineDetailAnalysisPanel` 暴露 `analyzeAndAdopt()`，大纲库操作行调用；补组件说明 `OutlineDetailAnalysisPanel.md`，更新 `OutlineLibraryPanel.md` 与 workbench-ui Spec；组件测试覆盖直接采用、有偏离时停在面板、两种不可点原因；typecheck 通过。浏览器验收与 t13、t14 合并进行。
