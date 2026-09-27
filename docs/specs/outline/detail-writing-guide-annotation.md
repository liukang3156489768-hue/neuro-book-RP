# 细纲写作指导标注系统

**状态**：设计阶段（2026-09-27），性能优化版（2026-09-28）  
**相关模块**：大纲规划模块、Markdown 编辑器  
**作者**：开发者需求，Claude Opus 5 技术设计

**性能问题根因与解决方案**：
- ❌ **首次实装问题**：在加载时从 frontmatter 读取所有标注元数据并设置到每个 Mark 的属性中，导致大量对象创建、序列化和深拷贝，文档加载时间长达 5 分钟
- ✅ **优化方案**：Mark 只存储 `id`（轻量），完整元数据存储在组件的 `Map` 状态中，按需读取，只在保存时同步到 frontmatter
- ✅ **性能目标**：不影响不使用标注的文档的加载性能，标注文档的加载时间与普通文档相当

---

## 一、需求概述

在大纲规划模块的细纲编辑器中，为段落添加两种标注：

1. **写作指导标注**（Writing Guide）：结构化约束（字数、视角、情感等）+ 自由输入，指导 AI 生成正文时遵循特定风格和限制。
2. **参考文献标注**（Reference）：关联 lorebook 知识库条目，备注具体使用方式，AI 生成时可精确引用。

同时保留现有**评论功能**（Comment），三者共存但语义、UI 与消费者不同。

### 编辑器复用说明

`TipTapMarkdownEditor.vue` 是项目的通用 Markdown 编辑器，被多处复用：
- **细纲编辑**（outline entries）：需要写作指导和参考文献标注
- **伏笔库编辑**（lorebook）：不需要标注功能，只需要基础 Markdown 编辑
- **其他文档**：不需要标注功能

**性能关键约束**：
- 编辑器已知性能瓶颈：大文档下的全文 Markdown 序列化（见 `TipTapMarkdownEditor.vue:186-188` 注释）
- 新增标注功能**不能**在每次文档加载、按键输入时执行复杂的 frontmatter 解析/同步
- frontmatter 同步只在**保存时**执行，加载时只需要恢复 Mark 属性即可
- 标注功能应该是**可选的**，不影响不使用标注的文档的加载性能

### 用户交互模式

类似 Word 文档的批注功能：
- 选中文本后，浮动菜单显示"添加写作指导""添加参考文献"按钮
- 点击后弹出表单对话框填写
- 段落旁显示高亮样式（波浪线/虚线边框）
- 侧边栏统一管理所有标注（评论/指导/参考），支持定位、编辑、删除

---

## 二、架构决策

### 2.1 为什么不直接复用 Comment？

| 维度 | Comment（评论） | WritingGuide（写作指导） | Reference（参考文献） |
|---|---|---|---|
| **语义** | 审阅批注、讨论意见 | 创作约束、生成指令 | 知识库引用、素材索引 |
| **添加者** | 人类审阅者 | 作者/AI | 作者 |
| **消费者** | 人类协作者 | AI 生成器 | AI 生成器 |
| **UI 形式** | 自由文本框 | 结构化表单 + 自由框 | lorebook 树形选择器 + 备注 |
| **高亮样式** | 黄色背景（`nb-inline-comment-mark`） | 蓝色波浪下划线 | 绿色虚线边框 |
| **持久化** | 仅 `<comment>` 标签 | 标签 + frontmatter 完整元数据 | 标签 + frontmatter |
| **删除后** | 标注消失 | 标注消失，元数据孤立（需清理） | 标注消失，元数据孤立（需清理） |

**结论**：创建独立的 `WritingGuide` 和 `Reference` TipTap Mark，复用 Comment 的插件架构（decoration、点击事件、列表收集）但独立注册。

### 2.2 段落坐标方案

**用户提出**："通过在注释段落的前后增加独立的程序解析字符用于标注段落，防止字符漂移。"

**技术分析**：TipTap 的 Mark 本身就是精确的字符范围标记（ProseMirror `from/to` position），底层已经是"动态坐标"：
- 插入/删除其他段落时，TipTap 自动重新映射坐标
- Mark 的开始/结束位置随文档编辑实时更新
- 不需要额外的"解析字符"或手动计算偏移量

**采用方案**：直接使用 TipTap Mark 的内置坐标系统，Markdown 序列化为：
```markdown
<guide id="g1">这是需要特殊处理的段落。</guide>
```

---

## 三、数据格式设计

### 3.1 现有细纲格式说明

**OutlineEntry 类型定义**（`server/outline/format.ts`）：
```typescript
export type OutlineEntry = Readonly<{
  schema: "nbook.outline-entry/v2";
  id: OutlineId;                    // 如 "ol-detail-1"
  kind: "total" | "volume" | "chapter" | "detail";
  version: number;
  status: "draft" | "adopted";
  title: string;
  parentId: OutlineId | null;
  chapterId: OutlineId | null;      // 仅 detail 需要
  
  // 可选字段（条目级别）
  materialRefs?: readonly string[];           // 参考资料路径数组
  writingGuidance?: string;                   // 全局写作指导（自由文本）
  references?: readonly OutlineReference[];   // 条目级别的参考文献清单
  targetWords?: number;                       // 目标字数
  analysis?: DetailAnalysis;                  // 细纲分析结果（仅 detail）
  
  body: string;                               // 正文内容
}>;

export type OutlineReference = Readonly<{
  path?: string;      // 文件路径
  locator?: string;   // 定位说明（如"第三段"）
  purpose?: string;   // 用途说明
  pending?: boolean;  // 是否待补
}>;
```

**典型细纲文件示例**（条目级别）：
```markdown
---
schema: nbook.outline-entry/v2
id: ol-detail-1
kind: detail
version: 3
status: adopted
title: 第一章第一场景
parentId: ol-chapter-1
chapterId: ol-chapter-1
materialRefs:
  - lorebook/character/protagonist.md
  - lorebook/location/old-mansion.md
writingGuidance: 整体节奏快，强调紧张气氛
references:
  - path: lorebook/character/protagonist.md
    locator: 性格设定部分
    purpose: 参考主角的童年创伤
targetWords: 1500
---

# 第一章 雨夜来客 - 场景一

## 开场

雨水敲打着窗棂，林默独自坐在昏暗的书房里。

## 回忆

他回忆起师父临终前的警告。
```

### 3.2 WritingGuide Mark（段落级别标注，新增）

**与现有字段的关系**：
- 现有 `writingGuidance`（字符串）：条目级别的**全局指导**，适用于整个细纲条目
- 新增 `<guide>` 标签 + `guides` 数组：**段落级别**的精细化指导，每个段落可以有不同的约束

**Markdown 序列化**：
```html
<guide id="g1">段落内容</guide>
```

**frontmatter 元数据**（新增字段 `guides`）：
```yaml
guides:
  - id: g1                         # 唯一标识，nanoid(8)
    wordCount: 500                 # 目标字数（可选）
    perspective: first             # 视角：first | third | omniscient
    emotion: tense                 # 情感：tense | calm | melancholy | joyful | neutral
    tone: formal                   # 语气：formal | casual | poetic
    pacing: fast                   # 节奏：fast | slow | moderate
    customInstructions: "强调角色内心矛盾"
```

**TipTap Mark 属性**（只存储 id）：
```typescript
{
  id: "g1"  // 只有一个字段，保持轻量
}
```

**为什么需要 frontmatter？**
1. Markdown HTML 标签的属性有转义限制（引号、换行、特殊字符）
2. AI 读取时 frontmatter 更直观，可直接解析为结构化数据
3. 支持复杂嵌套结构（如多个 source 引用、数组字段）
4. 与现有细纲元数据格式一致

### 3.3 Reference Mark（段落级别标注，新增）

**与现有字段的关系**：
- 现有 `references`（OutlineReference[]）：条目级别的**资料清单**，列出整个细纲用到的所有资料
- 新增 `<reference>` 标签 + `detailReferences` 数组：**段落级别**的知识库关联，精确标注哪个段落用了哪些 lorebook 条目

**字段命名**：使用 `detailReferences` 而不是 `references`，避免与现有条目级别的 `references` 字段冲突。

**Markdown 序列化**：
```html
<reference id="r1">段落内容</reference>
```

**frontmatter 元数据**（新增字段 `detailReferences`）：
```yaml
detailReferences:
  - id: r1
    sources:
      - path: lorebook/character/protagonist.md
        note: 参考主角的性格设定，尤其是童年创伤部分
      - path: lorebook/world/magic-system.md
        note: 确认魔法等级限制，不能超过三阶
```

**TipTap Mark 属性**（只存储 id）：
```typescript
{
  id: "r1"  // 只有一个字段，保持轻量
}
```

### 3.4 性能优化：延迟 frontmatter 同步

**关键设计决策**：frontmatter 同步只在**保存时**执行，不在加载时或编辑时执行。

**加载流程**：
1. 文档加载时，`TipTapMarkdownEditor` 解析 Markdown 得到 `<guide id="g1">` 标签
2. TipTap Mark 扩展将标签转换为内部 Mark，**仅保留 `id` 属性**
3. **不从 frontmatter 读取完整元数据到 Mark 属性**（避免大量对象创建和序列化）
4. 用户点击标注时，**按需**从 frontmatter 读取该标注的完整元数据并显示

**编辑流程**：
1. 用户添加标注时，生成 ID 并设置到 Mark
2. 完整元数据保存在组件的 `ref` 状态中（如 `guidesMetadata: Ref<Map<string, {...}>>`）
3. 编辑器正常工作，不涉及 frontmatter

**保存流程**：
1. 用户保存时，调用 `getContent()` 获取 Markdown
2. 此时才执行 `syncAnnotationsToFrontmatter()`，从 Mark 和组件状态提取元数据
3. 将 `guides` 和 `detailReferences` 数组写入 frontmatter
4. 保存完整 Markdown 到文件

**性能对比**：
- ❌ **错误做法**：加载时从 frontmatter 读取所有标注元数据并设置到每个 Mark 的属性中，导致大量对象创建和序列化
- ✅ **正确做法**：Mark 只存储 `id`，元数据按需读取，只在保存时同步

### 3.5 完整细纲文件示例（包含新增标注）

```markdown
---
schema: nbook.outline-entry/v2
id: ol-detail-1
kind: detail
version: 3
status: adopted
title: 第一章第一场景
parentId: ol-chapter-1
chapterId: ol-chapter-1
targetWords: 1500

# 现有字段：条目级别的全局指导和资料清单
writingGuidance: 整体节奏快，强调紧张气氛
materialRefs:
  - lorebook/character/protagonist.md
  - lorebook/location/old-mansion.md
references:
  - path: lorebook/character/protagonist.md
    locator: 性格设定部分
    purpose: 参考主角背景

# 新增字段：段落级别的写作指导标注
guides:
  - id: g1
    wordCount: 500
    perspective: first
    emotion: tense
    customInstructions: 第一人称，强调内心矛盾

# 新增字段：段落级别的参考文献标注
detailReferences:
  - id: r1
    sources:
      - path: lorebook/character/protagonist.md
        note: 参考主角性格设定，童年创伤部分
      - path: lorebook/world/magic-system.md
        note: 确认魔法等级限制
---

# 第一章 雨夜来客 - 场景一

## 开场

<guide id="g1">雨水敲打着窗棂，林默独自坐在昏暗的书房里。烛火摇曳，照亮桌上那封陈旧的信笺。</guide>

## 回忆

<reference id="r1">他回忆起师父临终前的警告：「天机不可泄露，否则反噬自身。」</reference>

## 转折

普通段落不带任何标注，AI 按整体 `writingGuidance` 生成。
```

---

## 四、TipTap 扩展实现

### 4.1 WritingGuide.ts 结构（参考 Comment.ts）

**核心原则**：
1. **Mark 只存储 `id`**，不存储完整元数据（避免加载时大量对象创建）
2. **Plugin 状态缓存标注列表**，文档变化时才重扫，光标移动只重算 active
3. **按需读取元数据**：用户点击标注时才从组件状态或 frontmatter 读取完整信息

```typescript
import {Mark, mergeAttributes} from "@tiptap/core";
import {Plugin, PluginKey} from "@tiptap/pm/state";
import {Decoration, DecorationSet} from "@tiptap/pm/view";

export interface WritingGuideOptions {
  onSelect: (index: number) => void;
  onGuidesChange: (guides: GuideItem[]) => void;
}

export interface GuideItem {
  index: number;
  id: string | null;        // 唯一标识
  from: number;             // 文档位置
  to: number;
  text: string;             // 标注的文本内容
  active: boolean;          // 是否被光标选中
}

export const WritingGuide = Mark.create<WritingGuideOptions>({
  name: "writingGuide",
  priority: 790, // 高于 Comment(780)，低于加粗等基础格式(800+)
  inclusive: false,

  addOptions() {
    return {
      onSelect: () => {},
      onGuidesChange: () => {},
    };
  },

  addAttributes() {
    return {
      id: {default: null},   // 只存储 id，不存储完整元数据
    };
  },

  parseHTML() {
    return [{tag: "guide"}];
  },

  renderHTML({HTMLAttributes}) {
    return ["guide", mergeAttributes(HTMLAttributes), 0];
  },

  // Markdown 解析：<guide id="g1">...</guide>
  parseMarkdown() {
    return {
      match: (node) => node.type === "html_inline" && node.content?.startsWith("<guide"),
      runner: (state, node, type) => {
        const match = /<guide\s+id="([^"]+)">(.+?)<\/guide>/s.exec(node.content || "");
        if (match) {
          const id = match[1];
          const text = match[2];
          state.openMark(type, {id});
          state.addText(text);
          state.closeMark(type);
        }
      },
    };
  },

  // Markdown 序列化：<guide id="g1">...</guide>
  renderMarkdown(state, node, parent, index) {
    const id = node.attrs.id;
    state.write(`<guide id="${id}">`);
    state.renderInline(node);
    state.write("</guide>");
  },

  addCommands() {
    return {
      setWritingGuide: (id: string) => ({commands}) =>
        commands.setMark(this.name, {id}),
      unsetWritingGuide: () => ({commands}) =>
        commands.unsetMark(this.name),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [new Plugin({
      key: new PluginKey("nb-writing-guide"),
      state: {
        init: (config, state) => {
          const guides = collectGuides(state.doc, state.selection.from, state.selection.to);
          return {
            activeIndex: null,
            guides,
            decorations: buildGuideDecorations(state.doc, guides, null),
          };
        },
        apply: (transaction, previous, oldState, newState) => {
          // 文档内容变化：重新扫描
          if (transaction.docChanged) {
            const guides = collectGuides(newState.doc, newState.selection.from, newState.selection.to);
            options.onGuidesChange(guides);
            return {
              activeIndex: null,
              guides,
              decorations: buildGuideDecorations(newState.doc, guides, null),
            };
          }
          // 只有光标移动：重算 active
          if (transaction.selectionSet) {
            const guides = previous.guides.map((g, i) => ({
              ...g,
              active: newState.selection.from >= g.from && newState.selection.to <= g.to,
            }));
            options.onGuidesChange(guides);
            return {
              ...previous,
              guides,
              decorations: buildGuideDecorations(newState.doc, guides, previous.activeIndex),
            };
          }
          return previous;
        },
      },
      props: {
        decorations: (state) => this.getState(state)?.decorations,
        handleClick: (view, position, event) => {
          // Ctrl+点击时选中 guide，触发 onSelect
          if (event.ctrlKey || event.metaKey) {
            const pluginState = this.getState(view.state);
            const guide = pluginState?.guides.find(g => position >= g.from && position <= g.to);
            if (guide) {
              options.onSelect(guide.index);
              return true;
            }
          }
          return false;
        },
      },
    })];
  },
});

// 辅助函数：收集文档中的所有 guide
function collectGuides(doc, selFrom, selTo): GuideItem[] {
  const guides: GuideItem[] = [];
  let index = 0;
  doc.descendants((node, pos) => {
    const mark = node.marks.find(m => m.type.name === "writingGuide");
    if (mark) {
      const from = pos;
      const to = pos + node.nodeSize;
      const active = selFrom >= from && selTo <= to;
      guides.push({
        index: index++,
        id: mark.attrs.id,
        from,
        to,
        text: node.textContent,
        active,
      });
    }
  });
  return guides;
}

// 辅助函数：构建装饰（蓝色波浪下划线）
function buildGuideDecorations(doc, guides: GuideItem[], activeIndex: number | null): DecorationSet {
  const decorations = guides.map(g => {
    const className = g.index === activeIndex ? "nb-writing-guide-mark active" : "nb-writing-guide-mark";
    return Decoration.inline(g.from, g.to, {class: className});
  });
  return DecorationSet.create(doc, decorations);
}
```

### 4.2 Reference.ts 结构（类似 WritingGuide）

**同样遵循性能优化原则**：Mark 只存储 `id`，完整的 `sources` 数组存储在 frontmatter 和组件状态中。

```typescript
export interface ReferenceItem {
  index: number;
  id: string | null;
  from: number;
  to: number;
  text: string;
  active: boolean;
}

export const Reference = Mark.create<ReferenceOptions>({
  name: "reference",
  priority: 785, // 介于 Comment 和 WritingGuide 之间
  
  addAttributes() {
    return {
      id: {default: null},   // 只存储 id
    };
  },
  
  parseHTML() {
    return [{tag: "reference"}];
  },

  renderHTML({HTMLAttributes}) {
    return ["reference", mergeAttributes(HTMLAttributes), 0];
  },
  
  // Markdown 解析和序列化：<reference id="r1">...</reference>
  // ... 类似 WritingGuide 的结构
});
```

### 4.3 TipTapMarkdownEditor.vue 集成

**关键点**：元数据存储在组件的独立状态中，不污染 Mark 属性。

```typescript
// 组件状态：存储标注的完整元数据
const guidesMetadata = ref<Map<string, {
  wordCount?: number;
  perspective?: string;
  emotion?: string;
  tone?: string;
  pacing?: string;
  customInstructions?: string;
}>>(new Map());

const detailReferencesMetadata = ref<Map<string, {
  sources: Array<{path: string; note: string}>;
}>>(new Map());

// 加载文档时：只解析 frontmatter 到组件状态，不设置到 Mark
function loadAnnotationsFromFrontmatter(markdown: string) {
  const {frontmatter} = splitMarkdownFrontmatter(markdown);
  if (!frontmatter) return;
  
  const parsed = YAML.parse(frontmatter);
  
  // 加载 guides 元数据到 Map
  if (parsed.guides) {
    guidesMetadata.value.clear();
    for (const guide of parsed.guides) {
      guidesMetadata.value.set(guide.id, {
        wordCount: guide.wordCount,
        perspective: guide.perspective,
        emotion: guide.emotion,
        tone: guide.tone,
        pacing: guide.pacing,
        customInstructions: guide.customInstructions,
      });
    }
  }
  
  // 加载 detailReferences 元数据到 Map
  if (parsed.detailReferences) {
    detailReferencesMetadata.value.clear();
    for (const ref of parsed.detailReferences) {
      detailReferencesMetadata.value.set(ref.id, {
        sources: ref.sources,
      });
    }
  }
}

// 保存时：从 Mark 和组件状态提取元数据到 frontmatter
function getContentWithAnnotations(): string {
  const markdown = editor.value?.getMarkdown() ?? "";
  const guides = collectGuidesFromEditor();  // 从 Plugin 状态获取
  const detailReferences = collectReferencesFromEditor();
  
  // 合并 Mark 的 id 和组件状态的元数据
  const guidesArray = guides.map(g => ({
    id: g.id,
    ...guidesMetadata.value.get(g.id),
  }));
  
  const detailReferencesArray = detailReferences.map(r => ({
    id: r.id,
    ...detailReferencesMetadata.value.get(r.id),
  }));
  
  // 插入到 frontmatter
  const {frontmatter, body} = splitMarkdownFrontmatter(markdown);
  const parsed = frontmatter ? YAML.parse(frontmatter) : {};
  parsed.guides = guidesArray;
  parsed.detailReferences = detailReferencesArray;  // 使用 detailReferences 字段名
  
  return `---\n${YAML.stringify(parsed)}---\n\n${body}`;
}

// 用户添加标注时：生成 ID，设置 Mark，保存元数据到组件状态
function handleAddWritingGuide(data: WritingGuideFormData) {
  const id = nanoid(8);
  
  // 设置 Mark（只包含 id）
  editor.value?.commands.setWritingGuide(id);
  
  // 保存完整元数据到组件状态
  guidesMetadata.value.set(id, {
    wordCount: data.wordCount,
    perspective: data.perspective,
    emotion: data.emotion,
    tone: data.tone,
    pacing: data.pacing,
    customInstructions: data.customInstructions,
  });
}

function handleAddReference(data: ReferenceFormData) {
  const id = nanoid(8);
  
  // 设置 Mark（只包含 id）
  editor.value?.commands.setReference(id);
  
  // 保存完整元数据到组件状态
  detailReferencesMetadata.value.set(id, {
    sources: data.sources,
  });
}

// 用户点击标注查看详情时：从组件状态读取元数据
function handleGuideSelect(index: number) {
  const guide = guides.value[index];  // 从 Plugin 状态获取的 GuideItem
  const metadata = guidesMetadata.value.get(guide.id);
  
  // 显示对话框，预填充元数据
  showEditGuideDialog(guide.id, metadata);
}

function handleReferenceSelect(index: number) {
  const reference = references.value[index];
  const metadata = detailReferencesMetadata.value.get(reference.id);
  
  // 显示对话框，预填充元数据
  showEditReferenceDialog(reference.id, metadata);
}
```

---

## 五、性能风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **加载时 frontmatter 解析慢** | 大文档加载卡顿5分钟 | ✅ **已解决**：Mark 只存储 `id`，不在加载时读取完整元数据到 Mark 属性。元数据存储在组件状态的 `Map` 中，按需读取。 |
| **每次按键序列化 Markdown** | CPU 跑满，输入卡顿 | ✅ **已有机制**：编辑器已实现防抖（见 `TipTapMarkdownEditor.vue:186-188`），打字期间不序列化，停顿后才序列化。标注功能不影响此机制。 |
| **frontmatter 与 Mark 不同步** | 保存时 guides 数组与实际标签不匹配 | 保存时双向校验：扫描 Markdown 标签和 frontmatter，确保一致。加载时修复：删除孤立的 frontmatter 条目。 |
| **lorebook 树过大（1000+ 条目）** | UI 卡顿，对话框打开缓慢 | 虚拟滚动、懒加载子目录、搜索索引。 |
| **多个标注重叠** | 高亮样式冲突，点击事件不明确 | decoration 设置不同优先级：guide > reference > comment。点击时优先响应最外层标注。 |

---

## 六、UI 交互流程

### 5.1 添加写作指导

**触发时机**：
1. 用户在细纲编辑器中选中一段文本
2. 浮动菜单（`MarkdownSelectionMenu.vue`）显示"添加写作指导"按钮（图标 `i-lucide-pen-tool`）

**表单对话框**（`WritingGuideDialog.vue`）：
```
┌─ 写作指导 ─────────────────────────────────┐
│                                            │
│  目标字数:  [_________500_________] 字     │
│                                            │
│  视角:      ○ 第一人称                      │
│             ● 第三人称                      │
│             ○ 全知视角                      │
│                                            │
│  情感:      [下拉选择: 紧张            ▼]  │
│             (紧张 / 平静 / 忧郁 / 欢快)    │
│                                            │
│  语气:      [下拉选择: 正式            ▼]  │
│             (正式 / 随意 / 诗意)           │
│                                            │
│  节奏:      [下拉选择: 快速            ▼]  │
│             (快速 / 缓慢 / 适中)           │
│                                            │
│  自由输入:                                  │
│  ┌────────────────────────────────────┐   │
│  │ 强调角色内心矛盾，参考知识库      │   │
│  │ lorebook/character/protagonist    │   │
│  │                                    │   │
│  └────────────────────────────────────┘   │
│                                            │
│           [取消]          [确定]           │
└────────────────────────────────────────────┘
```

**保存流程**：
1. 用户点击"确定"
2. 生成唯一 ID：`nanoid(8)`（例如 `g1a2b3c4`）
3. 调用编辑器命令设置 Mark（只包含 id）：
   ```typescript
   const id = nanoid(8);
   editor.commands.setWritingGuide(id);
   
   // 保存完整元数据到组件状态
   guidesMetadata.value.set(id, {
     wordCount: 500,
     perspective: "third",
     emotion: "tense",
     tone: "formal",
     pacing: "fast",
     customInstructions: "强调角色内心矛盾..."
   });
   ```
4. 编辑器自动插入 Mark，底层 Markdown 变为：
   ```markdown
   <guide id="g1a2b3c4">选中的文本内容</guide>
   ```
5. 保存细纲时，`getContentWithAnnotations()` 同时输出：
   - Markdown 正文（含 `<guide>` 标签）
   - frontmatter `guides` 数组（从 Mark 的 id 和组件状态的元数据合并）

**视觉反馈**：
- 段落显示蓝色波浪下划线
- 鼠标悬停时显示 tooltip 提示：
  ```
  写作指导 (点击查看详情)
  ```
- 点击标注时，从组件状态读取完整元数据并显示详情对话框

### 5.2 添加参考文献

**触发时机**：选中文本 → 浮动菜单"添加参考文献"按钮（图标 `i-lucide-library`）

**对话框**（`ReferenceDialog.vue`）：
```
┌─ 参考文献 ─────────────────────────────────┐
│                                            │
│  选择 lorebook 条目:                       │
│  ┌────────────────────────────────────┐   │
│  │ 🔍 搜索...                        │   │
│  └────────────────────────────────────┘   │
│                                            │
│  ┌─ lorebook/ ───────────────────────┐   │
│  ├─┬─ 📁 character/                   │   │
│  │ ├─ [✓] 📄 protagonist.md           │   │
│  │ │     主角（林默）                  │   │
│  │ ├─ [ ] 📄 antagonist.md            │   │
│  │ │     反派（张三）                  │   │
│  │ └─ ...                             │   │
│  ├─┬─ 📁 world/                        │   │
│  │ ├─ [✓] 📄 magic-system.md          │   │
│  │ │     魔法体系                      │   │
│  │ └─ ...                             │   │
│  └─── 📁 location/                     │   │
│       └─ ...                           │   │
│  └────────────────────────────────────┘   │
│                                            │
│  已选条目 (2):                             │
│  ┌────────────────────────────────────┐   │
│  │ • lorebook/character/protagonist   │   │
│  │   备注: [参考主角童年创伤部分__]   │   │
│  │   [移除]                           │   │
│  │                                    │   │
│  │ • lorebook/world/magic-system      │   │
│  │   备注: [确认魔法等级限制______]   │   │
│  │   [移除]                           │   │
│  └────────────────────────────────────┘   │
│                                            │
│           [取消]          [确定]           │
└────────────────────────────────────────────┘
```

**lorebook 树**：
- 通过 API `/api/projects/lorebook/tree?projectRoot=...` 获取
- 返回格式：
  ```typescript
  {
    tree: {
      character: [
        {path: "lorebook/character/protagonist.md", title: "主角"},
        {path: "lorebook/character/antagonist.md", title: "反派"}
      ],
      world: [...]
    }
  }
  ```
- 支持搜索、懒加载子目录（如果条目过多）

**保存流程**：
```typescript
const id = nanoid(8);
editor.commands.setReference(id);

// 保存完整元数据到组件状态
referencesMetadata.value.set(id, {
  sources: [
    {path: "lorebook/character/protagonist", note: "参考主角童年创伤部分"},
    {path: "lorebook/world/magic-system", note: "确认魔法等级限制"}
  ]
});
```

### 5.3 管理面板（MarkdownAnnotationPanel.vue）

**位置**：编辑器右侧，与 `MarkdownCommentFlowPanel` 共享容器

**布局**：
```
┌─ 标注管理 ──────────────────────────────┐
│  [💬 评论] [📐 写作指导] [📚 参考文献]  │ ← Tab 切换
├───────────────────────────────────────┤
│                                        │
│  当前选中 Tab: 写作指导                │
│                                        │
│  ┌─────────────────────────────────┐  │
│  │ #1  第三人称 · 500字 · 紧张     │  │
│  │     "强调角色内心矛盾..."       │  │
│  │     📍定位  ✏️编辑  🗑️删除      │  │
│  └─────────────────────────────────┘  │
│                                        │
│  ┌─────────────────────────────────┐  │
│  │ #2  第一人称 · 无字数限制       │  │
│  │     "内心独白，展现犹豫"        │  │
│  │     📍定位  ✏️编辑  🗑️删除      │  │
│  └─────────────────────────────────┘  │
│                                        │
│  (空白区域，可滚动)                    │
│                                        │
└───────────────────────────────────────┘
```

**功能**：
- **定位**：点击后编辑器滚动到对应段落，高亮显示
- **编辑**：重新打开对话框，预填充现有值
- **删除**：二次确认后调用 `editor.commands.unsetWritingGuide()`

**空状态**：
```
┌─ 写作指导 ──────────────────────────────┐
│                                        │
│         📐                             │
│    还没有写作指导标注                  │
│                                        │
│    选中文本后点击浮动菜单中的          │
│    "添加写作指导"按钮                  │
│                                        │
└───────────────────────────────────────┘
```

---

## 七、API 与后端

### 6.1 新增 API 端点

#### GET `/api/projects/lorebook/tree`

**功能**：返回当前项目的 lorebook 目录树结构

**请求参数**：
```typescript
{
  projectRoot: string; // 项目根目录绝对路径
}
```

**响应**：
```typescript
{
  tree: Record<string, Array<{
    path: string;      // 相对路径，如 "lorebook/character/protagonist.md"
    title: string;     // 从文件 frontmatter 或第一个标题提取
    type: string;      // 目录名，如 "character"
  }>>;
}

// 示例：
{
  tree: {
    character: [
      {path: "lorebook/character/protagonist.md", title: "主角（林默）", type: "character"},
      {path: "lorebook/character/antagonist.md", title: "反派（张三）", type: "character"}
    ],
    world: [
      {path: "lorebook/world/magic-system.md", title: "魔法体系", type: "world"}
    ],
    location: [...]
  }
}
```

**实现位置**：`packages/neuro-book/server/api/projects/lorebook/tree.ts`

**错误处理**：
- 项目不存在：`404 Project not found`
- lorebook 目录不存在：返回空树 `{tree: {}}`
- 文件读取失败：跳过该文件，记录警告日志

#### POST `/api/projects/outline/validate-annotations`

**功能**：校验细纲中的标注格式和引用完整性

**请求体**：
```typescript
{
  projectRoot: string;
  entryId: string;              // 细纲条目 ID
  content: string;              // Markdown 正文
  guides: Array<{               // frontmatter 中的 guides
    id: string;
    wordCount?: number;
    // ...
  }>;
  references: Array<{           // frontmatter 中的 references
    id: string;
    sources: Array<{path: string; note: string}>;
  }>;
}
```

**响应**：
```typescript
{
  valid: boolean;
  errors: Array<{
    type: "orphan_tag" | "orphan_meta" | "missing_lorebook" | "duplicate_id";
    message: string;
    id?: string;
    path?: string;
  }>;
}

// 示例：
{
  valid: false,
  errors: [
    {type: "orphan_tag", message: "标签 <guide id=\"g1\"> 没有对应的 frontmatter 条目", id: "g1"},
    {type: "missing_lorebook", message: "引用的 lorebook 文件不存在", path: "lorebook/character/gone.md"}
  ]
}
```

**校验规则**：
1. **标签与元数据一致性**：
   - 每个 `<guide id="...">` 标签都有对应的 `guides` 数组条目
   - 每个 `guides` 条目都有对应的标签
   - 每个 `<reference id="...">` 标签都有对应的 `references` 条目
2. **lorebook 路径有效性**：
   - 引用的 lorebook 文件存在且可读
   - 路径符合规范（`lorebook/**/*.md`）
3. **ID 唯一性**：
   - 同一细纲中不能有重复的 `guide` ID
   - 同一细纲中不能有重复的 `reference` ID

**实现位置**：`packages/neuro-book/server/api/projects/outline/validate-annotations.ts`

### 6.2 保存细纲时的自动校验

**时机**：`OutlineEntryForm.vue` 提交时，调用 `validate-annotations` API

**流程**：
```typescript
async function saveEntry() {
  // 1. 从编辑器提取 Markdown 和 frontmatter
  const markdown = editor.value.getContent();
  
  // 2. 解析标注
  const guides = extractGuidesFromFrontmatter(markdown);
  const references = extractReferencesFromFrontmatter(markdown);
  
  // 3. 调用校验 API
  const validation = await $fetch("/api/projects/outline/validate-annotations", {
    method: "POST",
    body: {
      projectRoot: props.projectRoot,
      entryId: form.value.id,
      content: markdown,
      guides,
      references
    }
  });
  
  // 4. 校验失败则显示错误，不保存
  if (!validation.valid) {
    showValidationErrors(validation.errors);
    return;
  }
  
  // 5. 校验通过，保存细纲
  await saveOutlineEntry({...});
}
```

**错误提示**：
```
┌─ 标注格式错误 ─────────────────────────┐
│                                        │
│  无法保存细纲，请修复以下问题：         │
│                                        │
│  ❌ 标签 <guide id="g1"> 没有对应的    │
│     frontmatter 条目                   │
│                                        │
│  ❌ 引用的 lorebook 文件不存在:        │
│     lorebook/character/gone.md        │
│                                        │
│            [知道了]                    │
└────────────────────────────────────────┘
```

---

## 八、实施计划

### 关键实现检查清单（避免性能问题）

在开始实现前，必须确认以下设计原则：

- [ ] **Mark 属性最小化**：`addAttributes()` 只返回 `{id: {default: null}}`，不包含 `wordCount`、`perspective` 等元数据字段
- [ ] **组件状态分离**：在 `TipTapMarkdownEditor.vue` 中创建 `guidesMetadata: Ref<Map<string, {...}>>` 存储完整元数据
- [ ] **加载时不同步**：`loadAnnotationsFromFrontmatter()` 只填充组件状态的 Map，不调用 `editor.commands.setWritingGuide()` 设置 Mark 属性
- [ ] **保存时才同步**：只有 `getContentWithAnnotations()` 中才从 Mark 的 id 和 Map 合并数据到 frontmatter
- [ ] **按需读取**：用户点击标注查看详情时，才从 Map 读取元数据并显示对话框
- [ ] **性能验证**：用包含 50+ 个标注的测试文档验证加载时间 < 1 秒

### 阶段 1：基础架构（预计 2-3 天）

- [ ] 创建 `packages/neuro-book/app/components/markdown-studio/tiptap/WritingGuide.ts`
  - 参考 `Comment.ts` 结构
  - 实现 Mark 定义、属性、HTML 解析/渲染
  - 实现 Markdown tokenizer、parseMarkdown、renderMarkdown
  - 实现 ProseMirror Plugin（decoration、点击事件、列表收集）
- [ ] 创建 `packages/neuro-book/app/components/markdown-studio/tiptap/Reference.ts`
  - 类似 WritingGuide，调整属性和样式
- [ ] 修改 `packages/neuro-book/app/components/markdown-studio/tiptap/markdown-editor-extensions.ts`
  - 注册 WritingGuide 和 Reference 扩展
- [ ] 编写单元测试：
  - `WritingGuide.test.ts`：测试 parseHTML、renderHTML、parseMarkdown、renderMarkdown
  - `Reference.test.ts`：同上

### 阶段 2：UI 组件（预计 3-4 天）

- [ ] 创建 `packages/neuro-book/app/components/markdown-studio/WritingGuideDialog.vue`
  - 表单对话框：字数、视角（单选）、情感（下拉）、语气（下拉）、节奏（下�拉）、自由输入
  - 使用 nb-ui 组件：`Dialog`、`FormField`、`FormInput`、`FormSelect`、`FormTextarea`、`Button`
  - 预填充编辑模式
- [ ] 创建 `packages/neuro-book/app/components/markdown-studio/ReferenceDialog.vue`
  - lorebook 树形选择器（复选框）
  - 已选条目列表（可添加备注、可移除）
  - 搜索过滤功能
- [ ] 修改 `packages/neuro-book/app/components/markdown-studio/MarkdownSelectionMenu.vue`
  - 在现有按钮组后添加两个新按钮：
    - "添加写作指导"（图标 `i-lucide-pen-tool`）
    - "添加参考文献"（图标 `i-lucide-library`）
  - 点击后 emit 事件，由父组件打开对应对话框
- [ ] 创建 `packages/neuro-book/app/components/markdown-studio/MarkdownAnnotationPanel.vue`
  - Tab 切换：评论 / 写作指导 / 参考文献
  - 统一列表渲染：索引、摘要、操作按钮（定位、编辑、删除）
  - 空状态提示
  - 复用 `MarkdownCommentFlowPanel.vue` 的样式
- [ ] 编写组件测试：
  - `WritingGuideDialog.test.ts`：表单提交、预填充
  - `ReferenceDialog.test.ts`：树形选择、备注输入
  - `MarkdownAnnotationPanel.test.ts`：Tab 切换、定位/编辑/删除

### 阶段 3：后端支持（预计 1-2 天）

- [ ] 实现 `packages/neuro-book/server/api/projects/lorebook/tree.ts`
  - 扫描 lorebook 目录
  - 提取文件标题（从 frontmatter 或第一个 `#` 标题）
  - 按类型分组返回
- [ ] 实现 `packages/neuro-book/server/api/projects/outline/validate-annotations.ts`
  - 解析 Markdown 中的 `<guide>` 和 `<reference>` 标签
  - 校验标签与 frontmatter 一致性
  - 校验 lorebook 路径存在性
  - 返回错误列表
- [ ] 更新 `packages/neuro-book/app/components/novel-ide/outline/OutlineEntryForm.vue`
  - 保存前调用 `validate-annotations` API
  - 显示校验错误对话框
  - 通过后才执行保存
- [ ] 编写后端测试：
  - `lorebook-tree.test.ts`：目录扫描、标题提取
  - `validate-annotations.test.ts`：各种校验规则

### 阶段 4：AI 局部重写（预计 2 天）

- [ ] 修改 `MarkdownSelectionMenu.vue` 中的"加入 AI 引用"按钮
  - 改为"AI 局部重写"（图标 `i-lucide-sparkles`）
  - 点击后打开对话框，用户输入重写要求
- [ ] 创建 `AiRewriteDialog.vue`
  - 输入框：用户描述重写要求（例如"改为第一人称""气氛更紧张"）
  - 显示选中的原文
  - 调用 Agent API 执行重写
  - 显示重写结果，用户可选择"替换"或"取消"
- [ ] 实现后端 Agent 工具或 API
  - 接收选中文本和重写要求
  - 调用 LLM 生成新文本
  - 返回重写结果

### 阶段 5：集成测试与文档（预计 1-2 天）

- [ ] 端到端测试：
  - 添加写作指导 → 编辑 → 删除 → 保存 → 重新加载
  - 添加参考文献 → 编辑 → 删除 → 保存 → 重新加载
  - 标注重叠场景（同一段落既有 guide 又有 reference）
  - 校验失败场景（孤立标签、孤立元数据、缺失 lorebook）
- [ ] 更新用户文档：
  - `vitepress/docs/guide/outline-planning.md`：添加"写作指导标注"章节
  - 截图和操作步骤说明
- [ ] 更新 Agent 消费文档：
  - `packages/neuro-book/assets/reference/content/outline-detail.md`：
    - 告知 AI 如何读取 frontmatter 中的 `guides` 和 `references`
    - 说明每个字段的含义和约束
    - 给出示例

**总计**：约 9-13 天

---

## 九、技术风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| **frontmatter 与 Mark 不同步** | 保存时 guides 数组与实际标签不匹配，AI 读取错误数据 | 1. 保存时双向校验：扫描 Markdown 标签和 frontmatter，确保一致<br>2. 加载时修复：删除孤立的 frontmatter 条目，为孤立标签生成默认元数据 |
| **lorebook 树过大（1000+ 条目）** | UI 卡顿，对话框打开缓慢 | 1. 虚拟滚动（使用 `vue-virtual-scroller`）<br>2. 懒加载子目录：默认只展开第一级，点击文件夹时异步加载<br>3. 搜索索引：预先构建标题索引，支持快速过滤 |
| **多个标注重叠** | 高亮样式冲突，点击事件不明确 | 1. decoration 设置不同优先级：guide > reference > comment<br>2. 点击时优先响应最外层标注<br>3. UI 提示："此段落有多个标注，点击查看全部" |
| **旧细纲文件没有 frontmatter** | 加载时解析失败，丢失标注 | 1. 加载时检查：如果 Markdown 中有 `<guide>` 或 `<reference>` 标签但 frontmatter 为空，自动生成默认元数据<br>2. 迁移提示：首次打开时显示提示"检测到旧格式标注，已自动迁移" |
| **用户手动编辑 Markdown 破坏格式** | 标签不完整、属性缺失、frontmatter 损坏 | 1. 保存时强制校验，拒绝保存损坏数据<br>2. 提供"修复标注"工具按钮：扫描并尝试自动修复常见错误 |
| **ID 冲突（多人协作）** | 两个用户同时添加标注，生成相同 ID | 1. 使用 `nanoid(8)` 生成 ID，碰撞概率极低（62^8 ≈ 218 万亿）<br>2. 保存前检查 ID 唯一性，冲突时重新生成 |

---

## 十、未来扩展

### 1. 标注模板

**功能**：预设常用写作指导组合

**示例**：
- **动作场景**：第三人称、快节奏、紧张情感、500-800字
- **内心独白**：第一人称、慢节奏、忧郁情感、300-500字
- **对话重戏**：第三人称、适中节奏、随意语气、600-1000字

**实现**：
- 在对话框中添加"从模板选择"按钮
- 模板存储在配置文件或数据库中
- 用户可自定义模板

### 2. 批量操作

**功能**：选中多个段落，一次性添加相同写作指导

**实现**：
- 在编辑器中支持多选（Shift+点击）
- 浮动菜单显示"批量添加指导"
- 对话框中显示"将应用到 N 个段落"

### 3. AI 建议

**功能**：分析段落内容，自动建议合适的写作指导

**实现**：
- 对话框中添加"AI 建议"按钮
- 发送段落文本到 LLM，返回建议的字数、视角、情感等
- 用户可接受建议或手动调整

### 4. 版本对比

**功能**：查看标注的历史变更

**实现**：
- 集成到现有的版本控制系统（Git）
- 标注面板中添加"历史"按钮
- 显示标注的添加时间、修改记录、删除记录

### 5. 导出与分享

**功能**：导出带标注的细纲为可分享格式

**实现**：
- 导出为 PDF，高亮显示标注区域
- 导出为 HTML，鼠标悬停显示标注详情
- 导出为纯文本，标注作为脚注

---

## 十一、参考资料

### 相关文件

- **TipTap 扩展**：
  - `packages/neuro-book/app/components/markdown-studio/tiptap/Comment.ts`（参考架构）
  - `packages/neuro-book/app/components/markdown-studio/tiptap/ForeshadowMarker.ts`（另一种标注实现）
- **UI 组件**：
  - `packages/neuro-book/app/components/markdown-studio/MarkdownCommentFlowPanel.vue`（参考样式）
  - `packages/neuro-book/app/components/markdown-studio/MarkdownSelectionMenu.vue`（添加按钮）
- **细纲编辑**：
  - `packages/neuro-book/app/components/novel-ide/outline/OutlineEntryForm.vue`（集成点）
- **lorebook 工具**：
  - `packages/neuro-book/server/agent/tools/lorebook-file-tools.ts`（权限控制）
  - `packages/neuro-book/assets/reference/content/lorebook.md`（目录结构）

### 外部文档

- [TipTap Mark API](https://tiptap.dev/api/marks)
- [ProseMirror Decoration](https://prosemirror.net/docs/ref/#view.Decoration)
- [nanoid](https://github.com/ai/nanoid)（ID 生成器）

---

**状态**：✅ 设计完成，等待实施
**下一步**：创建 Work/Task 记录，开始阶段 1 实施
