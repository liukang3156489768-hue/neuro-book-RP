---
schema: nbook.task/v2
taskId: t11-line-graph-redesign
---

# 线路规划重做：方案级共享节点图与横向分格

## 目标与范围

开发者 2026-09-26 指出线路规划实现与设计预期偏差很大，并提供设计图示：主线分出支线、支线2和角色线，中途两两汇合，最终汇回主线。本 Task 按[线路规划 Spec](../../../../../docs/specs/outline/line-planning.md) 与 Proposal 决策记录“开发者（四）”重做线路规划：

- 每个方案一张共享节点图（`outline/graphs/`），节点位于“格×行”，格号是方案内的全局剧情先后，行号只是排版；
- 线路（`outline/storylines/`，`nbook.outline-line/v3`）是勾选节点组成的链，按线路分析和固定；
- 伏笔先埋后收按格号跨线路判定，已过章节数按格数差计算；正文交接按格号排序；
- 工作台线路视图改为 vue-flow 画布；
- 旧 `outline/lines/` 文件不兼容，保留在磁盘但不再读取。

取代 t06 的线路数据模型与领域操作；t06 的发布门禁、分析审批、失效投影和缺失条目修复思路沿用到新模型。

## 当前快照（2026-09-26）

- P0–P5 均已完成：
  - P0 文档：线路规划 Spec 重写，伏笔、正文交接、工作台、Agent 协助 Spec 与 ADR 0022 同步，Proposal 追加决策记录，新增[线路图格式替换说明](../../../../../packages/neuro-book/docs/migrations/outline-line-graph.md)。
  - P1–P4：格式、加载、领域操作、伏笔与正文交接、HTTP 与 Agent 工具全部切到共享节点图。
  - P5：工作台线路视图为 vue-flow 画布加侧栏，画布在 `app/components/novel-ide/outline/line-graph/`。
- 相对批准计划的调整：
  - 同一方案图中一个条目最多对应一个节点，加载和操作都拒绝，取代“重复节点标记”；
  - `contextHash` 不含其他固定线路，避免固定一条线路使其他固定线路失效；但它覆盖方案内其他条目，所以修改任一条目时固定线路的节点会整体转黄；
  - 原始文件发布入口拒绝一切非同字节的线路图与线路文件变更，而不是按不变量放行；
  - 线路图文件名为 `<方案标题 slug>--<gr-id>.yaml`；
  - 链是否有效在加载时只做软检查：草稿可以保存不完整的链，分析和固定时才强制；
  - 缺失条目修复把节点置空，不提供替换候选；
  - 修改条目会把包含它的固定线路退回草稿；
  - 被图节点引用的挂载关系不能直接移除；删除方案会同时删除它的图和草稿线路，有固定线路时拒绝；
  - 画布不使用 vue-flow 的 `snapGrid`，改为放下时换算单元格；Nuxt 为 `ssr: false`，未包 `ClientOnly`；
  - 工作台 CSS 变量契约测试改为递归扫描 outline 子目录。
- 验证（2026-09-26）：
  - 前端：outline 组件与数据测试 27/27 通过；
  - 服务端：`server/outline`、`server/api/projects/outline`、`server/agent` 全量 1643 个用例中，与本 Task 相关的失败已修复；
  - 剩余失败都与本 Task 无关：
    - `NEURO_BOOK_REPOSITORY_ROOT` 未设置导致的 Profile 测试失败，设置后通过；
    - 本机 bash 缺 `rg` 导致的 file-tools 测试失败；
    - `foreshadowing-repair-http.contract` 在全量负载下偶发 `PUBLISH_FAILED`，单独运行通过；
  - `bun run typecheck` 0 错误，`bun run docs:check` 通过。
- 未验证：浏览器中的画布交互（拖放吸附、连线、双击建节点、标尺同步）、真实模型读取图摘要。
- 待复核（从代码推断）：`server/outline/analysis-invalidation.ts` 修改细纲时，会撤销所有包含该章节的固定线路，包括共享该章节的其他方案。这比按方案划分更保守。
- 大纲模块在主工作区未跟踪，工作留在当前工作区 `codex/sync-upstream`，未提交。

## 下一步

开发者在浏览器中手测画布；确认后按仓库流程迁入 worktree 并提交。
