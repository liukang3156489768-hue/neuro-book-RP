# 大纲规划模块规范文档

本目录包含大纲规划模块的设计文档和技术规范。

## 文档列表

- [规划素材运用与改编](material-adaptation.md)：角色与笔记按需读取、对象权限、按方案记录及章节来源定位，状态 planned。

### [outline-entry-templates.md](./outline-entry-templates.md)
**大纲条目内容模板设计**

定义四个层级大纲的内容结构和模板约束：总纲、卷纲、章节大纲、细纲。

**核心内容**：
- 各层级的职责和定位
- Body 内容模板（Markdown 结构）
- 必需和可选字段规则
- 篇幅建议和约束规则
- Agent 生成指引
- 模板校验规则

**关键约束**：
- 总纲（total）：每个方案一个，1000-3000 字，聚焦宏观结构
- 卷纲（volume）：阶段性规划，800-2000 字，起承转合结构
- 章节大纲（chapter）：可执行场景，500-1500 字，必需 `materialRefs`/`writingGuidance`/`targetWords`
- 细纲（detail）：正文模板与逐场景写作要求，需要偏差分析，包含可选地点、角色资料和服饰小节

**状态**：planned，已获批准；模板与解析已接入，真实生成效果待验收

### [旧细纲标注设计](../../../packages/neuro-book/docs/archived/reference/detail-writing-guide-annotation.md)
**细纲写作指导与段落参考标注（已废弃）**

2026-10-01 细纲改为正文模板后，段落标注、frontmatter `guides` 与带 `marker` 的段落参考已移除。文件只保留历史取舍。

### [旧细纲标注性能记录](../../../packages/neuro-book/docs/archived/reference/performance-optimization-notes.md)
**细纲标注的编辑器性能约束（已废弃）**

记录对象随段落标注一并移除。

---

## 现有细纲格式

细纲的写作信息全部写在正文里，按 [outline-entry-templates.md](./outline-entry-templates.md) 的「细纲」模板书写：章节总览、章节细纲（`## 场景N：名称` 及其字段与小节）、禁止事项。frontmatter 只保留身份、状态、`materialRefs` 与 `analysis`；`writingGuidance`、`references`、`targetWords` 只用于章节大纲。

---

## 相关代码位置

- `packages/neuro-book/server/outline/format.ts`：OutlineEntry 类型、`parseEntryMarkdown` / `serializeEntryMarkdown`
- `packages/neuro-book/shared/outline-detail-structure.ts`：细纲正文模板的解析与结构检查，大纲分析、采用、编辑界面与写作共用
- `packages/neuro-book/server/outline/writer-context.ts`：正文交接
- `packages/neuro-book/app/components/novel-ide/outline/OutlineEntryForm.vue`：工作台条目表单；细纲提供插入模板、插入场景与结构问题列表
- `packages/neuro-book/app/components/novel-ide/outline/OutlineRichTextEditor.vue`、`outline-rich-text.ts`：大纲库与伏笔库共用的富文本正文与伏笔标记浮动菜单
- `packages/neuro-book/app/composables/useOutlineAutosave.ts`：大纲库与伏笔库的自动保存与版本冲突判断
- `packages/neuro-book/app/components/markdown-studio/tiptap/OutlineAnchor.ts`：通用编辑器中的标注 Mark，只用于高亮和无损往返

---

## 待完成

- 浏览器验收：大纲库与伏笔库的直接编辑、自动保存和富文本标注（插入、定位、删除），桌面与 `390×844` 布局，浅色与深色主题
- 在界面中选择 lorebook 条目（延后，当前手填路径）
