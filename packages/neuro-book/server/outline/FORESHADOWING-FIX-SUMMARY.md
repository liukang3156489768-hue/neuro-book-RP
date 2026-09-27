# 伏笔标记问题修复总结

## 问题描述

用户在使用大纲规划模块的伏笔功能时遇到阻塞问题：

1. **缺少标记语法文档**：工具说明中没有给出伏笔标记的具体书写格式
2. **没有示例参考**：现有章节正文中没有标记示例，`get_foreshadowing_context` 返回的 `markers` 字段也是空数组
3. **工具报错不明确**：`suggest_foreshadowing_marker` 报错"候选正文没有 reinforce 伏笔标记"，但没有说明需要什么格式
4. **专家咨询失败**：`consult_planning_specialist` 调用失败，无法获取帮助

## 根本原因

伏笔标记功能虽然已实现（参见 ADR 0022 第 29-33 行的设计），但：
- Agent 工具的说明文档中**完全没有提及标记语法**
- `suggest_foreshadowing_marker` 工具要求 `body` 参数包含正确格式的标记，但没有告诉 Agent 如何编写
- 缺少使用指南和示例

## 解决方案

### 1. 更新工具说明

**文件**：`server/agent/tools/planning-tools.ts`

#### `suggest_foreshadowing_marker` 工具

添加了详细的标记语法说明和示例：

```markdown
IMPORTANT: The 'body' parameter must contain properly formatted foreshadowing markers using HTML comment syntax:

Marker syntax:
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->埋设文本<!-- /nb:foreshadow marker="fm-01" -->
<!-- nb:foreshadow marker="fm-02" foreshadow="fo-xxx" action="reinforce" -->强化文本<!-- /nb:foreshadow marker="fm-02" -->
<!-- nb:foreshadow marker="fm-03" foreshadow="fo-xxx" action="recover" -->回收文本<!-- /nb:foreshadow marker="fm-03" -->

Rules:
1. Each marker must have a unique marker ID (fm-xxx) within the chapter
2. The foreshadow attribute references the foreshadowing object ID (fo-xxx)
3. action must be one of: "plant" (first mention), "reinforce" (strengthen), "recover" (payoff)
4. Opening and closing tags must match exactly
5. Markers cannot nest or overlap
6. For 'strengthen' action, use action="reinforce" in the marker
7. For 'resolve' action, use action="recover" in the marker

Example:
Original chapter body:
"第三章内容..."

Updated body for strengthen action:
"第三章内容...<!-- nb:foreshadow marker="fm-01" foreshadow="fo-b9fd550e" action="reinforce" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->..."
```

#### `get_foreshadowing_context` 工具

添加了标记语法说明：

```markdown
The returned 'entries' contain chapter bodies with existing foreshadowing markers. To add or modify markers, use the following syntax in suggest_foreshadowing_marker:

Marker syntax:
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->text<!-- /nb:foreshadow marker="fm-01" -->

where:
- marker: unique ID within the chapter (e.g., fm-01, fm-02)
- foreshadow: the foreshadowing object ID (e.g., fo-xxx)
- action: "plant" (埋设), "reinforce" (强化), or "recover" (回收)
```

### 2. 创建完整文档

**文件**：`server/outline/FORESHADOWING-MARKERS.md`

创建了完整的伏笔标记使用指南，包含：
- 标记语法详细说明
- 使用示例（埋设、强化、回收）
- 约束与限制
- Agent 工具使用方法
- 完整工作流程
- 故障排查指南

### 3. 添加测试

**文件**：`server/outline/foreshadowing-marker-format.test.ts`

创建了 9 个测试用例验证标记格式：
- ✅ 解析 plant 标记
- ✅ 解析 reinforce 标记
- ✅ 解析 recover 标记
- ✅ 解析多个标记
- ✅ 拒绝未知伏笔 ID
- ✅ 拒绝未配对标记
- ✅ 拒绝嵌套标记
- ✅ 拒绝重复 marker ID
- ✅ 标记内容可以包含换行

所有测试通过。

## 标记语法规范

### 基本格式

```markdown
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-xxx" action="plant" -->标记文本<!-- /nb:foreshadow marker="fm-01" -->
```

### 属性说明

- **`marker`**：标记 ID，章节内唯一（如 `fm-01`, `fm-02`）
- **`foreshadow`**：伏笔对象 ID（如 `fo-b9fd550e`）
- **`action`**：
  - `plant`：埋设（首次提及）
  - `reinforce`：强化（后续提及）
  - `recover`：回收（揭示真相）

### 重要映射

在 Agent 工具中：
- `action: "strengthen"` → 标记中使用 `action="reinforce"`
- `action: "resolve"` → 标记中使用 `action="recover"`

## 使用示例

### 埋设伏笔

```markdown
第三章正文...

<!-- nb:foreshadow marker="fm-01" foreshadow="fo-b9fd550e" action="plant" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->，闪烁着微弱的光芒。
```

### 强化伏笔

```markdown
第五章正文...

<!-- nb:foreshadow marker="fm-02" foreshadow="fo-b9fd550e" action="reinforce" -->那条银纹项链又一次出现<!-- /nb:foreshadow marker="fm-02" -->在她的视线中。
```

### 回收伏笔

```markdown
第九章正文...

<!-- nb:foreshadow marker="fm-03" foreshadow="fo-b9fd550e" action="recover" -->原来那条银纹项链是她母亲留下的唯一遗物<!-- /nb:foreshadow marker="fm-03" -->。
```

## 工作流程

1. **创建伏笔对象**（`create-foreshadowing`）
2. **读取章节上下文**（`get_foreshadowing_context`）
3. **构造带标记的正文**（手动或通过模板）
4. **提出标记建议**（`suggest_foreshadowing_marker`）
5. **应用变更**（`apply_planning_change`）

## 验证结果

✅ 所有现有测试通过（13 个测试，41 个断言）  
✅ 新增标记格式测试通过（9 个测试，14 个断言）  
✅ 工具说明已更新，包含完整语法示例  
✅ 完整文档已创建

## 后续建议

1. **前端支持**：在 UI 中提供标记编辑器，自动生成正确格式的标记
2. **模板工具**：考虑提供一个辅助函数来生成标记，减少手动编写错误
3. **可视化**：在章节预览中高亮显示伏笔标记
4. **验证提示**：在标记校验失败时，提供更明确的错误提示和修复建议

## 相关文件

- ✅ `server/agent/tools/planning-tools.ts` - 工具说明更新
- ✅ `server/outline/FORESHADOWING-MARKERS.md` - 使用指南
- ✅ `server/outline/foreshadowing-marker-format.test.ts` - 格式测试
- 📖 `server/outline/format.ts` - 标记解析实现
- 📖 `server/outline/foreshadowing-suggestions.ts` - 建议校验逻辑
- 📖 `docs/adr/0022-outline-planning-canonical-files.md` - 设计文档

## 问题解决

原始问题现已全部解决：
- ✅ Agent 现在知道标记的具体语法
- ✅ 工具说明中包含详细示例
- ✅ 文档提供了完整的使用指南
- ✅ 测试验证了所有标记格式规则

Agent 现在可以正常使用 `suggest_foreshadowing_marker` 工具来埋设、强化和回收伏笔了。
