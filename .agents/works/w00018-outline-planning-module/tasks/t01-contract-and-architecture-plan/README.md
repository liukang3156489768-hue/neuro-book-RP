---
schema: nbook.task/v2
taskId: t01-contract-and-architecture-plan
---

# 合同与架构实施计划

## 目标与范围

把开发者已确认的大纲规划模块设计整理为可执行的 `accepted Proposal`、`planned Spec` 和分阶段实施计划，并完成现有 Plot、Project Workspace、文件历史、Agent 会话及 `writer.pro` 的领域边界核对入口；同步 ADR 0022 固定的结构化文件真相源、SQLite 索引定位、删除语义、标记语法和迁移边界。

本 Task 只负责规划、合同和文档治理，不实现产品代码，不执行数据库迁移，不调用真实模型，不创建实现 worktree。

## 当前状态

已完成本轮文档规划交付。Proposal 已为 `accepted`，六项 planned Spec、注册表、ADR 0022 和实施计划均已建立。开发者已确认核心架构决策；剩余 Phase 0 仅处理现有代码 API 映射、最终 schema 字段与版本、文件事务/恢复、Plot 只读适配和分析服务边界。

## 授权来源与限制

- 来源：开发者 2026-09-24“根据此设计文档正式规划开发计划，准备将此模块开发落地”的明确请求。
- 允许：修改本 Work 的 README、实施计划、相关 Proposal、Spec 文件及 Spec 注册表。
- 禁止：修改产品代码、数据库/用户数据、其他任务文件；不得覆盖或清理工作区已有改动；不得提交或远端写入。

## 交付清单

- [x] Proposal 状态和决策边界更新为 accepted。
- [x] 创建大纲库、伏笔库、线路规划、Agent、工作台 UI、writer.pro 交接六项 planned Spec。
- [x] 在 `docs/specs/README.md` 建立唯一注册表入口。
- [x] 完成 Work `implementation-plan.md`，包含阶段、依赖、门禁、迁移、回滚和后续 Task 原则。
- [x] 运行 `bun run docs:check` 并记录最新结果：2026-09-24 通过，`failures: []`，`checkedFiles: 6483`。
- [x] 人工检查未把实现猜测写入行为合同。

## 有效证据

- [大纲规划模块 Proposal](../../../../docs/proposals/outline-planning-module.md)
- [Work 实施计划](../implementation-plan.md)
- [现有 Plot Reference](../../../../packages/neuro-book/assets/reference/plot/README.md)
- [Spec 流水线](../../../../docs/specs/README.md)
- [测试门禁](../../../../docs/testing/README.md)

## 验证结论

2026-09-24 已重新运行 `bun run docs:check`，结果为 `failures: []`、`checkedFiles: 6483`。本轮未运行产品代码、真实模型、数据库迁移或浏览器人工验收。

## 下一步

本 Task 文档规划与验证已完成。下一步执行 `t02-domain-mapping-and-persistence-decision`，核对现有 Plot、Project Workspace、History、Agent Session 与本模块的 API、schema、事务/恢复和只读交接边界；该 Task 仍不直接实现产品功能。



