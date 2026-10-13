# 伏笔标记语法与使用指南

## 概述

伏笔标记用于在章节大纲正文中标注伏笔的埋设（plant）、强化（reinforce）和回收（recover）位置。标记使用 HTML 注释语法，既可以在 UI 中渲染为可视化标记，也保持文件的纯文本可读性。

## 标记语法

### 基本格式

```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->标记文本<!-- /nb:foreshadow marker="fm-01" -->
```

### 属性说明

- **`marker`**：标记 ID，在同一章节内必须唯一（例如：`fm-01`、`fm-02`）
- **`foreshadow`**：引用的伏笔对象 ID（例如：`fo-b9fd550e`）
- **`action`**：伏笔动作类型
  - `plant`：埋设（首次提及）
  - `reinforce`：强化（后续提及、铺垫）
  - `recover`：回收（揭示、兑现）

### 配对规则

- 开始标签：`<!-- nb:foreshadow ... -->`
- 结束标签：`<!-- /nb:foreshadow marker="fm-01" -->`
- 结束标签只需要包含 `marker` 属性
- 开始和结束标签必须成对出现
- `marker` 值必须完全匹配

## 使用示例

### 1. 埋设伏笔（plant）

在第一次提及时使用 `action="plant"`：

```markdown
第三章正文...

<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->，闪烁着微弱的光芒。

继续正文...
```

### 2. 强化伏笔（reinforce）

在后续章节中再次提及时使用 `action="reinforce"`：

```markdown
第五章正文...

<!-- nb:foreshadow marker="fm-02" foreshadow="fo-001" action="reinforce" -->那条银纹项链又一次出现在她的视线中<!-- /nb:foreshadow marker="fm-02" -->，这次她感到了一丝不安。

继续正文...
```

### 3. 回收伏笔（recover）

在揭示真相或兑现伏笔时使用 `action="recover"`：

```markdown
第九章正文...

<!-- nb:foreshadow marker="fm-03" foreshadow="fo-001" action="recover" -->原来那条银纹项链是她母亲留下的唯一遗物<!-- /nb:foreshadow marker="fm-03" -->，真相终于揭晓。

继续正文...
```

### 4. 同一章节多个标记

```markdown
第七章正文...

<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="reinforce" -->银纹项链再次闪光<!-- /nb:foreshadow marker="fm-01" -->。

中间段落。

<!-- nb:foreshadow marker="fm-02" foreshadow="fo-002" action="plant" -->她发现了一个神秘的盒子<!-- /nb:foreshadow marker="fm-02" -->。
```

### 5. 多行标记内容

标记内容可以包含换行：

```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->她打开了抽屉，
里面静静地躺着一条银纹项链，
散发着幽暗的光芒<!-- /nb:foreshadow marker="fm-01" -->。
```

## 约束与限制

### 必须遵守的规则

1. **标记 ID 唯一性**：同一章节内的 `marker` ID 不能重复
2. **配对完整性**：每个开始标签必须有对应的结束标签
3. **不可嵌套**：标记不能嵌套或交叉
4. **伏笔存在性**：`foreshadow` 必须引用已存在的伏笔对象
5. **动作合法性**：`action` 只能是 `plant`、`reinforce` 或 `recover`

### 违规示例与错误

❌ **重复 marker ID**：
```markdown
<!-- nb:foreshadow marker="fm-01" ... -->第一次<!-- /nb:foreshadow marker="fm-01" -->
<!-- nb:foreshadow marker="fm-01" ... -->第二次<!-- /nb:foreshadow marker="fm-01" -->
```
错误：`marker 在文档内不唯一`

❌ **未配对标记**：
```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->文本
```
错误：`开始标记未闭合`

❌ **嵌套标记**：
```markdown
<!-- nb:foreshadow marker="fm-01" ... -->外层<!-- nb:foreshadow marker="fm-02" ... -->内层<!-- /nb:foreshadow marker="fm-02" --><!-- /nb:foreshadow marker="fm-01" -->
```
错误：`标记不能嵌套或交叉`

❌ **未知伏笔 ID**：
```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-999" action="plant" -->文本<!-- /nb:foreshadow marker="fm-01" -->
```
错误：`未知伏笔 ID: fo-999`

## Agent 工具使用

### 1. 读取伏笔上下文

使用 `get_foreshadowing_context` 读取章节正文和现有标记：

```typescript
{
  foreshadowingId: "fo-001",  // 可选：只读取特定伏笔相关的章节
  entryIds: ["ol-chapter-3", "ol-chapter-9"]  // 可选：只读取特定章节
}
```

返回的 `entries` 数组包含章节的 `body` 字段，其中包含现有标记。

### 2. 提出标记建议

使用 `suggest_foreshadowing_marker` 提出添加或修改标记的建议：

```typescript
{
  action: "strengthen",  // plant=plant, strengthen=reinforce, resolve=recover
  expectedRevision: 5,
  planId: "plan-xxx",
  entryId: "ol-chapter-3",
  foreshadowingId: "fo-001",
  expectedVersion: 2,
  expectedContentHash: "sha256:...",
  body: "原始正文...<!-- nb:foreshadow marker=\"fm-01\" foreshadow=\"fo-001\" action=\"reinforce\" -->新增标记文本<!-- /nb:foreshadow marker=\"fm-01\" -->...",
  rationale: "在第三章强化银纹项链的印象"
}
```

**重要**：
- `action` 参数使用 `plant`（对应 `plant`，章节还没有任何标记时也用它）、`strengthen`（对应 `reinforce`）和 `resolve`（对应 `recover`）
- `body` 参数必须包含完整的带标记的正文
- 标记语法必须正确，否则会校验失败

### 3. 确认并应用

建议通过校验后，使用 `apply_planning_change` 应用变更。

## 工作流程

### 完整的伏笔标记流程

1. **创建伏笔对象**：
   ```typescript
   preview_planning_change({
     operation: "mutate",
     expectedRevision: 5,
     action: {
       kind: "create-foreshadowing",
       title: "银纹项链的秘密",
       body: "...",
       surface: "银纹项链",
       connection: "母亲遗物"
     }
   })
   ```

2. **读取章节上下文**：
   ```typescript
   get_foreshadowing_context({
     foreshadowingId: "fo-001",
     entryIds: ["ol-chapter-3"]
   })
   ```

3. **构造带标记的正文**：
   ```markdown
   原始章节正文...
   
   <!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->
   
   继续正文...
   ```

4. **提出标记建议**：
   ```typescript
   suggest_foreshadowing_marker({
     action: "strengthen",  // 对应 action="reinforce"
     planId: "plan-xxx",
     entryId: "ol-chapter-3",
     foreshadowingId: "fo-001",
     expectedVersion: 2,
     expectedContentHash: "sha256:...",
     body: "...(带标记的完整正文)...",
     rationale: "埋设银纹项链伏笔"
   })
   ```

5. **应用变更**：
   ```typescript
   apply_planning_change({
     changes: [{
       ...预览返回的 change 对象
     }]
   })
   ```

## 线路图与伏笔顺序

伏笔的时序判断基于线路图节点的格号（column）：
- 同一方案内，格号小的节点在时间上先于格号大的节点
- 伏笔必须遵循"先 plant，后 reinforce，最后 recover"的顺序
- 跨线路的伏笔仍按格号判断时序
- 同格不同节点不算"之后"

## 故障排查

### 常见错误及解决方法

| 错误信息 | 原因 | 解决方法 |
|---------|------|---------|
| `候选正文没有 reinforce 伏笔标记` | body 中缺少正确的标记 | 确保 body 包含 `action="reinforce"` 的标记 |
| `marker 在文档内不唯一` | 同一章节内 marker ID 重复 | 使用不同的 marker ID（如 fm-01, fm-02） |
| `未知伏笔 ID` | 引用的伏笔对象不存在 | 先创建伏笔对象，或检查 ID 是否正确 |
| `开始标记未闭合` | 缺少结束标签 | 添加对应的 `<!-- /nb:foreshadow marker="..." -->` |
| `标记不能嵌套或交叉` | 标记重叠 | 调整标记位置，确保不重叠 |

### 调试技巧

1. **使用简单示例**：先用最简单的单个标记测试
2. **逐步添加**：一次只添加一个标记，确保每次都能通过校验
3. **检查 ID**：确认伏笔 ID 存在且拼写正确
4. **查看现有标记**：通过 `get_foreshadowing_context` 查看现有标记的格式

## 参考

- 设计文档：[ADR 0022](../../docs/adr/0022-outline-planning-canonical-files.md)
- 行为规范：`docs/specs/outline/foreshadowing.md`
- 实现代码：[format.ts](./format.ts) 中的 `parseForeshadowMarkers` 函数
