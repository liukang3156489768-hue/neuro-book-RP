---
schema: nbook.task/v2
taskId: t02-domain-mapping-and-persistence-decision
---

# 领域映射与持久化决策

## 目标与范围

本 Task 完成大纲规划模块进入实现前的 Phase 0 核对：把产品设计映射到现有 Plot、Project Workspace、History、Agent Session、模型调用和 `writer.pro` 边界，并收敛可供 Phase 1 实现的文件 schema、稳定 ID、版本、事务、恢复和只读交接合同。

本 Task 不修改产品功能代码、Prisma schema、migration 或用户作品数据。结构化项目文件继续是规划模块唯一规范来源，SQLite 只能保存可重建索引；本模块与 Plot 互补，不复制 Plot 的 Scene 真相源。

## 授权来源与限制

- 来源：开发者已确认大纲规划模块进入正式开发规划，并确认结构化文件、SQLite 索引、方案 A/B 与 IF 线的区别、对象/关系删除、Agent 权限和 `writer.pro` 只读边界。
- 允许：只读调查现有代码、类型、测试、Reference、Project Workspace、History、Agent Session 和相关文档；修改本 Work、Proposal、planned Spec、ADR 和迁移/接口合同文档。
- 禁止：修改产品功能代码、Prisma schema、数据库 migration、用户作品数据或 `lorebook/`；调用真实模型；创建实现 worktree；提交、推送、创建 PR 或修改远端。

## 领域所有权映射

### 大纲规划模块拥有的对象

| 对象 | 规范来源 | 说明 |
|---|---|---|
| 全局总纲 | `outline/entries/*.md` + `manifest.yaml` | 每个作品规划范围内只有一个对象；多条方案链共同引用它 |
| 方案链及其 placement | `manifest.yaml` | 方案 A/B 表示作品的不同整体展开，不是线路图中的 IF 线 |
| 卷纲、章节大纲、细纲 | `outline/entries/*.md` | 大纲库中的灵感/方案对象；章节大纲与正文保持一对一的产品关系，但不写正文 |
| 伏笔定义 | `outline/foreshadowing/*.md` | 伏笔状态由正式章节大纲标记派生，正文不是状态来源 |
| 线路、节点、边和固定状态 | `outline/lines/*.yaml` | 线路规划负责严格的从左到右剧情顺序；固定节点是正文写作入口 |
| 规划 Agent 建议与操作预览 | 会话/历史和规划域操作记录 | 建议不等于事实；正式变更必须经用户确认或有效自动授权 |

### 现有 Plot 继续拥有的对象

代码调查确认以下对象仍由 Plot 服务和 Project SQLite 负责：`Story`、`StoryAct`、`StoryChapter`、`StoryThread`、`StoryScene`、`StoryPromise`、`StoryPromiseBeat`、`StoryDecision`、World Engine 关联以及 Writer Brief。主要入口包括：

- `packages/neuro-book/server/plot/facade/plot.facade.ts`
- `packages/neuro-book/server/plot/services/chapter-writer-brief.service.ts`
- `packages/neuro-book/server/plot/services/chapter-prose.service.ts`
- `packages/neuro-book/server/plot/contracts/plot-repositories.ts`
- `packages/neuro-book/prisma/project.schema.prisma`
- `server/api/projects/plot/[...segments].ts`

现有 Plot 的 `StoryChapter` 使用 SQLite 自增整数 ID；正文文件通过 frontmatter 的 `chapter` 名称反向关联。Plot 的 `StoryScene` 是 Plot 与 World Engine 的最小剧情连接点。`StoryPromise`/`StoryPromiseBeat` 具有读者债务/承诺语义，但不能直接充当新伏笔库的规范对象。当前 Plot 没有与本模块约定的稳定字符串 ID、内容版本、revision 或 etag。

**决策：** Phase 1 不向 Plot 表写入大纲、线路或伏笔，不复制 `StoryScene`，也不把 `StoryPromise` 改名为伏笔库。后续如需 Writer Brief 或 Scene 适配，建立单向、带版本的只读适配器，并单独补合同。

## 代码事实、文档事实与推断

### 已核实的代码事实

1. Workspace 文件服务已有 `readWorkspaceTextFile`、`writeWorkspaceTextFile`、`createWorkspaceFile`、`renameWorkspacePath`、`deleteWorkspacePath`；普通文本写入目前是直接文件写入，不能直接视为跨文件事务。
2. `ProjectFileIndexHandle.mutate()` 是 Project generation 下的文件 mutation gate；`runProjectFileMutation()` 会校验 exact ready generation，并按稳定顺序处理多项目锁，避免死锁。
3. `outline/` 属于普通 Project content，会被文件索引和 History 追踪；`.nbook`、`.agent`、运行时路径被忽略。外部文件编辑仍可能发生，因此读取时必须重新解析和校验，不能只相信 SQLite 索引。
4. History 由 Project Session generation 持有独立 handle，提供 `recordProjectWrite/Delete/Rename()`；记账是 fail-open，记账失败不阻断文件写入，watcher/reconcile 可补记 external。现有 `acceptAtRevision`、`acceptAllAtRevision`、`revertAtRevision`、`timeline`、`snapshotBody`、`textDiff` 是历史基线能力，不等同于规划域任意批次撤销。
5. Agent 事件支持 SSE；`writeAgentEventStream()` 处理 backpressure、abort、close/error 清理；已有 `write`、`edit`、`apply_patch` 文件工具。工具权限由服务端 `ToolExecutionContext` 等边界控制，不能只依赖 UI 隐藏按钮。
6. 现有 Writer Brief 入口为 `PlotFacade.getChapterWriterBrief(chapterId, mode)`、`GET /api/projects/plot/chapter-writer-brief` 和 `get_chapter_writer_brief` Agent tool；它的状态包含 `needs_plot`、`needs_world_anchor`、`needs_world_context`、`needs_chapter_brief`、`ready`。

### 已确认的文档/产品事实

- 大纲库是灵感和方案库，不负责严格剧情时间线；线路规划才负责正式编排和正文入口。
- 全局总纲只能有一个；方案 A/B 是同一作品的不同完整展开，方案链通过关系共同引用这个总纲。IF 线属于线路规划内部的树状分支，不能与方案 A/B 混同。
- 章节大纲可没有细纲；细纲正式存在必须绑定章节大纲；一个章节大纲可以有多个连续细纲。
- 章节大纲的伏笔标记只从大纲正文解析；伏笔状态不从正文获取。一个章节允许多次埋设/强化/回收，回收不能在有效埋设前发生；标记损坏时 fail-closed。
- 线路节点引用的大纲被删除时标红，被修改时标黄；重复节点阻断固定和正文编写。用户确认固定的节点及其正式关联内容才可交接给 `writer.pro`。
- Agent 只能读取当前项目 `lorebook/`，不能修改 `lorebook/` 或正文；规划模块自身可按模式和审批规则读写。删除始终需要审核，批量操作可一次确认并支持撤销。

### 推断与未验证项

- `ProjectFileIndexHandle.mutate()` 可作为单项目变更的串行入口，但当前代码尚未证明它自动提供多文件领域事务、恢复 journal 或规划域批次撤销；这些能力必须由 Phase 1 明确实现。
- `record-file.ts` 已提供单文件临时写入/原子替换能力，但 Phase 1 仍需确认可复用的公开 API、失败时清理策略和与 History 记账顺序。
- `.nbook/recovery/` 适合作为运行期 staging/journal 位置，因为现有路径策略和 History 将 `.nbook` 忽略；这不是用户可编辑的规范数据，恢复协议必须显式区分 staging 与已发布文件。
- 现有通用 Agent 文件工具不能直接当作规划 Agent 的权限白名单；必须在领域服务和服务端工具上下文同时限制目标路径、操作类型和删除审核。
- 本 Task 未运行真实模型、浏览器人工验收、数据库迁移、产品测试或多文件故障注入；上述内容留给 Phase 1 及后续 Task。

## 规范文件与稳定 ID

### 目录布局

```text
outline/
├── manifest.yaml
├── entries/
│   └── <slug>--<stable-id>.md
├── foreshadowing/
│   └── <slug>--<stable-id>.md
└── lines/
    └── <slug>--<stable-id>.yaml
```

规范文件使用 YAML + Markdown 组合。文件名用于可读性和定位，不承担对象身份；稳定 ID 写入 front matter 或 YAML 对象中，生成后不因移动、重排、改名、关系变化或版本递增而改变。建议使用带类型前缀的 UUID：`oe-`（outline entry）、`fo-`（foreshadowing）、`ln-`（line）、`nd-`（node）、`ed-`（edge）、`pl-`（placement）、`dg-`（detail）。写时分叉必须生成全新的对象 ID 和文件名，源文件不覆盖、不自动合并。

### `manifest.yaml` 最小字段

```yaml
schema: nbook.outline-manifest/v1
moduleVersion: 1
revision: 0
rootTotalOutlineId: oe-...
chains:
  - id: chain-a
    title: 方案 A
    description: ...
placements:
  - id: pl-...
    entryId: oe-...
    chainId: chain-a
    parentId: oe-...
    order: 10
files:
  entries: []
  foreshadowing: []
  lines: []
```

`rootTotalOutlineId` 必须唯一且存在；`placements` 表达方案链中的关系和顺序，允许同一条目被多个位置引用。方案链不能创建第二个总纲；关系删除只删除 placement，不删除对象文件。`revision` 是规划域的单调版本，可用于跨文件 CAS 和缓存失效；文件内容同时保存 `contentHash: sha256:...`，hash 由规范化序列化后的实际内容计算，不能从 SQLite 反推。

### Entry Markdown front matter 最小字段

```yaml
schema: nbook.outline-entry/v1
id: oe-...
kind: total | volume | chapter | detail
title: ...
lifecycle: draft | adopted
version: 1
contentHash: sha256:...
source: manual | generated | forked | imported
forkOf: null
chapterEntryId: null
createdAt: 2026-09-24T00:00:00Z
updatedAt: 2026-09-24T00:00:00Z
```

`kind: detail` 必须有 `chapterEntryId` 且不能独立成为线路节点；`kind: total` 只能等于 `manifest.rootTotalOutlineId`。章节正文、素材索引和 Markdown 伏笔标记放在 body；结构化字段必须在 front matter 中，不能只从显示文本推断。条目父子关系不只存单个 `parentId`，由 manifest placements 表达，以支持跨方案引用。

### 伏笔文件最小字段

```yaml
schema: nbook.foreshadowing/v1
id: fo-...
title: ...
status: draft | pending | planted | recovered
version: 1
contentHash: sha256:...
createdAt: 2026-09-24T00:00:00Z
updatedAt: 2026-09-24T00:00:00Z
```

`status` 只有用户可见的四种状态：草稿、待使用、已埋设、已回收。确认设计且没有有效正式埋设事件时为 `pending`；存在有效 `plant`/`reinforce` 且没有有效 `recover` 时为 `planted`；存在合法回收时为 `recovered`。标记损坏、未知 ID、顺序错误和分析过期作为异常诊断，不新增用户状态。来源记录至少包括章节条目 ID、标记 ID、action、条目版本/hash 和可追溯线路节点信息；状态不按方案链拆分。

### 线路 YAML 最小字段

```yaml
schema: nbook.outline-line/v1
id: ln-...
title: ...
version: 1
nodes:
  - id: nd-...
    entryId: oe-...
    entryVersion: 2
    entryHash: sha256:...
    fixed: false
    issue: null | deleted | modified | duplicate
    sequence: 10
    position: { x: 0, y: 0 }
edges:
  - id: ed-...
    from: nd-...
    to: nd-...
    type: main | branch | character | if
chains:
  - id: chain-...
    type: main | branch | character | if
    nodeIds: []
```

业务 `sequence`、有向边和链成员是规范事实；`position` 只能用于视图布局。数据层须拒绝环和逆序；一份正式规划版本至多有一条主线，一个节点可成为多类线路的起点，可有多个入边，但沿主线和 IF 线各自最多一个方向连接。程序负责确定性结构约束、删除/修改/重复引用检查；AI 只负责语义冲突建议，分析结果必须绑定输入版本/hash，输入变化即失效。

## 标记与派生边界

章节大纲正文采用已确定的 Markdown 标记：

```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->银纹<!-- /nb:foreshadow marker="fm-01" -->
```

`action` 仅允许 `plant`、`reinforce`、`recover`；文档内 `marker` 唯一。解析器遇到未成对注释、未知伏笔 ID、未知 action、嵌套冲突或不可确定线路顺序时，保留原文并报告诊断，不产生正式事件。用户 UI 可把有效范围渲染为下划线和注释悬浮；UI 不能自行修改伏笔状态。

顺序判断只使用线路中已固定节点的 `sequence`/边关系。大纲库展示顺序不参与伏笔先后判断。删除或修改标记后，服务必须从剩余正式章节大纲重新解析并派生状态，不能以正文或旧 SQLite 状态补齐。

## 对象删除、关系删除与版本

- **对象删除**：删除规范对象文件；总纲需要二次确认，任何被活动引用对象先锁定，显示所有 placement、线路节点、细纲、伏笔来源和正文交接影响。
- **关系删除**：删除 placement、父子关系、线路边、线路成员或节点到条目的引用；不删除对象文件。
- **移动/重排**：只改变关系或 `sequence`，不改变稳定 ID。
- **写时分叉**：共享条目在当前位置修改前弹窗确认；确认后创建新文件和新 ID，原对象与其他引用保持不变。
- **CAS**：正式写入必须携带读取时的 manifest revision、目标文件 version/hash；不匹配则拒绝并重新生成影响预览。
- **可撤销**：规划域批次记录变更前后的文件/关系快照和 CAS 条件；撤销不能覆盖用户之后的新版本，冲突时只生成预览并交用户处理。

## 跨文件事务、恢复与索引边界

Phase 1 的正式变更采用以下边界：

1. 捕获 exact ready Project generation，进入 `ProjectFileIndexHandle.mutate()`。
2. 读取并重新解析全部目标规范文件，校验 schema、引用、版本/hash 和 manifest revision。
3. 生成可审阅的变更/级联影响预览；删除和批量操作在提交前必须有确认。
4. 在 `.nbook/recovery/` 创建带 transaction ID、目标 revision、文件 hash 和操作状态的 staging/journal。
5. 对每个目标规范文件写入临时文件并校验，再按确定顺序原子发布；最后更新 manifest revision。
6. 发布成功后重建或增量刷新 SQLite 索引，并记录 Project History；SQLite 刷新失败不得反向覆盖规范文件，应标记索引待重建。
7. 全部成功后清理 staging；部分失败时保留 journal 和原文件，标记需要恢复，禁止把部分索引结果当作正式规划。

现有 History 的 accept/revert 不能代替上述规划域事务；History 仍负责可追溯文件历史，规划域需要自己的批次、CAS、预览和撤销记录。外部编辑、关闭重开或索引损坏时，始终从规范文件重新解析；索引不得反向覆盖文件。

## AI 分析、确定性校验与权限边界

- Markdown/YAML 语法、schema、引用存在性、唯一 ID、总纲唯一、层级关系、节点环/逆序/重复、主线唯一和标记成对性属于确定性校验。
- 细纲与章节大纲的偏差、线路语义冲突和修复建议属于 AI 分析；分析结果必须带输入版本/hash，超时、失败或过期不能当作通过。
- Agent 建议、自动操作和标记建议在用户认可前只能是草稿/待审阅内容。自动模式可执行授权的非删除规划变更；对象删除、关系删除和总纲删除必须审核，其中总纲删除二次确认。
- 规划 Agent 只能读取项目 `lorebook/`，写入白名单仅限规划域公开服务；禁止正文写入、禁止直接使用通用文件工具绕过规划校验。`writer.pro` 只能读取固定的正式线路节点、正式章节大纲/细纲及其允许的素材和伏笔上下文。

## `writer.pro` 只读交接合同

查询必须携带项目身份、线路 ID 和目标规划 revision/固定节点集合。服务端重新解析并检查：节点已固定；条目为正式采用；引用未删除、未修改、未重复；线路和分析结果仍对应当前版本。返回节点从左到右的 sequence、稳定 ID、条目版本/hash、章节大纲正文、正式细纲、素材索引、参考文件和有效伏笔来源。草稿、未固定节点、红色删除节点、黄色待重分析节点、重复节点和仅存在于大纲库未进入线路的内容必须排除或拒绝，并给出可解释原因。任何写入规划、正文或 `lorebook/` 的请求必须在服务端拒绝。

## Phase 1 实现门禁

下一阶段只实现规划存储基础：schema 常量与确定性 parser/validator、稳定 ID、manifest/entry/foreshadow/line repository、内容 hash、Project generation/CAS、跨文件 staging/journal、索引重建入口、影响预览和批次撤销基础。必须先写合同测试，至少覆盖：

- 新建/关闭/重开项目后从文件恢复；
- SQLite 索引删除后从文件重建，且不反向覆盖文件；
- 损坏 YAML/Markdown、未知引用、未知伏笔标记和 schema 版本失败关闭；
- 并发 revision/hash 冲突拒绝；
- 多文件发布部分失败可保留原文件并可恢复；
- 删除对象与删除关系行为分离，级联预览可解释；
- 撤销不覆盖之后的新修改；
- 线路结构字段与 UI 坐标分离。

Phase 1 不实现：大纲 UI、节点图 UI、Agent 全流程和模型调用、旧文档迁移、Plot 双写、正文写入、浏览器人工验收。

## 完成条件

- 已完成 Plot、Workspace、History、Agent、`writer.pro` 的代码事实与 owner 映射，并区分推断和未验证项。
- 已统一“全局唯一总纲 + 多方案链引用”的语义，清除“每条方案链拥有独立总纲”的冲突。
- 已明确 manifest、entry、伏笔和线路文件的最小字段、稳定 ID、版本/hash、派生边界和失败语义。
- 已明确跨文件正式保存、恢复、SQLite 重建、对象/关系删除、CAS、影响预览和撤销的边界。
- `bun run docs:check` 通过。

## 下一步

创建并执行 [t03-planning-storage-foundation](../t03-planning-storage-foundation/README.md)。它只实现上述 Phase 1 规划存储基础，不提前实现 UI、Agent 全流程、迁移或 Plot 双写。
