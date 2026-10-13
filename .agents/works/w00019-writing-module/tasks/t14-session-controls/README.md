---
schema: nbook.task/v2
taskId: t14-session-controls
---

# 写作会话控件

## 目标与范围

切片 12。开发者验收时指出写作会话缺少控件：三个角色的模型切换、思考开关、温度，以及新建和删除对话。按 2026-09-30 的建议实施：

- 会话头部加本章会话下拉、"新建会话""删除当前会话""模型设置"。
- 一章可以有多个主创会话，默认打开最近更新的一个；删除即归档，本章有运行、主创回复中或等待回答时不可删除。
- 模型设置分别设置主创、助手、写手的模型、思考（含关闭）和温度，保存在本作品的 Project Config。

合同：[writing.collaboration](../../../../../docs/specs/writing/collaboration.md)、[writing.workspace-ui](../../../../../docs/specs/writing/workspace-ui.md)。

## 非目标

- 不做单个会话的模型覆盖；模型只按角色设置。
- 不改全局设置页的 Agent Profile 界面。
- 不修改现有 `writer` Profile。

## 改动

- 服务端：
  - `server/writing/run-host.ts`：新增 `listChapterSessions`、`createChapterSession`、`startChapterSession`、`deleteChapterSession`；`findChapterSession` 改为取最近更新的会话。删除前检查会话属于本章、本章没有进行中的运行、会话处于空闲或已中断，然后归档。
  - `server/writing/role-models.ts`（新建）：`readWritingRoleModels` 读取三个写作 Profile 的模型设置与可选模型；`saveWritingRoleModel` 只合并 modelKey、reasoningEffort、temperature，null 表示清除，模型未启用时返回 `MODEL_INVALID`。
  - 路由 `server/api/projects/writing/[...segments].ts`：新增 `GET chapter-sessions`、`POST delete-chapter-session`、`GET role-models`、`POST role-model`；`POST chapter-session` 支持 `fresh`；`MODEL_INVALID` 映射 422。
  - `shared/dto/writing.dto.ts`：新增会话条目、角色与角色模型设置的 DTO。
- Harness：`server/agent/harness/neuro-agent-harness.ts` 新增 `profileRequestOptions`。Profile 配置的 `temperature` 过去只能在设置页填写、运行时没有使用；现在作为 Provider 请求参数生效，优先级在 Provider 默认之上、单次调用覆盖之下。这会影响所有配置了温度的 Profile。
- 界面：
  - `app/utils/writing/writing-api.ts`：会话与角色模型的请求方法。
  - `app/composables/useWritingChapterAgent.ts`：列出、切换、新建、删除会话，以及保存主创设置后让当前会话跟随角色设置。
  - `WritingRoleModelsPopover.vue`（新建）与组件说明。
  - `WritingSessionView.vue`：头部接入会话下拉、新建、删除（内联确认）与模型设置。

## 当前状态

- 2026-10-01：完成。
  - 验证：`server/writing/` 与写作组件测试 131 个、写作路由 7 个、harness 与 inspiration 398 个通过；typecheck 通过。新增 `run-host.test.ts` 3 个、`role-models.test.ts` 3 个、`route.test.ts` 2 个用例。
  - 组件交互未写测试，前端由开发者真实测试。
