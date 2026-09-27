---
schema: nbook.task/v2
taskId: t09-writer-pro-handoff
---

# writer.pro 规划交接

## 目标与范围

执行实施计划 Phase 7 的规划侧部分：只读取当前 Project 已固定、未失效的正式线路节点、章节及细纲，并交接素材索引、参考文件和本章伏笔标记处的文本。`writer.pro` 是按《新小说编写计划》原始设计新建的 Agent，尚未开发；本 Task 不改造现有 `writer` Profile。

## 当前快照（2026-09-26）

- **仍然有效**：`server/outline/writer-context.ts` 与 `writer-materials.ts` 的只读投影，以及 `read-writer-context` HTTP 路由。
  - 投影校验 manifest revision 与线路 version/hash，复用线路资格门禁；
  - 草稿细纲、仅存在于大纲库的条目、未先埋设的回收标记和草稿伏笔定义都不进入交接；
  - 素材按正式条目引用清单按需读取，并返回来源。
- **2026-09-26 起**：伏笔来源不再携带伏笔定义正文 `body`，以免背后关联和回收计划泄露到正文。`writer-context.test.ts` 已断言该字段不存在。
- **2026-09-26 回退**：此前误把现有 `writer` 当作 `writer.pro` 改造，已按开发者要求整体还原到 HEAD。
  - 还原的改动：移除 bash、通用文件工具中针对 writer 的读写限制、`fixedOutline` payload 与 `get_fixed_outline_context` 工具、章级写作评审 workflow 的必填锚点、写作 smoke 的 `--fixed-outline` 参数；
  - 删除的新增文件：`writer-outline-tool.ts`、`writer-outline-tool.test.ts`、`writer-profile-permissions.test.ts`、`scripts/smoke/writing-workflow.test.ts`；
  - 回退前的补丁备份在本机临时目录 `nb-writer-revert-backup-20260926111950`。
- **验证**：应用 `typecheck` 通过；大纲聚焦测试 216 项中 215 项通过，唯一失败是本机缺少 `rg` 的既有环境问题。

## 下一步

- `writer.pro` 按原始设计 2.1 另行设计和开发，届时接入本只读交接并完成端到端权限验收。
- 2026-09-26 起只读交接已附带参考文件清单、细纲场景写作指导和 `PENDING_REFERENCE` 告警（见 t07 的 Schema 扩展节）；`writer.pro` 遇到告警不得自行补写相关知识。

## 合同

- [实施计划](../../implementation-plan.md)
- [writer.pro 交接 Spec](../../../../../docs/specs/outline/writer-handoff.md)
