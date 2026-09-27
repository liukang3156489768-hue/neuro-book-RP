# 大纲规划模块规范文档

本目录包含大纲规划模块的设计文档和技术规范。

## 文档列表

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
- 总纲（total）：全局唯一，1000-3000 字，聚焦宏观结构
- 卷纲（volume）：阶段性规划，800-2000 字，起承转合结构
- 章节大纲（chapter）：可执行场景，500-1500 字，必需 `materialRefs`/`writingGuidance`/`targetWords`
- 细纲（detail）：写作指导，需要偏差分析，支持段落级别标注（未来）

**状态**：设计阶段

### [detail-writing-guide-annotation.md](./detail-writing-guide-annotation.md)
**细纲写作指导标注系统**

为细纲编辑器添加段落级别的写作指导和参考文献标注功能。

**核心功能**：
- 写作指导标注（WritingGuide）：为段落添加结构化约束（字数、视角、情感、语气、节奏等）
- 参考文献标注（Reference）：关联 lorebook 知识库条目到具体段落
- 与现有评论（Comment）功能并存，三者共存但用途不同

**关键设计**：
- Mark 只存储 `id`，完整元数据存储在组件状态的 Map 中
- 延迟 frontmatter 同步：只在保存时执行，加载时按需读取
- 新增 `guides` 和 `detailReferences` frontmatter 字段
- 不影响不使用标注功能的文档的加载性能

**状态**：设计阶段，性能优化版（2026-09-28）

### [performance-optimization-notes.md](./performance-optimization-notes.md)
**性能优化笔记**

记录首次实装时遇到的性能问题（文档加载 5 分钟）的根因分析和解决方案。

**核心问题**：
- ❌ 错误：在 Mark 属性中存储完整元数据（7个字段），导致大量对象创建和序列化
- ✅ 正确：Mark 只存储 `id`，元数据分离到组件状态

**性能提升**：300倍（5分钟 → <1秒）

**状态**：已完成分析

---

## 现有细纲格式

### OutlineEntry 结构

```typescript
export type OutlineEntry = Readonly<{
  schema: "nbook.outline-entry/v2";
  id: OutlineId;                    // 如 "ol-detail-1"
  kind: "total" | "volume" | "chapter" | "detail";
  version: number;
  status: "draft" | "adopted";
  title: string;
  parentId: OutlineId | null;
  chapterId: OutlineId | null;
  
  // 条目级别字段
  materialRefs?: readonly string[];           // 参考资料路径
  writingGuidance?: string;                   // 全局写作指导
  references?: readonly OutlineReference[];   // 条目级别资料清单
  targetWords?: number;
  analysis?: DetailAnalysis;                  // 仅 detail
  
  body: string;
}>;
```

### 条目级别 vs 段落级别

| 层级 | 现有字段 | 新增标注 | 用途 |
|---|---|---|---|
| **条目级别** | `writingGuidance` (字符串) | - | 整个细纲的全局指导 |
| **段落级别** | - | `<guide>` + `guides` 数组 | 每个段落的精细化约束 |
| **条目级别** | `references` (OutlineReference[]) | - | 整个细纲的资料清单 |
| **段落级别** | - | `<reference>` + `detailReferences` 数组 | 每个段落关联的 lorebook 条目 |

---

## 相关代码位置

**类型定义**：
- `packages/neuro-book/server/outline/format.ts` - OutlineEntry 类型定义
- `packages/neuro-book/server/outline/format.ts` - serializeEntryMarkdown / parseEntryMarkdown

**编辑器**：
- `packages/neuro-book/app/components/markdown-studio/TipTapMarkdownEditor.vue` - 通用 Markdown 编辑器
- `packages/neuro-book/app/components/markdown-studio/tiptap/Comment.ts` - 现有评论标注参考
- `packages/neuro-book/app/components/markdown-studio/tiptap/markdown-editor-extensions.ts` - 扩展注册

**待创建**：
- `packages/neuro-book/app/components/markdown-studio/tiptap/WritingGuide.ts`
- `packages/neuro-book/app/components/markdown-studio/tiptap/Reference.ts`
- `packages/neuro-book/app/components/markdown-studio/WritingGuideFormDialog.vue`
- `packages/neuro-book/app/components/markdown-studio/ReferenceDialog.vue`
- `packages/neuro-book/app/components/markdown-studio/MarkdownAnnotationPanel.vue`

---

## 实施顺序

按照 [detail-writing-guide-annotation.md](./detail-writing-guide-annotation.md) 第八章的实施计划：

1. **阶段 1**：基础架构（WritingGuide.ts、Reference.ts）
2. **阶段 2**：UI 组件（表单对话框、标注管理面板）
3. **阶段 3**：后端支持（lorebook tree API、校验 API）
4. **阶段 4**：AI 局部重写（可选）
5. **阶段 5**：集成测试与文档

**总计**：约 9-13 天

---

## 注意事项

⚠️ **性能关键**：
- 必须遵循"Mark 只存储 id"的设计原则
- 加载时不能从 frontmatter 同步元数据到 Mark 属性
- 实施前必须通过性能优化检查清单

⚠️ **字段命名**：
- 新增的段落级别参考文献使用 `detailReferences` 字段
- 不要与现有的条目级别 `references` 字段冲突

⚠️ **向后兼容**：
- 不影响不使用标注功能的文档
- 保留现有的 `writingGuidance` 和 `references` 字段
- 评论功能（Comment）完全不受影响
