---
schema: nbook.task/v2
taskId: t07-rewrite-flow
---

# 改写流程

## 目标与范围

实现 [writing.collaboration](../../../../../docs/specs/writing/collaboration.md) 的改写部分，接入 t05 的工作流内核与 t06 的主创工具。

1. 目标定位：按段号或选中的原话定位，扩展到完整段落，上下各截取至多两段。
2. 改写工作流：助手提交结构 D 的改写规划并经校验，写手按提示改写，助手审阅，未通过时重写；最后以新旧对照请用户确认，确认后才替换目标段落。
3. 替换：按目标原文重新定位，目标已被改动时不替换；局部改写不更新正文 `source`。
4. 运行服务同时承载整章写作与改写，同一章节同一时间只有一个运行。
5. 主创工具：发起改写、转交用户的替换决定；读正文时标注段号。助手 Profile 支持改写规划与改写审阅。

## 非目标

- 从编辑器选区发起改写的界面与 HTTP 接口：切片 7。
- 真实模型验收：切片 8。

## 验证

- 定位与替换纯函数单测：段号、原话（含 Markdown 记号与空白差异）、多处命中、章首章末截取、目标之外改动后的替换、目标被改动时拒绝。
- 改写工作流 Mock 测试：规划校验重试、审阅重写、确认替换、放弃、停止，以及与整章写作互斥。
- 主创工具与 Profile 合同测试更新；`server/writing` 测试与应用 `typecheck` 通过；完成后更新 Spec 实现合同。

## 当前状态

- 2026-09-29：登记，开始实现。
- 2026-09-30：完成。`rewrite.ts`（定位、截取、替换）与 `rewrite-workflow.ts`（`writing.rewrite@1`）；运行服务同时承载两类运行，共用每章一次运行的限制；主创新增 `start_rewrite`、`answer_rewrite`，读正文标注段号；助手 Profile 支持 `plan-rewrite`、`review-rewrite`。验证：`rewrite.test.ts` 8 项，`run-service.test.ts` 新增 3 项改写用例（含目标被改动时不替换、目标之外改动仍可替换、文件头不变），工具与 Profile 合同测试更新；`server/writing` 与写作工具、Profile 测试 113 项通过，`typecheck` 通过。Agent 工具与 Profile 目录的其余测试中只有 `file-tools.test.ts` 一项因本机缺少 `rg` 失败，与本片无关。未做真实模型验收。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交，不做远端写入。
