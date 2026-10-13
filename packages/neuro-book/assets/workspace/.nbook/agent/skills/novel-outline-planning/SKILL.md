---
name: novel-outline-planning
description: 大纲规划模块的操作合同：规划工具、素材按需读取、方案改编记录与各级大纲正文。
when_to_use: 规划助手和规划专家读写大纲库、伏笔、线路或运用素材改编时；其他 Agent 用本文判断规划权限边界。
---

# 大纲规划操作合同

大纲库的规范数据是 `outline/` 下的文件，但 Agent 不直接读写这些文件。所有读取和修改都走规划工具，由服务端负责 ID、版本、状态和一致性校验。

## 先确认有没有规划工具

规划工具是 `get_planning_context`、`preview_planning_change`，以及规划助手的 `apply_planning_change` 或专家的 `commit_planning_change`。

- 有这些工具：按本文操作。
- 没有这些工具（例如通用写作助手）：不要用 `write`、`edit` 或 `bash` 创建或修改 `outline/` 下的文件，手写的文件会绕过校验，也可能直接让整个规划快照读取失败。可以在对话里和用户讨论构思、起草正文文本，然后请用户到大纲工作台的“规划助手”里保存。

## 数据模型

- **总纲 `total`**：全作品唯一，所有方案共用。
- **方案链 `plan-*`**：同一作品的一种完整展开。每条方案链从总纲开始，用 placements 记录“哪个条目挂在哪个父级下、排第几”。
- **条目 `ol-*`**：`volume` 卷纲、`chapter` 章节大纲、`detail` 细纲。
- **层级只能是**：总纲下挂卷纲或章节；卷纲下挂章节；章节下挂细纲。细纲不能挂在卷纲或总纲下。
- **状态只有两种**：`draft` 草稿和 `adopted` 正式采用。新建和任何编辑都会变成草稿，并清掉细纲的分析报告。
- **服务端决定的字段**：`id`、`version`、`status`、`chapterId`、`schema` 都不由你填写，也没有 frontmatter 可写。你只提供标题、正文和下文列出的元数据字段。
- **共享条目**：同一条目可以挂进多条方案链。这时 `get_planning_context` 详情里的 `planIds` 会多于一个。

## 读取

1. 先调用 `get_planning_context`（不带参数），拿到 `revision`、`totalId`、方案链与 placements、全部条目摘要（含 `parentId`、`version`、`contentHash`，不含正文）、伏笔状态、线路图和线路。
2. 需要正文或元数据时，再调用一次并传入 `entryIds`，每次最多 16 个。`details` 里是完整正文、元数据字段、`planIds`，章节的伏笔标记，以及细纲的分析摘要。
3. 伏笔相关的章节正文与标记用 `get_foreshadowing_context` 读取（只有规划助手、大纲专家、伏笔专家有这个工具）。
4. 素材先用 `list_planning_materials` 取得分页概览，再用 `read_planning_material` 读取选中的文件。角色、笔记索引与当前方案记录的读取规则见已加载的[素材运用与改编指南](references/material-adaptation.md)。

## 写入流程

每次写入都是一次“预览 → 执行”：

1. 用 `preview_planning_change` 预览：`{operation: "mutate", expectedRevision: <当前 revision>, action: {...}}`。预览会做完整校验，返回 `proposalId`。
2. 执行时把同样的参数加上 `proposalId` 交给 `apply_planning_change` 或 `commit_planning_change`：`{changes: [{operation, expectedRevision, action, proposalId}]}`。参数必须与预览时完全一致，任何改动都会让预览失效。
3. 执行结果逐项给出 `applied` 或 `failed`。新建的条目和方案链会在结果里返回 `entryId` / `planId`，后续步骤用这些 ID。

要点：

- **每次成功写入都会让 `revision` 加 1**，预览要求 `expectedRevision` 等于当前值。所以一次只预览一项变更，执行成功后用新的 revision（等于预览返回的 `nextRevision`）预览下一项。不要在同一个 revision 上预览多项再批量执行，第二项起都会失败。
- 条目编辑还要带 `expectedVersion` 和 `expectedContentHash`，取自最近一次读到的该条目。写入后它们都会变，继续编辑同一条目前要重新读取。
- 失败时如实说明原因。遇到“版本已变化”就重新读取，确认改动仍然成立后再预览，不要反复重试到成功为止。
- 规划助手执行写入需要用户批准；专家只在被委派的“产出”任务范围内提交。删除、解除挂载、线路操作只有规划助手能做，且必须经过删除预览和用户确认。

## 条目动作

| 动作 `kind` | 用途 | 关键参数 |
| --- | --- | --- |
| `create-plan` | 新建方案链，同时新建该方案自己的空总纲，返回的 `entryId` 就是总纲 ID | `title`（不能与已有方案同名） |
| `associate-total` | 让方案改用另一方案的总纲（手动共用）；方案当前总纲有正文时须 `confirmReplace` | `planId`, `totalId`, 可选 `confirmReplace: true` |
| `unshare-total` | 解除总纲共用，为该方案分叉出专属总纲 | `planId` |
| `rename-plan` | 改方案链名称 | `planId`, `title` |
| `create-entry` | 在某方案链的父级下新建草稿 | `planId`, `parentId`, `entryKind`, `title`, `body`, 可选元数据 |
| `edit-entry` | 修改标题、正文或元数据 | `planId`, `entryId`, `expectedVersion`, `expectedContentHash`, `title`, `body`, 可选元数据 |
| `adopt-entry` | 把草稿的总纲、卷纲、章节正式采用 | `planId`, `entryId`, `expectedVersion`, `expectedContentHash` |
| `move-entry` | 换父级（同一方案链内） | `planId`, `entryId`, `parentId`, `expectedVersion`, `expectedContentHash` |
| `attach-entry` | 把已有条目挂进另一条方案链，形成共享 | `planId`, `parentId`（须是条目原父级且已在该方案中；原父级是总纲时用目标方案自己的总纲）, `entryId` |
| `reorder-entry` | 调整同级顺序 | `planId`, `entryId`, `siblingIndex`（从 0 开始） |

从零搭建时的顺序是：`create-plan`（返回方案总纲 ID）→ 逐级 `create-entry`。后一步要用前一步返回的 ID，所以只能逐项执行。每个方案有且只有一个总纲；总纲被多个方案共用时不能原地修改，需用户确认写时分叉，或用 `unshare-total` 解除共用。

`edit-entry` 的语义：

- `body` 是整体替换。先用 `entryIds` 读出当前正文，在它的基础上修改；只改一处时，其余文字、伏笔标记和细纲标注都要原样保留。
- 元数据字段不传表示保持原值，传 `null` 表示清空，传新值表示整体替换。
- 编辑已采用的条目会把它退回草稿。如果该条目（或已采用细纲所属的章节）在已固定的线路里，那条线路会被解除固定。执行前要告诉用户这个影响。

## 元数据字段

| 字段 | 含义 | 规则 |
| --- | --- | --- |
| `materialRefs` | 本条目用到的素材索引 | 项目内相对路径，如 `lorebook/character/lin-chen.md`，不能重复；只写实际存在的文件 |
| `writingGuidance` | 整条条目的写作指导 | 非空文本；细纲不用 |
| `references` | 参考文件 | `{path?, locator?, purpose?, pending?}`；非待补项必须有 `path`；细纲不用 |
| `targetWords` | 目标字数 | 正整数；细纲不用，细纲的目标字数写在正文的章节总览里 |
| `adaptation` | 章节的稳定来源锚点 | 单章为 `{kind: "chapter", sourcePlanId, sourceEntryId}`；两章之间原创为 `{kind: "between", sourcePlanId, beforeEntryId, afterEntryId}`。只用于 `chapter`，细纲从父章节读取；来源与目标是不同方案 |
| `materialUpdates` | 随条目保存的方案改编信息 | 数组项为 `{materialPath, kind, body}`；`materialPath` 是真实已有角色、物品或地点的主 `index.md`，`kind` 为 `experience`、`relationship`、`item`、`location`；记录由服务端保存，无通用文件写入 |

找不到真实来源时，参考项写 `pending: true`，用 `locator` 说明需要什么资料，不编造路径。“待补”不阻止采用，但会在分析和正文交接中作为告警出现。细纲没有素材继承机制：交接给正文时章节与细纲各带自己的清单，细纲场景用到的资料写在细纲正文各场景的参考资料里。

`adaptation`、`materialUpdates` 可随 `create-entry`/`edit-entry` 提交。编辑不传保持已有值，`null` 清空；传 `materialUpdates` 新数组会整体替换该条目的关联记录，所以先读取已有元数据，保留仍然成立的记录。规划正文与改编记录使用同一次预览和执行，同步失败不能报告为全部成功。改编记录是方案计划，不是已发生事实；基础资料和提取的经历、关系不可修改，缺少对象须请用户先去设计工作台创建。

已有 `materialUpdates` 且正文发生变化时，必须显式提交核对后的完整 `materialUpdates`，或传 `null` 撤下记录；不能省略字段而保留可能已失效的经历、关系或状态。只改标题、状态且剧情正文不变时可以省略保留。

## 只能在工作台完成的操作

下面这些操作没有 Agent 工具。遇到时说明原因，请用户在大纲工作台操作，然后你再继续：

- **修改或移动共享条目**：非总纲的共享条目不能原地编辑或移动，服务端会拒绝。需要用户在工作台确认“写时分叉”，得到一个新 ID 的副本后再编辑副本。总纲是例外：编辑时传 `confirmGlobal: true`，并事先告诉用户改动会影响所有方案。
- **细纲正式采用**：细纲必须先在工作台运行偏差与冲突分析，由用户处理冲突后采用。`adopt-entry` 对细纲会直接失败。你的职责是把细纲写成可以通过分析的草稿。分析的前提是：所属章节已正式采用；细纲只挂在一条方案链里。
- **线路分析与固定**：规划助手可以编辑线路图、创建和编辑草稿线路、重开固定线路、切换主线，但分析和固定线路要由用户在工作台完成。

## 伏笔

- 伏笔对象 `fo-*` 用 `create-foreshadowing` 建草稿（`title`、`body`，可选 `surface`、`connection`、`plant{situation, presentation, subtlety}`、`recover{condition, echo, effect}`）。用 `edit-foreshadowing` 修改，用 `confirm-foreshadowing` 把草稿确认为待使用。这几个动作同样走预览和执行。
- 伏笔的埋设、强化、回收是章节大纲正文里的标记：`<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->原文<!-- /nb:foreshadow marker="fm-01" -->`，`action` 取 `plant`、`reinforce` 或 `recover`。
- 标记只能出现在章节大纲正文里。增删或修改标记用 `get_foreshadowing_context` 读取，用 `suggest_foreshadowing_marker` 生成带校验的候选，再把它返回的变更原样执行。`action` 取 `plant`（新增埋设标记，章节还没有任何标记时也用它）、`strengthen`（新增强化标记）、`resolve`（新增回收标记）；只有诊断出损坏标记的章节才用 `repair`。
- 伏笔要先用 `confirm-foreshadowing` 确认为待使用，它的标记才计入伏笔状态，也才会交给写作模块；草稿伏笔的标记可以先写，但写作时不会被执行。
- 伏笔状态（草稿、待使用、已埋设、已回收）由正式章节中的标记派生，不能直接设置。回收要晚于有效埋设。
- 用 `edit-entry` 改章节正文时，已有标记原样保留，不顺手增删。

## 正文怎么写

各级正文的结构与篇幅参考（`outline-templates.md`）已由 Profile 加载进上下文。它位于安装资产目录，不在当前 Project 内，已经在上下文中，不要用素材工具按文件路径读取。

总纲、卷纲、章节大纲的模板是写作建议，服务端不检查标题结构。细纲不同：它的正文就是写作模块的输入，必须按模板书写，结构不合格时不能分析、采用和写作。
