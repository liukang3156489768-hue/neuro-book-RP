---
schema: nbook.task/v2
taskId: t11-detail-template
---

# 细纲模板重做

## 目标与范围

切片 9。开发者验收时指出细纲模板不适合写作模块：正文里的“写作指导”“参考文件”等一级标题会被当成场景，字数、写作指导和参考各有多处来源。2026-09-30 讨论确认新模板：

- 正文：可选的首个一级标题 `# 章节总览`（自由文本，不是场景），其后每个一级标题是一个场景；场景内 `## 情节` 等子标题自由组织。去掉 `# 写作提示` 与标题中的“约 N 字”；首个一级标题前不允许有内容。
- frontmatter：细纲级 `perspective`（场景默认人称）；`scenes` 按顺序与场景标题一一对应，每项含 `heading`、`words`、`perspective`、`effect`、`mustInclude`、`avoid`、`ending`、`emotion`、`tone`、`pacing`、`techniques`、`references`、`foreshadowing`。保留 `writingGuidance`、`references`、`guides`、`materialRefs`。
- 写作模块：章节总览与程序生成的“场景一览”放进每个场景的写手提示；作者的必须写到的要素锁定在前，助手只能追加；结尾落点与分配给本场景的伏笔自动成为要素；`avoid` 进入写手提示并由审阅逐项检查；`techniques` 由程序摘录。
- 不兼容旧细纲，用户重新生成。

合同：[outline.writer-handoff](../../../../../docs/specs/outline/writer-handoff.md)、[writing.collaboration](../../../../../docs/specs/writing/collaboration.md)；模板说明见 [outline-entry-templates.md](../../../../../docs/specs/outline/outline-entry-templates.md)。

## 非目标

- 不改章节大纲、卷纲、总纲的模板。
- 不迁移已有细纲。
- 细纲采用入口（切片 10）、文风管理（切片 11）、会话控件（切片 12）另立 Task。

## 当前状态

- 2026-09-30：登记，先改 Spec，再实现。
- 2026-09-30：完成。Spec 与模板说明、`perspective`/`scenes` 解析与序列化、共用结构检查 `shared/outline-detail-structure.ts`（大纲分析、正式采用与写作同一份规则）、细纲表单的场景字段编辑、写作素材与结构 A/B/C 按新模板重写、生成 Skill 模板更新；相关测试与 typecheck 通过。`OutlineGuide` 的 `scene`、`words`、`perspective` 字段不再被写作使用，暂留未删。`server/agent/tools/file-tools.test.ts` 中一条用例因本机 bash 缺少 `rg` 失败，与本片无关。细纲表单的浏览器验收并入 t12。
