# Agent 会话管理与专家可见性实现

## 概述

本文档记录大纲规划模块 Agent 会话管理和专家调用可见性的实现。

## 阶段 1：会话持久化 ✅

### 存储扩展

扩展了 `OutlineWorkbenchRecord` 类型以支持会话管理：

```typescript
{
  activeSessionId?: number | null;
  sessions?: readonly {
    sessionId: number;
    title?: string;
    createdAt: number;
    lastActiveAt: number;
  }[];
}
```

**文件：**
- `shared/storage/outline-workbench.ts` - 类型定义与验证
- `app/utils/outline/outline-workbench-session.ts` - 补丁与状态解析

### Composable 增强

`useOutlineWorkbenchAgent` 添加了完整的会话管理功能：

**新增函数：**
- `createNewSession()` - 创建新会话并保存到工作台记录
- `switchSession(sessionId)` - 切换到指定会话
- `deleteSession(sessionId)` - 删除会话，自动切换到其他会话
- `renameSession(sessionId, title)` - 重命名会话

**持久化机制：**
- 会话创建时自动保存元数据
- 切换会话时更新 `lastActiveAt` 时间戳
- 项目切换时保留 `activeSessionId`，下次打开自动恢复
- 删除当前活动会话时智能切换到最近使用的会话

**文件：**
- `app/composables/useOutlineWorkbenchAgent.ts`

## 阶段 2：会话管理 UI ✅

### 会话列表组件

创建了 `OutlineAgentSessionList.vue` 组件：

**功能：**
- 显示所有会话，按最后活动时间排序
- 高亮当前活动会话
- 点击切换会话
- 内联编辑会话标题（双击或点击编辑按钮）
- 删除会话（带确认提示）
- 创建新会话按钮

**文件：**
- `app/components/novel-ide/outline/OutlineAgentSessionList.vue`

### 集成到 Agent 面板

在 `OutlineWorkbenchAgentPane.vue` 中集成：

**UI 变化：**
- 头部添加历史按钮（`i-lucide-history`）
- 点击按钮切换显示会话列表或对话流
- 会话列表与对话流互斥显示

**事件处理：**
- `handleCreateSession` - 创建新会话
- `handleSelectSession` - 切换会话
- `handleDeleteSession` - 删除会话
- `handleRenameSession` - 重命名会话

**文件：**
- `app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue`

## 阶段 3：专家 Agent 可见性 ✅

### 专家工具调用标识

创建了 `SpecialistToolCallBubble.vue` 组件，用于标注专家调用：

**识别工具：**
- `consult_planning_specialist` - 咨询模式
- `delegate_planning_task` - 委派模式

**显示信息：**
- 专家名称（伏笔专家、细纲专家、大纲专家）
- 专家图标（sparkle、file-text、list-tree）
- 模式徽章（咨询建议、委派产出）
- 查看会话按钮（提取 `sessionId` 后显示）

**视觉设计：**
- 左侧彩色边框标识
- 浅色背景突出显示
- 模式徽章使用 accent 色

**文件：**
- `app/components/novel-ide/agent/bubbles/SpecialistToolCallBubble.vue`

### 工具气泡集成

修改 `AgentToolBubble.vue` 以集成专家标识：

**变化：**
- 检测专家工具调用（`isSpecialistTool` computed）
- 在工具节点前显示 `SpecialistToolCallBubble`
- 传递 `view-specialist-session` 事件到父组件

**文件：**
- `app/components/novel-ide/agent/bubbles/tools/AgentToolBubble.vue`

### 事件链路

完整的事件传递链：

```
SpecialistToolCallBubble (click)
  → AgentToolBubble (@view-specialist-session)
  → AgentChatFlow (@view-specialist-session)
  → OutlineWorkbenchAgentPane (handleViewSpecialistSession)
  → switchSession + showSessionList
```

**行为：**
- 点击专家会话按钮后，自动切换到该专家会话
- 打开会话列表，用户可以看到专家会话并继续交互

**文件：**
- `app/components/novel-ide/agent/flow/AgentChatFlow.vue`
- `app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue`

## 技术细节

### 专家会话创建

专家会话由主 Agent 通过工具调用创建：

```typescript
// planning-specialist-tool.ts
const created = await context.harness.createAgent({
    profileKey,  // outline.foreshadowing / outline.detailed / outline.outline
    initial: {projectRoot},
    parentSessionId: context.sessionId,  // 链接到主会话
    currentProjectRoot: projectRoot,
    title: SPECIALIST_TITLES[specialist],
});
```

### 会话恢复逻辑

```typescript
// useOutlineWorkbenchAgent.ts - ensureSession()
const savedSessionId = options?.workbenchSession?.state.value.activeSessionId;
if (savedSessionId && (!activeSessionId.value || activeSessionId.value !== savedSessionId)) {
    // 尝试恢复会话
    const recovery = await api.getSessionRecovery(savedSessionId);
    // 如果失败，清除保存的 ID 并创建新会话
}
```

### 会话元数据提取

从工具调用结果中提取专家会话 ID：

```typescript
// SpecialistToolCallBubble.vue
const sessionId = computed(() => {
    const details = props.toolCall.resultDetails;
    if (details && typeof details === "object" && "sessionId" in details) {
        return (details as any).sessionId as number;
    }
    return null;
});
```

## 验证

构建验证通过，无类型错误：

```bash
bun run build 2>&1 | grep -E "useOutlineWorkbenchAgent|SpecialistToolCallBubble"
# (无输出 = 无错误)
```

## 下一步

可选的增强功能：

1. **会话详情面板**
   - 显示会话的完整对话历史
   - 支持在专家会话中继续对话
   - 显示会话创建时间、最后活动时间等元数据

2. **会话归档**
   - 归档不再需要的会话
   - 区分活动会话和归档会话

3. **会话搜索**
   - 按标题或内容搜索会话
   - 过滤不同类型的会话（主会话 vs 专家会话）

4. **会话统计**
   - 显示会话消息数量
   - 显示会话 token 使用量
   - 显示会话创建者（用户 vs 系统）
