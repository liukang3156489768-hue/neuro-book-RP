---
schema: nbook.task/v2
taskId: t10-migration-acceptance-and-release
---

# 验收与发布准备

Task ID 沿用创建时的名称；其中的迁移部分已于 2026-09-26 撤销。

## 目标与范围

执行实施计划 Phase 8：完成大纲规划模块的合同测试、服务测试、UI 测试、项目隔离、损坏文件与升级中断恢复，以及浏览器验收，为各项 `planned` Spec 晋升 `implemented` 收集证据。本 Task 不提交、不推送。

## 当前快照（2026-09-26）

- **迁移已撤销**：此前本 Task 为“从《新小说编写计划》导入规划”建立了迁移 Spec 和实现。开发者指出该文档是开发设计文档而非用户数据，原始模块从未开发，因此不存在需要迁移的旧规划数据。
- **已删除的内容**：
  - `docs/specs/outline/migration.md` 及其在 `docs/specs/README.md` 中的登记；
  - `server/outline/migration.ts`、`migration.test.ts`；
  - `server/outline/host.ts` 中的 preview/apply/rollback 导入入口；
  - `server/api/projects/outline/` 中的 `preview-import`、`apply-import`、`rollback-import` 路由及 `migration-http.contract.test.ts`；
  - 工作台中的 `OutlineMigrationPanel.vue` 与“导入旧计划”按钮。
- **删除后的验证**（2026-09-26）：
  - 应用 `typecheck` 通过；
  - `vitest.outline-local.config.ts` 聚焦测试 21 个文件中 216 项有 215 项通过。唯一失败是 `file-tools.test.ts` 中“retrieval 的 index.md 清单命令可在真实 bash 中执行”，原因是本机 bash 缺少 `rg`。该文件已还原到 HEAD，与本次改动无关。
  - 首轮运行曾出现一次 “Worker exited unexpectedly”，不计作通过。
- **验收**：Phase 8 的其余验收尚未开始。

## 未验证项与停止条件

- 默认全包测试、真实发布包、运行中 HTTP 并发隔离和浏览器人工验收均未执行。
- 各 `planned` Spec 只有在对应实现与上述验收都有可复现证据后才能晋升 `implemented`。

## 相关入口

- [实施计划](../../implementation-plan.md)
- [原始设计对照整理](../../original-design-reconciliation.md)
- [测试与验收门禁](../../../../../docs/testing/README.md)
