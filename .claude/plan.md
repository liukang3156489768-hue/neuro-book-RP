# 实施计划：细纲写作指导标注系统 - 阶段 1

## 目标

实现阶段 1：基础架构，包括 WritingGuide 和 Reference 两个 TipTap Mark 扩展。

## 背景理解

### 现有架构
- `Comment.ts` 提供了完整的 Mark 扩展参考实现
- `markdown-workbench.ts` 提供了解析/渲染辅助函数（parseMarkdownCommentInline、renderMarkdownCommentInline）
- `markdown-dialect-extensions.ts` 统一管理所有方言扩展
- `markdown-editor-extensions.ts` 组装完整编辑器扩展

### 关键设计约束（性能关键）
1. **Mark 只存储 id**：`addAttributes()` 只返回 `{id: {default: null}}`
2. **轻量化 Plugin 状态**：只存储 `{index, id, from, to, text, active}`
3. **文档变化才重扫**：光标移动只重算 active，避免全文遍历
4. **元数据分离**：完整元数据存储在 TipTapMarkdownEditor.vue 的组件状态中

### Comment.ts 的关键模式
- Mark 属性：只有 `id` 和 `body`（Comment 的 body 是评论内容，我们的 guide/reference 只需要 id）
- Plugin 状态：缓存 items 列表和 decorations
- 性能优化：`resolveNextComments` 区分文档变化和光标移动
- Decoration：使用 `Decoration.inline()` 添加样式类
- 点击处理：Ctrl+点击选中标注

## 实施步骤

### 步骤 1：创建 WritingGuide.ts

**文件**：`packages/neuro-book/app/components/markdown-studio/tiptap/WritingGuide.ts`

**结构**：
```typescript
// 1. 接口定义
export interface GuideItem {
  index: number;
  id: string | null;
  from: number;
  to: number;
  text: string;
  active: boolean;
}

interface WritingGuideOptions {
  onSelect: (index: number) => void;
  onGuidesChange: (guides: GuideItem[]) => void;
}

interface GuidePluginState {
  activeIndex: number | null;
  guides: GuideItem[];
  decorations: DecorationSet;
}

export const GUIDE_PLUGIN_KEY = new PluginKey<GuidePluginState>("nb-writing-guide");

// 2. Mark 定义
export const WritingGuide = Mark.create<WritingGuideOptions>({
  name: "writingGuide",
  priority: 790,  // 高于 Comment(780)
  inclusive: false,
  
  addAttributes() {
    return {
      id: {default: null}  // ⚠️ 只有 id，没有其他元数据
    };
  },
  
  parseHTML() {
    return [{tag: "guide"}];
  },
  
  renderHTML({HTMLAttributes}) {
    return ["guide", mergeAttributes(HTMLAttributes), 0];
  },
  
  // 3. Markdown 解析和渲染
  markdownTokenizer: {
    name: "writingGuide",
    level: "inline",
    start(src: string) {
      return src.indexOf("<guide");
    },
    tokenize(src, _tokens, lexer) {
      const parsed = parseMarkdownGuideInline(src);
      if (!parsed) return undefined;
      return {
        type: "writingGuide",
        raw: parsed.raw,
        id: parsed.id,
        text: parsed.text,
        tokens: lexer.inlineTokens(parsed.text),
      };
    },
  },
  
  parseMarkdown: (token, helpers) => {
    return helpers.applyMark("writingGuide", helpers.parseInline(token.tokens ?? []), {
      id: token.id ?? null
    });
  },
  
  renderMarkdown: (node, helpers) => {
    const id = node.attrs?.id?.trim() ?? "";
    const idAttr = id ? ` id="${escapeAttribute(id)}"` : "";
    return `<guide${idAttr}>${helpers.renderChildren(node)}</guide>`;
  },
  
  // 4. 命令
  addCommands() {
    return {
      setWritingGuide: (id: string) => ({commands}) => 
        commands.setMark(this.name, {id}),
      unsetWritingGuide: () => ({commands}) => 
        commands.unsetMark(this.name),
    };
  },
  
  // 5. Plugin（核心性能优化点）
  addProseMirrorPlugins() {
    const options = this.options;
    return [new Plugin<GuidePluginState>({
      key: GUIDE_PLUGIN_KEY,
      state: {
        init: (_config, state) => {
          const guides = collectGuides(state.doc, state.selection.from, state.selection.to);
          return {
            activeIndex: null,
            guides,
            decorations: buildGuideDecorations(state.doc, guides, null),
          };
        },
        apply: (transaction, previous, oldState, newState) => {
          // 光标移动：只重算 active
          if (!transaction.docChanged && newState.selection.eq(oldState.selection)) {
            return previous;
          }
          
          const nextGuides = resolveNextGuides(previous.guides, newState, transaction.docChanged);
          if (nextGuides === previous.guides && activeIndex === previous.activeIndex) {
            return previous;
          }
          
          return {
            activeIndex: previous.activeIndex,
            guides: nextGuides,
            decorations: buildGuideDecorations(newState.doc, nextGuides, previous.activeIndex),
          };
        },
      },
      view: () => ({
        update: (view, prevState) => {
          const previous = GUIDE_PLUGIN_KEY.getState(prevState);
          const next = GUIDE_PLUGIN_KEY.getState(view.state);
          if (!next || previous?.guides === next.guides) return;
          options.onGuidesChange(next.guides);
        },
      }),
      props: {
        decorations: (state) => GUIDE_PLUGIN_KEY.getState(state)?.decorations ?? DecorationSet.empty,
        handleClick: (view, position, event) => {
          if (!event.ctrlKey) return false;
          // 找到点击的 guide 并触发 onSelect
          const guides = GUIDE_PLUGIN_KEY.getState(view.state)?.guides ?? [];
          const matched = guides.find(g => position >= g.from && position <= g.to);
          if (!matched) return false;
          event.preventDefault();
          options.onSelect(matched.index);
          return true;
        },
      },
    })];
  },
});

// 6. 辅助函数
function collectGuides(doc, selectionFrom, selectionTo): GuideItem[] {
  const guides: GuideItem[] = [];
  doc.descendants((node, position) => {
    if (!node.isInline) return;
    const mark = node.marks.find(m => m.type.name === "writingGuide");
    if (!mark) return;
    
    const from = position;
    const to = position + node.nodeSize;
    const id = mark.attrs?.id?.trim() ?? null;
    const text = node.textContent;
    const active = selectionFrom >= from && selectionTo <= to;
    
    guides.push({index: guides.length, id, from, to, text, active});
  });
  return guides;
}

function resolveNextGuides(previous, state, docChanged): GuideItem[] {
  const {from, to} = state.selection;
  
  // 只有光标移动：重算 active
  if (!docChanged) {
    let changed = false;
    const next = previous.map(guide => {
      const active = from >= guide.from && to <= guide.to;
      if (active === guide.active) return guide;
      changed = true;
      return {...guide, active};
    });
    return changed ? next : previous;
  }
  
  // 文档变化：全量重扫
  return collectGuides(state.doc, from, to);
}

function buildGuideDecorations(doc, guides, activeIndex): DecorationSet {
  const decorations: Decoration[] = [];
  for (const guide of guides) {
    const active = guide.active || guide.index === activeIndex;
    decorations.push(Decoration.inline(guide.from, guide.to, {
      class: active ? "nb-writing-guide-mark is-active" : "nb-writing-guide-mark",
      "data-guide-index": String(guide.index),
    }));
  }
  return DecorationSet.create(doc, decorations);
}
```

**辅助解析函数**：需要在 `shared/markdown-workbench.ts` 中添加：
```typescript
// 类似 parseMarkdownCommentInline
const GUIDE_INLINE_PATTERN = /^<guide\s+([^>]+)>([\s\S]*?)<\/guide>/;

export function parseMarkdownGuideInline(src: string): {raw: string; id: string | null; text: string} | null {
  const matched = GUIDE_INLINE_PATTERN.exec(src);
  if (!matched) return null;
  const attrs = parseAttributes(matched[1] ?? "");
  return {
    raw: matched[0],
    id: attrs.id ?? null,
    text: matched[2] ?? "",
  };
}
```

### 步骤 2：创建 Reference.ts

**文件**：`packages/neuro-book/app/components/markdown-studio/tiptap/Reference.ts`

**结构**：与 WritingGuide.ts 几乎相同，区别：
- Mark name: `"reference"`
- Priority: `785`（介于 Comment 和 WritingGuide 之间）
- Plugin key: `REFERENCE_PLUGIN_KEY`
- 标签名: `<reference>`
- 样式类: `nb-reference-mark`
- 命令名: `setReference` / `unsetReference`

### 步骤 3：注册扩展

**修改文件**：`markdown-dialect-extensions.ts`

```typescript
import {WritingGuide} from "./WritingGuide";
import {Reference} from "./Reference";

export interface MarkdownDialectExtensionOptions {
  comment?: Parameters<typeof Comment.configure>[0];
  htmlEmbed?: Parameters<typeof HtmlEmbed.configure>[0];
  // 新增
  writingGuide?: Parameters<typeof WritingGuide.configure>[0];
  reference?: Parameters<typeof Reference.configure>[0];
}

export function createMarkdownDialectExtensions(options: MarkdownDialectExtensionOptions = {}): AnyExtension[] {
  return [
    // ... 现有扩展
    options.comment ? Comment.configure(options.comment) : Comment,
    // 新增：在 Comment 之后添加
    options.writingGuide ? WritingGuide.configure(options.writingGuide) : WritingGuide,
    options.reference ? Reference.configure(options.reference) : Reference,
    ForeshadowMarker,
    // ... 其他扩展
  ];
}
```

**修改文件**：`markdown-editor-extensions.ts`

```typescript
export interface MarkdownEditorExtensionOptions extends MarkdownSuggestionController {
  // ... 现有选项
  onCommentsChange?: (comments: CommentItem[]) => void;
  // 新增
  onGuideSelect?: (index: number) => void;
  onGuidesChange?: (guides: GuideItem[]) => void;
  onReferenceSelect?: (index: number) => void;
  onReferencesChange?: (references: ReferenceItem[]) => void;
}

export function createMarkdownEditorExtensions(options: MarkdownEditorExtensionOptions): AnyExtension[] {
  return [
    ...createMarkdownDialectExtensions({
      comment: {
        onSelect: options.onInlineCommentSelect ?? (() => {}),
        onCommentsChange: options.onCommentsChange ?? (() => {}),
      },
      // 新增
      writingGuide: {
        onSelect: options.onGuideSelect ?? (() => {}),
        onGuidesChange: options.onGuidesChange ?? (() => {}),
      },
      reference: {
        onSelect: options.onReferenceSelect ?? (() => {}),
        onReferencesChange: options.onReferencesChange ?? (() => {}),
      },
      htmlEmbed: {
        // ...
      },
    }),
    // ...
  ];
}
```

### 步骤 4：添加 CSS 样式

**修改文件**：`TipTapMarkdownEditor.vue` 的 `<style>` 部分

```css
/* 写作指导标注：蓝色波浪下划线 */
.nb-writing-guide-mark {
  border-bottom: 2px wavy color-mix(in srgb, var(--accent-main) 70%, transparent);
  cursor: pointer;
}

.nb-writing-guide-mark.is-active {
  border-bottom-color: var(--accent-main);
  background: color-mix(in srgb, var(--accent-main) 10%, transparent);
}

/* 参考文献标注：绿色虚线边框 */
.nb-reference-mark {
  border: 1px dashed var(--accent-secondary);
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent-bg) 20%, transparent);
  cursor: pointer;
  padding: 0 2px;
}

.nb-reference-mark.is-active {
  border-color: var(--accent-secondary);
  background: color-mix(in srgb, var(--accent-secondary) 20%, transparent);
}
```

## 验证清单

- [ ] WritingGuide.ts 编译通过
- [ ] Reference.ts 编译通过
- [ ] markdown-workbench.ts 添加解析函数
- [ ] 扩展注册成功，编辑器能加载
- [ ] Markdown 往返测试：`<guide id="g1">text</guide>` → TipTap → Markdown 保持一致
- [ ] Mark 只存储 id，不存储其他元数据（检查 addAttributes）
- [ ] 光标移动时不会全文重扫（检查 resolveNextGuides 逻辑）
- [ ] 样式正确显示：蓝色波浪线（guide）、绿色虚线框（reference）
- [ ] Ctrl+点击能触发 onSelect 回调

## 风险和注意事项

1. **性能风险**：必须严格遵守"Mark 只存储 id"的设计，不能在 addAttributes 中添加元数据字段
2. **解析兼容性**：新增的标签可能与现有 HTML 兜底规则冲突，需要确保 priority 设置正确
3. **样式冲突**：多个标注重叠时的样式处理（guide、reference、comment 同时存在）
4. **TypeScript 类型**：需要导出 GuideItem 和 ReferenceItem 类型供其他组件使用

## 后续步骤

阶段 1 完成后，进入阶段 2：UI 组件开发（WritingGuideDialog、ReferenceDialog、MarkdownAnnotationPanel）
