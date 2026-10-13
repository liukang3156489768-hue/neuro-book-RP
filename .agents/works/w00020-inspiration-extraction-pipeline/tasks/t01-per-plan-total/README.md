---
schema: nbook.task/v2
taskId: t01-per-plan-total
---

# 每方案一个总纲

## 目标与范围

按 [outline.planning-library](../../../../../docs/specs/outline/planning-library.md) 与 [outline.writer-handoff](../../../../../docs/specs/outline/writer-handoff.md) 把总纲从“全局唯一”改为“每方案恰好一个，手动关联才共享”。这是提取方案能拥有自己总纲的前提。

要交付：

1. **manifest 新 schema**：用新版本表示方案与总纲的对应关系。读取旧版时按“所有方案共用原全局总纲”归一，不改写用户文件；新版文件在旧版本中必须被明确拒绝。
2. **新建方案**：默认同时新建一个空总纲；一个方案不能没有总纲，也不能有两个。
3. **手动关联与解除**：用户或模块 Agent 可让方案改用另一方案的总纲；共用后的修改沿用写时分叉；可解除共用（分叉出方案专属总纲）。语义见 Spec“状态与转换”。
4. **删除总纲**：预览须列出受影响方案；仍需二次确认。
5. **写作交接**：按方案读取其自己的总纲，不再假设全局总纲。
6. **同步**：Agent 工具（`planning-tools.ts` 中总纲相关动作与摘要）、技能文档 `novel-outline-planning/SKILL.md`、大纲 Profile 文案“共用唯一总纲”、大纲库界面中依赖 `manifest.totalId` 的位置（按方案显示总纲、共用标记、关联／解除入口），以及依赖该字段的测试。

## 非目标

- 不做数据迁移，旧项目保持共用关系即可。
- 不实现来源提取细纲依据（见 t02）和任何提取流水线。
- 不整理大纲库界面，只改使其适配每方案总纲所必需的部分。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 现状与改动落点（从代码推断）

约 34 个文件依赖 `manifest.totalId`，主要落点：

- `packages/neuro-book/server/outline/format.ts`：manifest 解析（约 209–246 行）、`PLAN_TOTAL_REQUIRED`／多总纲校验（约 500–512 行）；
- `packages/neuro-book/server/outline/library.ts`：创建总纲（“全局总纲已经存在”）、创建方案以 `manifest.totalId` 为根、方案根节点；
- `packages/neuro-book/server/outline/operations.ts`：“方案不能移除共享的唯一总纲根引用”等校验；
- `packages/neuro-book/server/outline/writer-context.ts`：读取总纲及其子级；
- `packages/neuro-book/server/agent/tools/planning-tools.ts`：总纲动作与 `totalId` 摘要；
- `packages/neuro-book/app/components/novel-ide/outline/OutlineLibraryPanel.vue`（6 处）；
- 测试：`library.test.ts`、`lifecycle.test.ts`、`http.contract.test.ts` 及其他引用该字段的用例；
- 不碰 `server/outline/format.ts.backup` 与 `DELETION-LOGIC.md`（备份与历史说明，不属本 Task）。

具体清单以实施时对 `totalId` 的全文检索为准。

## 验证

- 聚焦测试覆盖 Spec 新增与修改的验收条目：两方案独立总纲、手动关联与分叉、旧版 manifest 归一且文件不被改写、新版在旧读取路径被拒绝、删除预览含受影响方案、交接按方案读取总纲。
- `server/outline`、`server/api/projects/outline`、`server/agent/tools/planning-tools.test.ts`、`app/components/novel-ide/outline` 的既有测试通过（按需更新与旧语义相关的断言）。
- 应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`，默认堆内存会 OOM，见 w00019 t01）。
- 完成后更新 [planning-library.md](../../../../../docs/specs/outline/planning-library.md) 的“实现合同”事实，并运行 `bun run docs:check`（已有 6 项失败与本 Task 无关，只要不新增）。

## 当前状态

2026-10-02 完成实现与验证（未提交）：

- 服务端：manifest `nbook.outline/v3`（每方案 `totalId`，v1／v2 读取时归一且不改写文件）；`create-plan` 自带空总纲；新增 `associate-total`、`unshare-total`；共用总纲写时分叉；删除预览含 `usedByPlanIds`／`affectedPlanIds`，使用中的总纲不可删；写作交接、线路修复、Agent 工具、HTTP 路由同步。
- 前端：`OutlineLibraryPanel.vue` 与 `.md`、`useOutlineWorkbenchData.ts` 按方案总纲适配（去掉全局确认与创建总纲，新增关联／解除共用入口与删除提示）。
- 文档：`SKILL.md`、大纲 Profile 源文案（未手改 `.compiled`）、`planning-library.md` 的删除语义与“实现合同”。
- 验证：相关测试 `server/outline`、`server/api/projects/outline`、`server/agent/tools`、`server/writing`、`app/components/novel-ide/outline`、`app/composables`、`app/utils/outline` 共 731 例，730 通过；失败一例 `server/agent/tools/file-tools.test.ts`（真实 bash 的 ripgreprc 配置路径，与本 Task 无关，已记入待报告）。`typecheck` 通过。`docs:check` 失败项均为既有（outline 三份 Spec 缺 frontmatter、`inspiration-workbench.md` 证据格式、旧 Task 缺 Spec 链接），本 Task 未新增。
- 已知限制：孤立总纲的级联删除按条目规范 `parentId` 进行，仍可能波及其他方案挂载的条目；预览会列出受影响方案并要求二次确认。`associate-total` 允许关联到孤立总纲（未设限制）。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不做数据库迁移；不使用真实模型。
