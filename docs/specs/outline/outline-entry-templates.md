# 大纲条目内容模板设计

**状态**：设计阶段（2026-09-28）  
**相关模块**：大纲规划模块  
**作者**：开发者需求，Claude Opus 5 技术设计

---

## 一、概述

大纲规划模块包含四个层级的大纲条目：总纲（total）、卷纲（volume）、章节大纲（chapter）、细纲（detail）。每个层级有不同的职责和内容要求。本文档定义各层级的内容模板和结构化约束，帮助用户和 AI 生成符合规范的大纲内容。

### 与现有格式的关系

**现有 OutlineEntry 类型**（`server/outline/format.ts`）：
```typescript
export type OutlineEntry = Readonly<{
  schema: "nbook.outline-entry/v2";
  id: OutlineId;
  kind: "total" | "volume" | "chapter" | "detail";
  version: number;
  status: "draft" | "adopted";
  title: string;
  parentId: OutlineId | null;
  chapterId: OutlineId | null;
  
  // 条目级别字段
  materialRefs?: readonly string[];
  writingGuidance?: string;
  references?: readonly OutlineReference[];
  targetWords?: number;
  analysis?: DetailAnalysis;  // 仅 detail
  
  body: string;
}>;
```

**本文档关注**：`body` 字段的内容结构和模板约束，以及各 `kind` 应该包含哪些结构化字段。

---

## 二、总纲（Total）

### 职责

作品整体层面的故事方向、核心冲突、主题、主要阶段和结局方向。全局唯一，作为所有方案的共同纲领。

### 必需结构化字段

```yaml
schema: nbook.outline-entry/v2
kind: total
status: draft | adopted
title: 作品标题
parentId: null
chapterId: null
```

### Body 内容模板

```markdown
# 核心冲突

[描述作品的核心矛盾和冲突是什么]

# 主题

[作品想要表达的核心主题和价值观]

# 主要阶段

## 第一阶段：[阶段名称]
[该阶段的主要目标和转折]

## 第二阶段：[阶段名称]
[该阶段的主要目标和转折]

## 第三阶段：[阶段名称]
[该阶段的主要目标和转折]

# 结局方向

[作品的预期结局和最终状态]

# 人物关系

[主要人物之间的关系网络]

# 世界观设定

[作品的世界观基础设定]
```

### 约束规则

1. **必需章节**：核心冲突、主题、结局方向必须存在
2. **阶段数量**：建议 3-5 个主要阶段
3. **篇幅建议**：1000-3000 字
4. **不应包含**：具体的章节情节、细节描写、对话内容
5. **可选字段**：`materialRefs`（全局参考素材）

### Agent 生成提示

生成总纲时，AI 应该：
- 聚焦宏观结构，避免细节
- 明确核心冲突，而不是罗列事件
- 提供清晰的阶段划分
- 说明结局方向，但不锁死具体结局
- 保持开放性，为后续展开留有空间

---

## 三、卷纲（Volume）

### 职责

总纲下的阶段性规划，描述一卷或一个较大篇章的目标、冲突、推进和收束。

### 必需结构化字段

```yaml
schema: nbook.outline-entry/v2
kind: volume
status: draft | adopted
title: 第X卷：[卷名]
parentId: [总纲ID]
chapterId: null
```

### Body 内容模板

```markdown
# 本卷目标

[本卷需要达成的故事目标]

# 起始状态

[本卷开始时的人物状态、世界状态]

# 核心冲突

[本卷的主要矛盾和冲突]

# 剧情推进

## 起
[本卷如何引入冲突]

## 承
[冲突如何发展和升级]

## 转
[关键转折点]

## 合
[本卷如何收束]

# 结束状态

[本卷结束时的人物状态、世界状态]

# 与总纲的关系

[本卷在总体故事中的位置和作用]

# 关键事件

- [事件1]
- [事件2]
- [事件3]
```

### 约束规则

1. **必需章节**：本卷目标、起始状态、核心冲突、结束状态
2. **篇幅建议**：800-2000 字
3. **不应包含**：具体的章节内容、场景描写
4. **可选字段**：`materialRefs`（本卷涉及的素材）、`targetWords`（本卷目标字数）

### Agent 生成提示

生成卷纲时，AI 应该：
- 明确本卷的边界（起始/结束状态）
- 说明本卷在总体故事中的作用
- 提供清晰的四段式结构（起承转合）
- 列出 3-5 个关键事件
- 为下级章节大纲留出展开空间

---

## 四、章节大纲（Chapter）

### 职责

卷纲下可执行到章节的剧情规划，描述该章节需要发生的主要事件、冲突、转折和结果。

### 必需结构化字段

```yaml
schema: nbook.outline-entry/v2
kind: chapter
status: draft | adopted
title: 第X章：[章节名]
parentId: [卷纲ID]
chapterId: null
materialRefs:
  - lorebook/character/protagonist.md
  - lorebook/location/mansion.md
writingGuidance: "整体节奏快，强调紧张气氛"
references:
  - path: lorebook/character/protagonist.md
    locator: 性格设定部分
    purpose: 参考主角童年创伤
targetWords: 3000
```

### Body 内容模板

```markdown
# 章节目标

[本章要达成的具体目标]

# 场景设定

**时间**：[具体时间]  
**地点**：[具体地点]  
**出场人物**：[人物列表]

# 剧情概要

[本章的完整剧情流程，200-500 字]

# 关键场景

## 场景一：[场景名称]
**目标**：[场景目标]  
**冲突**：[场景冲突]  
**结果**：[场景结果]

## 场景二：[场景名称]
**目标**：[场景目标]  
**冲突**：[场景冲突]  
**结果**：[场景结果]

## 场景三：[场景名称]
**目标**：[场景目标]  
**冲突**：[场景冲突]  
**结果**：[场景结果]

# 人物变化

**主角**：[本章主角的状态变化]  
**其他角色**：[其他角色的变化]

# 伏笔处理

**埋设**：[本章埋下的伏笔]  
**回收**：[本章回收的伏笔]

# 章节结尾

[本章如何结束，为下一章留下什么悬念]
```

### Body 内标记（新增功能）

章节大纲的 body 中可以使用伏笔标记：

```markdown
# 剧情概要

林默独自坐在书房里，<foreshadow id="fo-001" action="plant">突然感到一阵寒意</foreshadow>。
他回忆起师父的警告，<foreshadow id="fo-002" action="reinforce">天机不可泄露</foreshadow>。
```

**标记语法**：
- `<foreshadow id="伏笔ID" action="plant|reinforce|recover">内容</foreshadow>`
- `action` 取值：`plant`（埋设）、`reinforce`（强化）、`recover`（回收）

### 约束规则

1. **必需章节**：章节目标、场景设定、剧情概要、章节结尾
2. **场景数量**：建议 2-5 个关键场景
3. **篇幅建议**：500-1500 字
4. **必需字段**：`materialRefs`（本章使用的素材）、`writingGuidance`（写作指导）、`targetWords`（目标字数）
5. **可选字段**：`references`（参考文献清单）

### Agent 生成提示

生成章节大纲时，AI 应该：
- 明确章节的具体目标
- 提供可执行的场景划分（2-5 个）
- 说明人物在本章的变化
- 标注伏笔的埋设和回收
- 为细纲展开提供清晰的结构
- 必须指定 `materialRefs` 和 `targetWords`

---

## 五、细纲（Detail）

### 职责

依托章节大纲生成，对章节大纲进行细化和文本丰富。细纲是写作前的最后一级规划，包含具体的情节安排、对话意图、描写提示和写作约束。

### 必需结构化字段

```yaml
schema: nbook.outline-entry/v2
kind: detail
status: draft | adopted
title: 第X章：[章节名] - 细纲
parentId: [章节大纲ID]
chapterId: [章节大纲ID]
materialRefs:
  - lorebook/character/protagonist.md
  - lorebook/location/mansion.md
writingGuidance: "第一人称视角，强调主角内心矛盾"
references:
  - path: lorebook/character/protagonist.md
    locator: 童年创伤部分
    purpose: 参考主角心理状态
targetWords: 3000
analysis:  # 细纲特有：偏差和冲突分析结果
  reportId: report-123
  planId: plan-a
  sourceHash: sha256:...
  contextHash: sha256:...
  summary: 已审阅，与章节大纲一致
  deviations: []
  conflicts: []
  resolutions: []

# 新增：段落级别标注（未来功能）
guides:
  - id: g1
    wordCount: 500
    perspective: first
    emotion: tense
    customInstructions: 强调内心矛盾
detailReferences:
  - id: r1
    sources:
      - path: lorebook/character/protagonist.md
        note: 参考童年创伤部分
```

### Body 内容模板

```markdown
# 开场 (约500字)

## 场景描述
[详细的场景描写提示]

## 人物状态
[人物的初始状态和情绪]

## 氛围营造
[需要营造的氛围和情绪]

---

# 剧情展开 (约1500字)

## 段落一：[小节名称]

**剧情**：[具体发生的事情]  
**对话意图**：[如果有对话，说明对话的目的]  
**描写重点**：[需要重点描写的内容]  
**情绪基调**：[这一段的情绪]

[可选：具体的细节提示]

## 段落二：[小节名称]

**剧情**：[具体发生的事情]  
**对话意图**：[如果有对话，说明对话的目的]  
**描写重点**：[需要重点描写的内容]  
**情绪基调**：[这一段的情绪]

## 段落三：[小节名称]

**剧情**：[具体发生的事情]  
**转折点**：[如果有转折，说明转折的时机和方式]  
**描写重点**：[需要重点描写的内容]

---

# 高潮 (约800字)

## 冲突爆发
[冲突如何达到顶点]

## 关键动作
[关键的动作和决策]

## 情绪渲染
[如何渲染高潮情绪]

---

# 收尾 (约200字)

## 结果
[事件的结果]

## 人物变化
[人物状态的变化]

## 悬念
[为下一章留下的悬念]

---

# 写作提示

- [提示1：具体的写作技巧或注意事项]
- [提示2：需要避免的写作问题]
- [提示3：与前后章节的衔接要点]
```

### Body 内标记（段落级别标注，新增功能）

细纲的 body 中可以使用段落级别的写作指导和参考文献标注：

```markdown
# 开场 (约500字)

## 场景描述

<guide id="g1">雨水敲打着窗棂，林默独自坐在昏暗的书房里。烛火摇曳，照亮桌上那封陈旧的信笺。</guide>

## 人物内心

<reference id="r1">他回忆起师父临终前的警告：「天机不可泄露，否则反噬自身。」这句话一直萦绕在他心头，像一道无法解开的魔咒。</reference>
```

**标记语法**：
- `<guide id="标注ID">段落内容</guide>` - 写作指导标注
- `<reference id="标注ID">段落内容</reference>` - 参考文献标注

### 约束规则

1. **必需章节**：开场、剧情展开、高潮、收尾
2. **段落数量**：剧情展开建议 3-6 个段落
3. **篇幅分配**：必须明确各部分的目标字数
4. **必需字段**：`chapterId`（所属章节）、`materialRefs`、`writingGuidance`、`targetWords`
5. **特有字段**：`analysis`（与章节大纲的偏差分析结果）
6. **新增字段**（未来）：`guides`（段落级别写作指导）、`detailReferences`（段落级别参考文献）
7. **保存前校验**：正式采用的细纲必须先运行与章节大纲的偏差和冲突分析

### 素材索引继承规则

细纲的 `materialRefs` 默认继承所属章节大纲的索引，并可局部调整：

- **继承**：未声明的类别沿用章节大纲索引
- **追加**：细纲自己声明的条目与继承结果取并集
- **排除**：显式移除某个继承条目（需要在 frontmatter 中标注排除项）
- **覆盖**：细纲声明了该类别时，用细纲的条目替换章节大纲在该类别的全部条目

### Agent 生成提示

生成细纲时，AI 应该：
- 提供可直接用于写作的具体细节
- 明确各段落的剧情、对话意图、描写重点
- 分配具体字数到各部分（总和应接近 `targetWords`）
- 包含写作技巧提示和注意事项
- 标注需要参考的 lorebook 具体部分
- 生成后必须运行与章节大纲的偏差分析
- 如果使用段落级别标注，应该合理分配标注数量（不要过密）

---

## 六、字段使用规则总结

| 字段 | total | volume | chapter | detail | 说明 |
|---|---|---|---|---|---|
| `kind` | total | volume | chapter | detail | 必需，固定值 |
| `title` | ✅ | ✅ | ✅ | ✅ | 必需 |
| `parentId` | null | [总纲ID] | [卷纲ID] | [章节ID] | 必需 |
| `chapterId` | null | null | null | [章节ID] | 仅 detail 需要 |
| `materialRefs` | 可选 | 可选 | ✅ 必需 | ✅ 必需（可继承） | 素材清单 |
| `writingGuidance` | ❌ | ❌ | ✅ 必需 | ✅ 必需 | 全局写作指导 |
| `references` | ❌ | ❌ | 可选 | 可选 | 条目级别参考文献 |
| `targetWords` | ❌ | 可选 | ✅ 必需 | ✅ 必需 | 目标字数 |
| `analysis` | ❌ | ❌ | ❌ | ✅ 特有 | 偏差分析结果 |
| `guides` | ❌ | ❌ | ❌ | 未来 | 段落级别写作指导 |
| `detailReferences` | ❌ | ❌ | ❌ | 未来 | 段落级别参考文献 |

### Body 篇幅建议

| 层级 | 建议篇幅 | 原因 |
|---|---|---|
| 总纲 | 1000-3000 字 | 需要完整表达故事结构，但不应过于细节 |
| 卷纲 | 800-2000 字 | 需要清晰的阶段划分，但为章节留出空间 |
| 章节大纲 | 500-1500 字 | 需要可执行的场景划分，但细节留给细纲 |
| 细纲 | 与 `targetWords` 的 30-50% | 提供足够的细节指导，但不是正文本身 |

---

## 七、模板校验规则

### 自动校验（保存时）

1. **必需字段检查**：根据 `kind` 检查必需字段是否存在
2. **篇幅检查**：body 字数是否在建议范围内（警告级别）
3. **章节结构检查**：body 中是否包含必需的 Markdown 标题（`# 核心冲突`、`# 章节目标` 等）
4. **父子关系检查**：`parentId` 和 `chapterId` 是否指向正确的条目类型
5. **伏笔标记检查**：`<foreshadow>` 标签格式是否正确，引用的伏笔 ID 是否存在
6. **段落标注检查**（未来）：`<guide>` 和 `<reference>` 标签是否有对应的 frontmatter 元数据

### 细纲特殊校验

细纲保存为"正式采用"状态时，必须额外执行：

1. **偏差分析**：与所属章节大纲进行 AI 偏差和冲突分析
2. **结果展示**：向用户展示偏差和冲突
3. **确认流程**：
   - 讨论模式：用户确认后才能保存
   - 自动模式：可带警告保存并记录可撤销结果
4. **analysis 字段**：保存分析结果到 `analysis` 字段

---

## 八、Agent 生成指引

### 生成流程

1. **读取上级大纲**：理解父条目的内容和约束
2. **读取素材**：根据 `materialRefs` 读取相关 lorebook 条目
3. **应用模板**：根据条目 `kind` 选择对应模板
4. **生成内容**：填充模板各章节
5. **校验格式**：确保符合模板要求
6. **返回草稿**：生成结果标记为 `status: draft`，需要用户审阅后才能正式采用

### 生成约束

- 总纲生成：不需要参考父条目，但需要理解作品背景
- 卷纲生成：必须参考总纲，保持一致性
- 章节大纲生成：必须参考卷纲和总纲
- 细纲生成：必须参考章节大纲，保持严格一致性

### 生成提示模板

```
你是一个专业的小说大纲规划助手。请根据以下信息生成[总纲/卷纲/章节大纲/细纲]：

**上级大纲**：
[父条目的内容]

**参考素材**：
[materialRefs 指定的 lorebook 内容]

**用户要求**：
[用户的具体要求]

**模板要求**：
[对应层级的模板结构]

请严格按照模板结构生成，确保：
1. 包含所有必需章节
2. 篇幅控制在建议范围内
3. 与上级大纲保持一致
4. [其他特定于该层级的要求]

生成的内容将标记为草稿，需要用户审阅后才能正式采用。
```

---

## 九、未来扩展

### 段落级别标注系统

细纲的段落级别标注功能（`<guide>` 和 `<reference>`）是规划中的未来功能，详见 [detail-writing-guide-annotation.md](./detail-writing-guide-annotation.md)。

### 自定义模板

未来可以支持用户自定义各层级的模板结构，但默认模板应该保持稳定。

### 模板版本

随着功能演进，模板可能需要升级。建议在模板定义中加入版本号，支持模板迁移。

---

**参考文档**：
- [outline-planning-module.md](../../proposals/outline-planning-module.md) - 大纲规划模块提案
- [detail-writing-guide-annotation.md](./detail-writing-guide-annotation.md) - 细纲写作指导标注系统
- [format.ts](../../packages/neuro-book/server/outline/format.ts) - OutlineEntry 类型定义
