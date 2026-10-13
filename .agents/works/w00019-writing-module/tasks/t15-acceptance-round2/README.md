---
schema: nbook.task/v2
taskId: t15-acceptance-round2
---

# 第二轮验收修正

## 目标与范围

切片 13。开发者 2026-10-01 真实调用后反馈，讨论后确认的方案：

- 写作进度卡片内容多时占满会话，加抽屉折叠。
- 写手越界写到下一场景：收紧场景边界，允许在结尾铺垫下一场景，严禁展开下一场景剧情；写作字数容差从上下 15% 放宽到上下 50%。
- 写作指导重复：助手不再重复程序已摘录的细纲写作手法。
- 助手提示按调用种类只载入对应模式；整章编写模式在 Profile 与工作流中预留位置，暂不实现。
- 大纲规划 Agent 按 Project 路径读取模板失败（ENOENT）：改为由 Profile 直接载入模板。

合同：[writing.collaboration](../../../../../docs/specs/writing/collaboration.md)、[writing.workspace-ui](../../../../../docs/specs/writing/workspace-ui.md)、[outline.agent-assistance](../../../../../docs/specs/outline/agent-assistance.md)。

## 非目标

- 不实现整章编写模式。
- 不放宽规划一致性检查 `WORD_TARGET_MISMATCH`，它仍按 15%。

## 当前状态

- 2026-10-01：完成。
  - 进度：`WritingSessionView` 的写作进度改为可收起的抽屉，内容限高约半屏滚动，收起时出现待用户确认项会显示提示并自动展开；`WritingRunCard` 的场景详情、规划摘要和结果列表各自限高滚动。组件说明与 Spec 已更新。
  - 写作：`WORD_TOLERANCE` 改为 0.5，规划一致性检查改用 `PLAN_WORD_TOLERANCE`（0.15）；写手输出要求与助手审阅规则写明场景边界。
  - 助手：`writing.assistant` 系统提示拆为通用部分、按 `ctx.invocation.payload.kind` 选择的模式片段、问题登记与退回规则；新增 `plan-chapter`、`review-chapter` 预留种类。工作流 `WritingRunArgs` 增加可选 `granularity`，`chapter` 按 `unsupported` 停止。
  - 规划：`outline.planner` 与 `outline.foreshadowing` 补载两份模板，`outline.outline` 补载细纲标注；`SKILL.md` 与细纲工具说明改为提示模板已在上下文中、不按路径读取。
  - 验证：写作服务端与组件、写作 Profile、规划专家 Profile、规划工具、写作路由测试通过（158 + 21）；typecheck 通过。前端与真实模型未验证，由开发者测试。
