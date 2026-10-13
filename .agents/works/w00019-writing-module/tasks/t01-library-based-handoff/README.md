---
schema: nbook.task/v2
taskId: t01-library-based-handoff
---

# 交接改为按大纲库读取

## 目标与范围

按 [outline.writer-handoff](../../../../../docs/specs/outline/writer-handoff.md) 把规划只读交接从按线路读取改为按写作方案的大纲库层级读取。这是写作模块其余切片的数据入口。

要交付的只读能力有两项：

1. **章节目录**：输入写作方案 id。
   - 按层级顺序返回全部章节大纲：先按卷纲顺序，卷内按章节顺序，不属于任何卷纲的章节排在最后。
   - 每章返回：id、标题、版本、内容哈希、所属卷纲，以及本章细纲的 id、版本、内容哈希。
   - 每章给出是否可写；不可写时给出原因，分两种：大纲未采用、细纲未审阅（包括没有细纲）。
2. **章节上下文**：输入写作方案 id 和章节大纲 id，可以附带上次读到的版本。
   - 可写时返回：章节大纲；按方案顺序排列的本章细纲，以及其中的写作指导、段落标注（带被标注原文）和参考清单；章节大纲中已确认伏笔的标记（原文、动作、伏笔 id 与版本，不含定义正文）；`PENDING_REFERENCE` 告警。
   - 附带的版本已变化时，返回当前版本和变化标记。
   - 不可写时拒绝，并给出与章节目录相同的原因。

另外，素材读取改为以章节为单位：按正式条目的参考清单读取素材，并保留来源审计。

## 非目标

- 不修改线路规划本身，也不修改伏笔四状态的派生。伏笔库和线路图的显示照旧按线路计算。
- 不做写作模块的任何其他部分（正文绑定、工作流、界面）。
- 不保留按线路读取的旧查询。它目前没有任何消费方，直接替换，不做兼容。

## 现状与改动落点（从代码推断）

- 以下几处都按线路读取，需要改：
  - `packages/neuro-book/server/outline/writer-context.ts`：`readWriterOutlineContext` 以线路为入口，校验线路 version/hash，通过 `readValidFixedLineNodes` 取节点，伏笔按 `deriveForeshadowingStates` 的线路来源筛选；
  - `packages/neuro-book/server/outline/writer-materials.ts`：素材来源带 `nodeId`；
  - `packages/neuro-book/server/outline/host.ts`：`readReadyWriterOutlineContext` 的入参是 `LineAnalysisRequest`；
  - `packages/neuro-book/server/api/projects/outline/[...segments].ts`：`read-writer-context` 的请求体是 `WriterContextBody`，扩展自 `LineAnalysisBody`。
- 以下部分与线路无关，可以沿用：
  - 细纲按方案挂载关系选取；
  - `assertDetailReviewed` 的审阅校验；
  - `projectEntry` 的投影；
  - 段落标注带原文；
  - `pendingReferenceWarnings`；
  - 伏笔来源不带定义正文。
- 伏笔标记需要从章节大纲正文中直接解析，并只保留已确认伏笔的标记。这一步不经过线路来源。
- 需要同步修改的测试：`writer-context.test.ts`、`host.test.ts`、`route.test.ts`、`http.contract.test.ts` 中与交接相关的用例。

## 验证

- 聚焦测试覆盖 Spec 的全部验收条目。特别要测：章节不在任何线路上也可写；已关联节点标红或标黄时，结果不受影响。
- 大纲模块的聚焦测试和应用 `typecheck` 通过。
- 完成后，把 [writer-handoff.md](../../../../../docs/specs/outline/writer-handoff.md) 的“实现合同”改为新实现的事实；[line-planning.md](../../../../../docs/specs/outline/line-planning.md) 中“交接查询待替换”一句同步删除。

## 当前状态

2026-09-29 实现完成。

- 新接口 `read-writer-chapters` 与 `read-writer-chapter-context` 取代 `read-writer-context`，实现事实见 Spec 的“实现合同”节；素材来源不再带 `nodeId`。
- 实现中发现细纲审阅绑定整个方案，审阅同章第二份细纲会让第一份回到草稿。开发者 2026-09-29 同意收窄：`detail-analysis.ts` 新增 `detailReviewScope`，审阅提示与 `contextHash` 只含总纲、卷纲、章节大纲和细纲挂载；`analysis-invalidation.ts` 只在该链变化或细纲挂入其他方案时撤回。规则写入 [outline.planning-library](../../../../../docs/specs/outline/planning-library.md)。
- 验证：`server/outline`、`server/api/projects/outline`、`server/agent/tools/planning-tools.test.ts` 与 `app/components/novel-ide/outline` 共 29 个文件 244 项通过（首轮有 1 个文件未通过且未输出失败用例，重跑全部通过，疑似偶发）；应用 `typecheck` 在 `NODE_OPTIONS=--max-old-space-size=8192` 下通过，默认堆内存会 OOM。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不碰 `server/api/projects/lorebook/` 和 `server/outline/format.ts.backup`。
