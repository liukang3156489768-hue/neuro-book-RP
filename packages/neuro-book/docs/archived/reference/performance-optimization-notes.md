# 细纲标注的编辑器性能约束

**日期**：2026-09-28
**状态**：已废弃（2026-10-01），2026-10-04 归档。细纲段落标注已移除，本文记录的优化对象不再存在；现行入口为[细纲模板](../../../../../docs/specs/outline/outline-entry-templates.md)。后文只保留历史优化约束。
**适用范围**：通用 Markdown 编辑器（TipTap）中的 `nb:guidance`、`nb:reference` 标注。设计见 [detail-writing-guide-annotation.md](./detail-writing-guide-annotation.md)。

## 背景

标注系统第一次实现时，每个 TipTap Mark 都带着写作指导的全部字段。文档加载时，会把 frontmatter 中的元数据逐条写进 Mark 属性，每次序列化都会复制这些对象。带标注的细纲因此加载极慢，记录到的加载时间约 5 分钟，数字来自开发期观察，没有基准测试。那一版实现和旧的 `<guide>`、`<reference>` 语法已经一起删除。

## 仍然有效的约束

- 编辑器 Mark 只保存 `marker`，不保存任何元数据。元数据只在 frontmatter 里，由工作台细纲表单编辑。
- 编辑器加载和输入时不解析 frontmatter，也不把 frontmatter 同步进文档。标注注释在往返时原样保留。
- 不使用标注的文档不应该为标注付出额外开销。Mark 的 tokenizer 只在 `<!--` 处尝试匹配。

如果以后要在富文本编辑器里直接编辑标注元数据，元数据应放在 Mark 之外的状态中按 marker 查找，只在保存时写回 frontmatter，不要退回到“Mark 属性存全量元数据”。
