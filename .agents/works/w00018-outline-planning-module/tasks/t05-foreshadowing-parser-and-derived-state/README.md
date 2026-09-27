---
schema: nbook.task/v2
taskId: t05-foreshadowing-parser-and-derived-state
---

# 伏笔库与标记派生

## 目标与范围

按实施计划推进 Phase 3：伏笔定义的规范文件草稿与确认、章节 Markdown 有效标记来源追溯、四状态派生、同章多标记及固定线路顺序异常；后续 Agent 建议审批与 UI 注释下划线分别与 Phase 5、Phase 6 合流。Phase 2 的 UI、writer.pro 交接门禁尚待其约定阶段验收，本 Task 不宣称该门禁已完成。

## 当前快照

伏笔定义规范文件现在保存草稿／确认状态，旧 v1 文件按草稿读取；创建、编辑和确认通过 ready Project 的 generation、manifest revision、对象版本/hash CAS 提交，进入 History，并可由文件重建。原始发布不能越过正式伏笔的确认与修改入口，同字节重命名仍允许。

从已确认伏笔、正式章节、固定线路、有效结构化标记计算草稿／待使用／已埋设／已回收四状态，返回章节路径、marker 原文与位置、线路节点来源及先回收／先强化异常；不同线路不臆造全局顺序。只读 HTTP 返回解析器版本。严格快照仍对损坏标记 fail-closed；伏笔只读快照按章节隔离标记解析错误，返回章节路径及解析诊断，不把不确定标记参与正式状态，同时保留其他有效章节来源。manifest hash 或 front matter 损坏仍整体拒绝。TipTap 标记编辑器、工作台异常展示和规划 Agent 建议／审批链路已接通；损坏章节使用独立 repair 事务，不把候选直接恢复为正式来源。

此前验证：大纲聚焦测试 14 文件、100 项通过（单 worker）；应用 typecheck 通过；docs:check 检查 6516 个文件、0 项失败。真实 H3 单项 2 项通过，包括 Project 重开、旧版本 409；纯领域测试覆盖重复标记、删除标记重算、草稿和未固定隔离、先回收、跨线路不确定性。

本轮只读隔离增量：独立临时 Project 规范文件先正常读取，再外部损坏第二章标记并同步 manifest hash；严格读取及候选发布拒绝、只读诊断该章且保留第一章有效来源、原始字节不修改。另覆盖 hash 不符与 front matter 损坏仍整体拒绝。新增回归后 3 个直接受影响测试文件 15 项通过；最终大纲聚焦整组 14 文件 101 项通过，应用 typecheck 通过，docs:check 检查 6516 文件、0 失败。测试中 History／SQLite 告警来自主动故障注入。默认全包测试、完整 Nuxt／浏览器与真实模型仍未验收。未调用真实模型或修改真实作品。

## 下一步

Phase 3 的产品代码缺口已收尾；后续只需按 Work 统一补齐浏览器、默认全包、Profile 运行时和真实模型边界，不再把损坏章节 repair 作为普通严格快照编辑入口。Phase 2、Phase 4 及其后的验收保持独立进行。

## 2026-09-25 固定来源资格收尾

- 派生正式伏笔时不再仅凭线路文件的 `fixed` 标志：历史 v1 固定线路不提供正式来源，v2 线路只接受当前分析仍有效且节点状态为 `valid` 的章节。同线路其他有效章节仍按原标记保留来源；已失效埋设不会使后续回收变成有效回收。
- 回归覆盖历史 v1、黄色节点、失效埋设后回收，以及有效 v2 分析报告下某一章节真实文件损坏后的逐章隔离；伏笔 Spec 同步资格边界。大纲聚焦测试使用单 worker 完整运行：17 文件、153 项通过；应用 typecheck 与 docs:check 在本次代码及 Spec 修改后通过，文档检查 6523 文件、0 失败。此前未隔离的全组运行曾遇一个偶发 HTTP 409 和 Vitest worker 意外退出，单独 HTTP 文件 8 项及本次隔离整组均通过，不将此前失败记作通过。
- 本次未运行默认全包测试、完整 Nuxt／浏览器验收或真实模型，也未实现 Agent 建议审批和 UI 注释；Phase 3 与完整模块仍未完成。

## 授权边界与验收

无需真实模型调用或真实作品数据；不得自动覆盖已有文件、提交、推送或远端写入。完成前须覆盖四状态、重复标记、先回收异常、来源、损坏文件、重开及并发过期；后续 Agent/UI 门禁保留未验证标记。

## 合同

- [实施计划](../../implementation-plan.md)
- [伏笔库与标记 Spec](../../../../../docs/specs/outline/foreshadowing.md)
- [大纲规划 Proposal](../../../../../docs/proposals/outline-planning-module.md)
## 2026-09-25 Agent 建议与损坏标记修复收尾

- 新增 `packages/neuro-book/server/outline/foreshadowing-suggestions.ts`：对章节正文候选执行严格伏笔标记解析、目标伏笔与方案归属校验、版本/hash CAS 校验，并生成不写盘的 `strengthen`、`resolve`、`repair` 建议；建议转成待审批的 `edit-entry` 变更，正式章节修改后回到 `draft`，需要重新采用，不能直接继续作为正式来源。
- 规划 Agent 新增 `get_foreshadowing_context` 与 `suggest_foreshadowing_marker` 受限工具：前者只返回指定章节及伏笔定义上下文，后者只生成带 `proposalId` 的待审批变更；写入仍由既有 `apply_planning_change` 审批、CAS 和 History 路径负责。规划 Profile、工具注册和 SDK 绑定已同步。
- 工作台伏笔库现在展示服务端返回的逐章标记解析异常，不把损坏章节误显示为空状态；TipTap 伏笔标记解析、下划线投影和异常 round-trip 已有编辑器回归。
- 新增伏笔建议领域测试 3 项、Agent 工具合同测试 2 项、规划工具边界测试 9 项；相关测试均通过。应用 typecheck 通过；Profile SDK 全量编译检查仍受 Windows 沙盒对 `../../../../../../..` 目录的 `Access is denied` 阻断，不能记为通过。
- 新增损坏章节专用 `prepareForeshadowingMarkerRepair` 及 ready Project 预览／提交入口：只接受服务端已诊断的单个损坏章节、manifest revision／章节 version/hash CAS 和严格可解析候选；发布层只对该已诊断路径宽容旧 marker，完整候选快照仍必须严格通过，提交后章节回到 `draft` 并沿用 History、事务 journal、索引刷新和 generation 校验。
- `get_foreshadowing_context` 在修复场景读取逐章容错快照；`suggest_foreshadowing_marker` 的 repair 建议转专用 action，普通 `library-action` 不能绕过损坏源。新增真实 H3 repair 合同、旧预览冲突和严格路由 schema 回归；本轮 6 个测试文件、45 项通过。随后完整大纲聚焦配置单 worker 25 个文件、236 项通过，应用 typecheck 通过。

## 当前未完成边界

- 当前未完成的是跨 Work 验收而非已知 Phase 3 产品代码：完整 Nuxt／浏览器人工验收、默认全包测试、真实模型调用和 Profile SDK 运行时 fixture 仍未执行；后者在 Windows 沙盒中受上级目录访问限制，不能记为通过。
- 真实作品数据、提交、推送和远端写入仍不在授权范围内；Phase 3 Spec 继续保持 `planned`，直到统一验收门禁闭合。
