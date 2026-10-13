---
schema: nbook.spec/v1
kind: behavior
status: planned
capability: writing.prose-binding
owners:
  - writing
---

# 正文与规划的绑定

## 目标与非目标

本能力规定正文章节文件与大纲规划章节的对应关系：作品选定哪个方案写作、正文文件在哪里、正文记录依据哪一版规划写成，以及据此派生的章节写作状态。写作界面、写作工作流和问题回流都通过本能力判断“这一章能不能写、写没写、依据是否过期”。

本能力不修改大纲规划数据，不为多个方案各保存一份正文，不合并用户手改与重新生成的正文。

## 术语与参与者

- **写作方案**：作品当前用于写作的大纲库方案链。一个作品同时只有一个写作方案。
- **章节**：写作方案中的一个章节大纲条目，写作状态和写作会话都按它区分。章节的范围、归属的卷和先后顺序都以大纲库中该方案的层级为准。
- **本章细纲**：写作方案中挂在该章节大纲下的细纲，可以有一份或多份，按方案中的顺序排列。
- **正文文件**：`manuscript/` 下类型为 `chapter` 的文件。一章最多对应一份正文文件。
- **归属**：正文文件记录它属于哪个章节。
- **依据**：正文文件记录它最近一次由写作工作流完整生成时，所依据的写作方案、章节大纲和本章细纲的版本。
- **作品写作设置**：保存写作方案和当前文风文件的作品级数据。
- 参与者：用户（选择写作方案、手动关联、手改正文）；写作工作流（创建文件、写入正文和依据）；写作界面（显示状态）。

## 输入与前置条件

- Project 已打开且大纲数据可读。
- 作品写作设置（schema `nbook.writing-settings/v1`）保存在 Project 内，字段为 `writingPlanId`（写作方案 id，可为空）和 `stylePath`（当前文风文件路径，可为空）。第一次打开写作界面且没有写作设置时，写作方案为空，由用户选择。
- 章节是否可写，以规划只读交接（[outline.writer-handoff](../outline/writer-handoff.md)）的结果为准：交接能返回这一章的正式上下文就可写，否则不可写，并采用交接给出的原因。写作模块不自行推断条目采用或审阅状态。
- 线路规划暂时只供用户梳理剧情，本能力不读取线路、节点、格号或固定状态。

## 输出与可观察行为

### 正文文件的归属与依据格式

正文文件头在现有 `type: chapter` 之外增加 `writing` 字段：

```yaml
writing:
  schema: nbook.writing-source/v1
  chapterEntryId: <章节大纲条目 id>
  source:            # 最近一次完整生成的依据；手动关联的正文没有这一项
    planId: <写作方案 id>
    chapterVersion: <章节大纲版本>
    chapterContentHash: <章节大纲内容哈希>
    details:         # 本章细纲，按方案中的顺序
      - entryId: <细纲条目 id>
        version: <细纲版本>
        contentHash: <细纲内容哈希>
    generatedAt: <ISO 时间>
```

现有 `chapter:` 字段属于旧 Plot 系统，本能力不读取也不修改它。

### 正文文件的位置

- 某章第一次开始写作时，由写作工作流创建正文文件。
- 章节大纲的上级卷纲对应 `manuscript/` 下的一个卷目录（`type: volume`）；卷目录不存在时一并创建。
- 章节没有上级卷纲时，正文文件直接放在 `manuscript/` 下。
- 文件名和目录名取自创建当时的标题；同名时追加序号，不覆盖已有文件。
- 创建后路径保持不变：之后修改大纲标题或调整卷归属，都不移动已有正文文件。对应关系只看文件头里的 `chapterEntryId`，不看路径。

### 手动关联

- `manuscript/` 下没有归属、或归属的章节不在写作方案中的 `chapter` 文件，归入“未关联正文”。
- 用户可以把未关联的正文手动关联到一个尚无正文的章节。关联只写入 `chapterEntryId`，不写 `source`。
- 用户可以解除关联，解除后移除 `writing` 字段，文件本身保留。

### 章节写作状态

对写作方案中的每个章节派生一个状态：

| 条件 | 状态 | 是否可写 |
|---|---|---|
| 章节大纲是草稿 | 大纲未采用 | 否，灰显 |
| 没有细纲，或任一本章细纲不是已审阅的正式细纲 | 细纲未审阅 | 否，灰显 |
| 可写，没有正文文件或正文为空 | 未写 | 是 |
| 可写，有正文；没有 `source`，或 `source` 与当前版本一致 | 已写 | 是 |
| 可写，有正文，`source` 中章节大纲或细纲的版本、内容哈希与当前不一致，或本章细纲有增减 | 依据已过期 | 是 |
| 两份以上正文文件归属同一章节 | 归属冲突 | 否，直到用户解除多余的关联 |

- 灰显章节有正文时，正文仍可查看和编辑，状态旁同时标出“有正文”。
- 章节的先后按大纲库层级排列：先按方案中卷纲的顺序，卷内再按章节大纲的顺序；直接挂在方案下、不属于任何卷纲的章节排在最后。
- 状态随规划变化和正文文件变化重新派生，不持久化。

### 依据的更新

- 一次完整生成的全部场景都通过后，写作工作流写入新的 `source`。
- 局部改写、用户手改、续写中途停止都不更新 `source`。
- 状态变为“依据已过期”后不自动重写，由用户决定是否重新写作。

## 状态与转换

| 当前 | 事件 | 结果 |
|---|---|---|
| 写作方案为空 | 用户选择方案 | 写入作品写作设置，派生全部章节状态 |
| 写作方案 A | 用户切换为方案 B | 写入设置；归属章节不在 B 中的正文进入“未关联正文”，其余正文按 B 的当前版本重新判定 |
| 未写 | 写作工作流开始第一个场景 | 创建正文文件并写入 `chapterEntryId` |
| 任意有正文状态 | 完整生成完成 | 写入 `source`，状态为“已写” |
| 已写 | 细纲或章节大纲版本变化 | 依据已过期 |
| 未关联正文 | 用户手动关联 | 已写（无 `source`） |

写作方案的切换、手动关联和解除关联都是幂等的：重复执行同一操作不产生额外变化。

## 副作用与数据

- 写入作品写作设置文件。
- 创建正文文件和卷目录，写入和更新正文文件头的 `writing` 字段。所有写入都走项目的文件写入与历史快照，可在历史中撤销。
- 不写入任何大纲、线路或伏笔文件。
- `lorebook/` 只有一处例外：用户在写作设置里新增或删除文风时，程序按用户填写的内容写入或删除 `lorebook/instruction/` 下的文风文件，不经过模型。模型提示中的文风部分直接取当前选定文风文件的内容。

## 失败与恢复

- 大纲数据不可读或交接失败：所有章节显示为不可写并给出原因，已有正文仍可查看和编辑。
- `writing` 字段格式非法：该文件归入“未关联正文”并提示格式错误，不猜测归属。
- 写作方案 id 在大纲中已不存在：视为写作方案为空，提示用户重新选择。
- 创建正文文件失败：写作工作流在第一个场景之前停止，不留下半成品文件。

## 边界与兼容

- 本能力只读取规划，不写入规划；章节是否可写完全以规划只读交接为准。
- 大纲写时分叉产生的新条目 id 与原条目不同：切换到使用分叉条目的方案后，原正文进入“未关联正文”，可以手动关联。本能力不追踪分叉来源。
- 不迁移旧数据；现有 `manuscript/` 文件保持原样，只是暂时没有归属。

## 验收与 Smoke

- Given 写作方案已选且某章可写且无正文，When 写作工作流开始该章第一个场景，Then 在对应卷目录下创建 `type: chapter` 正文文件，文件头 `writing.chapterEntryId` 指向该章，没有 `source`。
- Given 一次完整生成的全部场景通过，Then 正文文件头写入与当时交接版本一致的 `source`，章节状态为“已写”。
- Given 状态为“已写”，When 细纲被修改并重新审阅，Then 状态变为“依据已过期”，正文内容不变。
- Given 用户改写一段或手改正文，Then `source` 不变。
- Given 章节大纲回到草稿，Then 该章灰显为“大纲未采用”，已有正文仍可打开编辑。
- Given 某章节大纲已采用、细纲已审阅，但没有关联任何线路节点，Then 该章可写。
- Given 两份正文文件的 `chapterEntryId` 相同，Then 该章显示“归属冲突”且不可写，直到解除一份关联。
- Given 修改章节大纲标题，Then 已有正文文件路径不变，对应关系不变。
- Given 切换写作方案且新方案不含某章，Then 该章正文进入“未关联正文”，文件内容不变。

Smoke：打开示例项目，选择写作方案，确认左栏的卷、章顺序与大纲库该方案一致，各章状态与交接结果一致；对一章完成写作后修改其细纲，确认状态变为“依据已过期”。

## 实现合同

### 模块与接口

- 纯逻辑在 `server/writing/prose-binding.ts`，ready Project 读写在 `server/writing/host.ts`，DTO 在 `shared/dto/writing.dto.ts`。
- HTTP 入口是 `server/api/projects/writing/[...segments].ts`：
  - `GET overview`：只读概览。
  - `POST set-plan {planId|null}`：切换写作方案。
  - `POST set-style {stylePath|null}`：设置文风文件。
  - `POST create-style {title}`：新增文风文件，返回 `{overview, stylePath}`。
  - `POST delete-style {stylePath}`：删除文风文件；有进行中的写作运行时拒绝（`RUN_ACTIVE`）。
  - `POST link-prose {path, chapterEntryId}`：手动关联。
  - `POST unlink-prose {path}`：解除关联。
- 请求体严格校验，多余字段拒绝。
- 创建正文文件（`createReadyProseFile`）和写入依据（`writeReadyProseSource`）只供写作工作流在服务端调用，不开放 HTTP。

### 数据位置与格式

- 作品写作设置文件是项目根的 `writing/settings.yaml`（`nbook.writing-settings/v1`，字段 `writingPlanId`、`stylePath`）。它不放在 `.nbook/`，因为 `.nbook/` 不进入历史，放在 `writing/` 下才能和 `outline/` 一样在历史中撤销。
- 所有写入经 `tracked-workspace-files` 记入历史，并在项目文件索引的 mutation 中串行执行。
- 概览每次直接扫描 `manuscript/`，不用文件索引缓存：缓存有防抖，在 mutation 内读取可能是旧值。
- 正文文件的 `writing` 字段：
  - `chapterEntryId` 只接受 `ol-` 前缀 ID。
  - `source` 必须完整，含 `planId`、章节版本与 hash、全部细纲的版本与 hash，以及带时区的 `generatedAt`。
  - 任何多余或缺失字段都视为格式非法。
- 改写 `writing` 字段时只在 YAML 文档上改这一个键，保留注释、其他字段、换行风格和正文。
  - 删除最后一个键时留下空文件头 `---\n---`。
  - 文件头无法解析时拒绝写入（`FRONTMATTER_INVALID`）。
- 卷目录的 `index.md` 带标记 `writing: {schema: nbook.writing-volume/v1, volumeEntryId}`。

### 状态派生

- 章节状态按以下优先级取第一个命中项：
  1. 多于一份正文：归属冲突。
  2. 交接给出的阻断原因：大纲未采用，或细纲未审阅。
  3. 没有正文，或正文为空白：未写。
  4. 没有 `source`，或 `source` 与当前交接依据一致：已写。
  5. 其余情况：依据已过期。
- 比较依据时不比较 `planId`：同一章在两个方案中的章节与细纲版本相同时，不算过期。
- 归属冲突的章节不可写，其余章节沿用交接的可写性。
- 写作方案状态分四种：`unset`、`missing`（方案已删）、`unreadable`（大纲不可读）、`ready`。
  - 除 `ready` 外都不列章节。
  - 已有正文进入未关联正文，原因为 `plan-unavailable`。
- 未关联正文的原因：
  - `no-link`：没有 `writing` 字段。
  - `invalid-link`：格式非法，附带说明。
  - `not-in-plan`：归属章节不在当前方案中，附带原章节 ID。
  - `plan-unavailable`：方案不可用。
- 设置文件非法时，概览返回 `settingsError` 并按空设置处理；下一次设置会整体覆盖，原内容保留在历史中。

### 手动关联与文风文件

- 关联：
  - 已关联到同一章时不写入。
  - 已归属当前方案内另一章时拒绝（`PROSE_LINKED`），须先解除；归属不在方案中的正文可以直接改挂。
  - 目标章已有正文时拒绝（`CHAPTER_HAS_PROSE`）。
  - 手动关联只写 `chapterEntryId`。
  - 关联到不可写章节是允许的。
- 解除：移除整个 `writing` 字段，包括格式非法的字段；没有该字段时不写入。
- 文风文件路径必须位于 `lorebook/instruction/` 下、以 `.md` 结尾且不含 `.` 或 `..` 段，否则报 `INVALID_PATH`。文件头还必须是 `type: instruction`、`subtype: writing-style`，否则报 `STYLE_INVALID`。
- 新增文风：
  - 标题去首尾空白后 1 到 80 字；目录名按正文目录同样的规则净化，同名追加 `-2`、`-3`。
  - 写入 `lorebook/instruction/writing-style/<目录名>/index.md`，文件头为 `type: instruction`、`subtype: writing-style`、`status: active`、`tags: [文风]`、不参与检索；正文是标题、一行说明和空的 `## 文风要求`、`## 禁用写法`、`## 样文` 三个小节。
  - 尚未选择文风时同时选中新文风；已有选择时不改。
  - 新文风的“文风要求”为空，写作开始前会按 `style` 停止，用户需先补写。
- 删除文风：
  - 路径与文件头按上面的规则校验。
  - 条目目录（`.../index.md`）里除 `index.md` 外还有其他文件时拒绝（`STYLE_INVALID`），不连带删除用户资料；单文件文风直接删除。
  - 删除走文件历史，可以恢复；删的是当前文风时同一次操作清空 `stylePath`。

### 创建正文与写入依据

- 创建正文前依次检查：该章已有正文（`CHAPTER_HAS_PROSE`），再检查章节不可写（`CHAPTER_NOT_WRITABLE`）。
- 卷目录的确定顺序：
  1. 带对应卷标记的目录。
  2. 同卷已关联正文所在的唯一卷目录。
  3. 都没有时在 `manuscript/` 下新建。
  - 没有卷的章节直接放在 `manuscript/` 下。
- 目录命名：
  - 名字取自标题，替换非法字符，去掉首尾的点和空格，最长 80 字。
  - Windows 设备名前加 `_`。
  - 同级重名（不区分大小写）时追加 `-2`、`-3`……
  - 改标题不移动已有文件。
- 创建失败时的清理：
  - 删除本次写入且内容未被改动的章节 `index.md` 和空目录。
  - 删除本次新建的卷目录。
- 写入依据前依次检查：
  - 设置中的方案与请求不同，或交接依据已变化：`BASIS_CHANGED`。
  - 章节被阻断：`CHAPTER_NOT_WRITABLE`。
  - 没有正文：`PROSE_NOT_FOUND`；多份正文：`OWNERSHIP_CONFLICT`。
  - 检查通过后只改写 `writing` 字段。

### 错误映射

| HTTP 状态 | 错误码 |
|---|---|
| 404 | `PLAN_NOT_FOUND`、`CHAPTER_NOT_IN_PLAN`、`PROSE_NOT_FOUND` |
| 400 | `INVALID_PATH` |
| 409 | `CHAPTER_HAS_PROSE`、`PROSE_LINKED`、`OWNERSHIP_CONFLICT`、`BASIS_CHANGED` |
| 422 | `PLANNING_UNREADABLE`、`CHAPTER_NOT_WRITABLE`、`STYLE_INVALID`、`FRONTMATTER_INVALID` |

错误码放在 `data.code` 中返回。

### 验证与状态

- 以上合同由 `server/writing/prose-binding.test.ts`、`server/writing/host.test.ts` 和 `server/api/projects/writing/route.test.ts` 覆盖。
- 2026-09-30 [t10](../../../.agents/works/w00019-writing-module/tasks/t10-acceptance/README.md) 在示例项目中验证：真实模型写作新建的正文位于方案位置并带依据记录；界面把未关联正文关联到尚无正文的章节，候选排除已有正文的章节；`unlink-prose` 接口解除后去掉 `writing` 字段、保留文件，重复解除不报错。
- 未决：正常归属某章的正文在界面上没有解除关联入口（见 [writing.workspace-ui](workspace-ui.md) 的限制），与“用户可以解除关联”的描述是否一致待开发者决定。
- 状态提升为 implemented 需开发者确认，本 Spec 维持 planned。

## 证据

- [Proposal](../../proposals/writing-module.md)
