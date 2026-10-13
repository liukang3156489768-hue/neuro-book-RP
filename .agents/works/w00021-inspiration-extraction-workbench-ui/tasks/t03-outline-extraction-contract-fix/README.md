---
schema: nbook.task/v2
taskId: t03-outline-extraction-contract-fix
---

# 大纲提取模板合同与截断重试

## 目标与范围

修复大纲细纲提取中提示词模板与共享校验规则冲突的问题，明确字数和标题格式，并对模型长度截断增加一次有界的压缩重试。记录模型响应元数据，便于后续真实验收区分截断与模板校验失败。

行为合同：[大纲提取](../../../../../docs/specs/inspiration/outline-extraction.md)；本任务不改变任务状态、产物写入和来源引用合同。

本任务不调整模型输出上限，不改写已保存的大纲，不重试真实任务，不实施按场景拆分提取。

## 授权与执行

2026-10-05 开发者审阅修复方案并授权本地源码修改、聚焦测试和类型检查；真实模型验收由开发者在修复后新建任务执行。主工作区已有其他 Work 的未提交改动，执行时仅修改本任务涉及文件。

## 当前状态

已完成实现：

- 提取阶段使用独立的细纲模板，不再包含“参考资料”和“伏笔”小节；编辑器完整模板保持不变。
- 提示词明确要求目标字数和场景字数使用阿拉伯数字正整数，并强化一级标题、场景标题和必需结构约束。
- `length` 模型结束原因最多触发一次压缩重试；仍失败时保留原错误。
- 提取模型日志记录模型、stop reason、输入/输出/总 token、最大输出上限和响应文本字符数，不记录完整原文或密钥。

## 有效证据

- `server/inspiration/extraction/model-adapter.test.ts`、`repair.test.ts`、`outline-validation.test.ts`、`managed-prompts.test.ts`：21 项通过。
- `shared/outline-detail-structure.test.ts`：11 项通过。
- `bun run --cwd packages/neuro-book typecheck`：通过；首次未增加堆内存运行因宿主 Node 堆上限 OOM，使用 `NODE_OPTIONS=--max-old-space-size=8192` 后通过。

## 验收边界

旧任务使用创建时冻结的提示词快照，不代表本次修复；请新建大纲提取任务进行真实模型验收。重点观察 `server-current.jsonl` 中 `inspiration.extraction.modelResponse` 与 `inspiration.extraction.unitFailed` 的对应关系。
