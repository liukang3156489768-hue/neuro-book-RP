# 细纲写作指导与段落参考标注

**状态**：已废弃（2026-10-01），2026-10-04 归档。细纲改为正文模板，写作指导与参考资料写在各场景的小节里，段落标注、frontmatter `guides` 与带 `marker` 的段落参考已移除。现行设计见 [细纲模板](../../../../../docs/specs/outline/outline-entry-templates.md) 的「细纲」。本文件只保留历史取舍，不再是行为依据。
**相关模块**：大纲规划模块、Markdown 编辑器
**行为真相源**：正式合同以 [大纲库](../../../../../docs/specs/outline/planning-library.md) 和 [正文交接](../../../../../docs/specs/outline/writer-handoff.md) 为准。本文件记录已退出的标注设计与取舍，后文的语法、字段及代码位置均为历史描述。

## 目标

细纲里的某一段原文可以单独附上两类信息，writer 写这段时不用猜：

- **写作指导**：这段怎么写，例如展开还是略写、视角、情感、语气、节奏和篇幅。
- **段落参考**：写这段要查的资料，例如招式、地点、既有章节。

整条细纲的指导和资料仍用条目级的 `writingGuidance` 和不带 marker 的 `references`。段落级标注只用于局部要求与整条不同的地方。

## 语法

正文用成对注释包住被标注的细纲原文，写法与伏笔标记 `nb:foreshadow` 同属一个 `nb:` 家族：

```markdown
<!-- nb:guidance marker="g-01" -->父亲欲言又止，最终只是拍了拍林辰的肩膀。<!-- /nb:guidance marker="g-01" -->
林辰使出<!-- nb:reference marker="r-01" -->林家剑法第三式“流光”<!-- /nb:reference marker="r-01" -->。
```

- 开头和结尾的注释都只带 `marker` 一个属性，两端的 marker 必须一致。marker 只能由字母、数字、`-`、`_` 组成，在同一细纲内唯一。
- 包住的内容是细纲原文，不能为空，也不能跨段落。说明文字写在元数据里。
- 同类标注不能嵌套或交叉。写作指导和段落参考之间可以完整包含或并列，不能交叉。富文本编辑器会把交叉的标注拆成两段，同一个 marker 会出现两次。
- 只允许出现在细纲（`detail`）。其他层级的正文出现这类标注时，整条被拒绝。

选择注释而不是 `<guide>` 这类自定义标签，是因为注释在任何 Markdown 渲染器里都不可见，并且与伏笔标记共用同一套解析和编辑器处理方式。

## 元数据

元数据写在条目 frontmatter 中，按 marker 与正文对应：

```yaml
guides:
  - marker: g-01
    instructions: 用动作带出父亲的复杂情绪，不直接写心理
    emotion: 隐忍
    words: 300
references:
  - marker: r-01
    path: lorebook/combat/lin-sword-style.md
    locator: 第三式“流光”
    purpose: 确认招式名称与效果
  - path: lorebook/locations/lin-manor.md
    purpose: 整场的场景布局
```

- `guides[]` 的字段是 `marker`、`instructions`（必填），以及可选的 `scene`、`words`（正整数）、`perspective`、`emotion`、`tone`、`pacing`。不接受其他字段。`words` 是这一段的篇幅预算，不参与和 `targetWords` 的求和校验。
- 段落参考复用 `references`：带 `marker` 的项是段落参考，不带 `marker` 的项仍是条目级参考。字段和“待补”规则与条目级参考相同：非待补项必须有 `path`，待补项用 `locator` 说明需要什么资料。

段落参考不单独设字段，因为它和条目级参考的数据形状、路径校验、“待补”告警和素材读取完全一致，拆开只会让两份清单各自校验一遍。

## 校验

`parseEntryMarkdown` 是唯一的校验点，fail-closed，任何一条不满足都会拒绝整条条目，不部分写入：

- 注释语法损坏、未闭合、带多余属性，或 marker 不合法、重复。
- 标注为空、跨段落、同类嵌套或交叉，或者写作指导与段落参考交叉。
- 标注出现在细纲以外的层级。
- 正文有标注但元数据里没有对应项（`MISSING_ANCHOR_METADATA`）。
- 元数据里带 marker 的项在正文中找不到标注（`ORPHAN_ANCHOR_METADATA`）。
- `guides` 有未知字段、必填字段为空，或 `words` 不是正整数。

新建、编辑、写时分叉，以及 HTTP 和 Agent 工具入口，都会把候选内容交给这个 parser。入口本身只收窄字段形状。

## 下游消费

- **正文交接**：`WriterOutlineEntry.guidance` 按正文顺序列出每个写作指导，内容是它的元数据加上被包住的原文 `text`。`references` 中的段落参考附带 `anchorText`，也就是被包住的原文。writer 由此知道每条要求或资料对应哪一段。
- **素材读取**：段落参考与条目级参考一起读取来源。同一路径被多段引用时按条目去重。待补项照常以 `PENDING_REFERENCE` 告警返回。
- **写时分叉**：未显式覆盖时沿用源条目的 `guides`。

## 编辑界面

工作台细纲表单没有查看态和编辑态之分，正文是富文本编辑器（`OutlineRichTextEditor`），改动自动保存：

- 在正文里选中一段文字，浮动菜单中点“写作指导”或“段落参考”，插入一对标注，marker 自动生成。被标注的原文在正文里直接高亮。
- 光标落在标注内时，浮动菜单列出该处的标注，可以“填写说明”（跳到下方对应的说明卡片）或移除标注。移除时保留原文。
- 正文下方按正文顺序列出所有标注的说明卡片，显示被标注原文的摘录和对应字段，可以回到正文选中原文，也可以删除标注。
- 从正文删掉的标注，草稿仍保留在表单里，撤销后内容能回来；保存时只发送正文中仍存在的 marker。
- 编辑器先拦截必然被服务端拒绝的选区（例如与已有标注交叉，或与加粗、斜体部分重叠），最终合法性仍以服务端为准。

通用 Markdown 编辑器（TipTap）与细纲表单共用同一套标注 Mark。Mark 只保存 marker，元数据留在表单状态里按 marker 查找，只在保存时写回 frontmatter。

## 不做与延后

- 在界面中选择 lorebook 条目：延后，路径目前手填。
- 保存时校验参考路径是否存在：不做。路径不存在的资料应标记为“待补”。
- 基于标注的局部重写：不在本设计范围内。

## 废弃

旧设计中的 `<guide id>`、`<reference id>` 标签、`detailReferences` 字段，以及把 `scene`、`words` 写在 `nb:guidance` 注释属性里的写法，都已删除，不提供读取兼容。这些格式只出现在开发期数据中。

## 代码位置

- 解析与校验：`packages/neuro-book/server/outline/format.ts`（`parseEntryMarkdown`、`parseOutlineAnchors`）
- 共享语法：`packages/neuro-book/shared/markdown-workbench.ts`（`collectMarkdownOutlineAnchors`、`renderMarkdownOutlineAnchor`）
- 正文交接：`packages/neuro-book/server/outline/writer-context.ts`
- 工作台表单：`packages/neuro-book/app/components/novel-ide/outline/OutlineEntryForm.vue`、`OutlineDetailAnnotations.vue`、`packages/neuro-book/app/utils/outline/outline-detail-annotation-form.ts`
- 编辑器 Mark：`packages/neuro-book/app/components/markdown-studio/tiptap/OutlineAnchor.ts`
- 测试：`server/outline/format.test.ts`、`library.test.ts`、`writer-context.test.ts`，`app/utils/outline/outline-entry-form.test.ts`，`app/components/markdown-studio/tiptap/markdown-editor-extensions.test.ts`
