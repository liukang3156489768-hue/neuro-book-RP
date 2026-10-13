---
schema: nbook.task/v2
taskId: t13-style-management
---

# 文风管理入口

## 目标与范围

切片 11。开发者验收时指出写作设置里没有文风入口，只能选择已有文风文件。按 2026-09-30 的授权实施：新增、删除和修改文风都由用户填写，程序写入，不经过模型；写手提示中的文风部分直接取当前选定的文风文件。

- 文风选择框旁加“编辑”“新增”“删除”：编辑在中间编辑器打开当前文风；新增内联输入名称，建好后打开；删除内联确认。
- 空选项改为“未选择（写作前必须选择）”。
- 服务端 `POST create-style {title}`、`POST delete-style {stylePath}`；有进行中的写作运行时拒绝删除。
- 开发者授权写作模块在上述操作中写入或删除 `lorebook/instruction/` 下的文风文件。

合同：[writing.prose-binding](../../../../../docs/specs/writing/prose-binding.md)、[writing.workspace-ui](../../../../../docs/specs/writing/workspace-ui.md)、[writing.collaboration](../../../../../docs/specs/writing/collaboration.md)。

## 非目标

- 不做文风内容的表单化编辑；修改直接在编辑器里改 Markdown。
- 不改文风文件的解析规则。

## 当前状态

- 2026-10-01：完成。`server/writing/host.ts` 新增 `createReadyWritingStyle`、`deleteReadyWritingStyle`；路由、API 客户端、写作 store、`WritingOutlineView` 与组件说明、三份 Spec 已更新。服务端测试覆盖新增模板、已有选择不改、删除清空选择、条目目录有其他文件时拒绝；typecheck 通过。
- 复核修正：`FormInput` 不支持 `size`，去掉误传；提示文字改用中文引号。
- 组件测试未保留，前端由开发者真实测试。
- 过程事故：编写测试时误用整文件覆盖了 `server/writing/host.test.ts`，该目录未入库无法恢复，前面切片的服务端测试需重建，见 Work 当前状态。
