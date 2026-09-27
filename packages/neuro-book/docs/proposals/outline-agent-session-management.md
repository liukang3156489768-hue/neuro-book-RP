# 大纲规划模块 Agent 会话管理优化方案

## 问题分析

### 1. 会话不持久化

**当前行为**：
- 会话在退出工作台时被清空（`onScopeDispose` 调用 `resetForProject`）
- 重启项目后会话消失
- 每次打开工作台都创建新会话

**代码位置**：
- `app/composables/useOutlineWorkbenchAgent.ts` 第 200-218 行
- `resetForProject()` 在 `watch(() => projectRoot)` 和 `onScopeDispose` 中被调用

**根本原因**：
- `activeSessionId` 只存储在内存中（ref），没有持久化
- 工作台会话记录（`OutlineWorkbenchRecord`）只保存 UI 状态，不保存 Agent 会话 ID

### 2. 无法管理多个会话

**当前行为**：
- 只有一个 `activeSessionId`
- 没有会话列表 UI
- 无法新建/切换/删除会话

**缺失功能**：
- 会话历史列表
- 新建会话按钮
- 切换会话能力
- 删除/归档会话

### 3. 专家 Agent 输出不可见

**当前行为**：
- 委托给专家 Agent（foreshadowing/detailed/outline specialist）时
- 主会话看不到专家的处理过程
- 只能看到最终结果

**根本原因**：
- 专家 Agent 是子会话（`parentSessionId`）
- 前端只监听主会话的 SSE 流
- 没有展示子会话消息的机制

## 解决方案

### 方案 A：完整的会话管理系统（推荐）

#### 1. 持久化会话 ID

**修改 `OutlineWorkbenchRecord`**：
```typescript
// shared/storage/outline-workbench.ts
export type OutlineWorkbenchRecord = {
    agentWidth?: number;
    activeView?: OutlineWorkbenchView;
    thinkingEnabled?: boolean;
    modelKey?: string;
    temperature?: number;
    mode?: OutlineWorkbenchMode;
    // 新增：会话管理
    sessions?: Array<{
        sessionId: number;
        title?: string;
        createdAt: number;
        lastActiveAt: number;
    }>;
    activeSessionId?: number | null;  // 新增：当前活动会话
};
```

**修改 `useOutlineWorkbenchAgent`**：
- 从工作台记录中恢复 `activeSessionId`
- 会话创建后保存到工作台记录
- 不在 `projectRoot` 变化时清空会话
- 只在用户明确删除时清空会话

#### 2. 会话列表 UI

**新增组件**：`OutlineAgentSessionPanel.vue`

功能：
- 显示当前项目的所有会话
- 会话列表项显示：标题、最后消息、时间
- 操作按钮：新建会话、切换会话、删除会话、重命名会话

**集成位置**：
- 在 `OutlineWorkbenchAgentPane.vue` 顶部添加会话选择器
- 或者在工具栏添加会话管理按钮，打开侧边栏

#### 3. 子会话可见性

**方案 3.1：在主会话中展示子会话消息**

修改 `useAgentSessionStream` 订阅子会话：
```typescript
// 订阅主会话
stream.subscribe(mainSessionId)

// 查询子会话并订阅
const subSessions = await api.getChildSessions(mainSessionId)
for (const sub of subSessions) {
    stream.subscribe(sub.sessionId)
}
```

前端消息流中标注消息来源：
- 主会话消息正常显示
- 子会话消息添加"来自专家"标记
- 可折叠/展开子会话详情

**方案 3.2：独立的子会话查看器**

- 在主会话消息中显示"专家处理中"占位符
- 点击可展开子会话详情对话框
- 对话框中显示完整的专家会话流

### 方案 B：简化方案（快速实现）

如果不想实现完整的会话管理，可以先做最小改动：

#### 1. 持久化单个会话

**只需修改**：
1. `OutlineWorkbenchRecord` 添加 `activeSessionId?: number`
2. `useOutlineWorkbenchAgent` 中：
   - 启动时从记录恢复 `activeSessionId`
   - 会话创建后保存到记录
   - 移除 `watch(() => projectRoot)` 中的 `resetForProject()` 调用
   - 只在明确的"清空会话"操作中调用 `resetForProject()`

#### 2. 添加"新建会话"按钮

在 Agent 面板顶部添加：
- "新建会话"按钮 → 创建新会话并切换
- "清空会话"按钮 → 清空当前会话并创建新的

#### 3. 子会话暂不处理

保持当前行为，专家处理过程不可见，只显示最终结果。

## 实施计划

### 阶段 1：持久化会话（优先级高）

**文件修改**：
1. `shared/storage/outline-workbench.ts` - 添加会话字段
2. `app/composables/useOutlineWorkbenchAgent.ts` - 持久化逻辑
3. `app/utils/outline/outline-workbench-session.ts` - 序列化/反序列化

**验收标准**：
- ✅ 退出工作台后重新打开，会话仍然存在
- ✅ 重启项目后，会话历史保留
- ✅ 可以继续之前的对话

### 阶段 2：会话管理 UI（优先级中）

**新增文件**：
1. `app/components/novel-ide/outline/OutlineAgentSessionList.vue` - 会话列表
2. `app/components/novel-ide/outline/OutlineAgentSessionItem.vue` - 会话项

**修改文件**：
1. `app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue` - 集成会话选择器

**验收标准**：
- ✅ 可以查看所有会话
- ✅ 可以新建会话
- ✅ 可以切换会话
- ✅ 可以删除会话
- ✅ 可以重命名会话

### 阶段 3：子会话可见性（优先级低）

**修改文件**：
1. `app/composables/useAgentSessionStream.ts` - 支持多会话订阅
2. `app/components/novel-ide/agent/flow/AgentChatFlow.vue` - 展示子会话消息

**验收标准**：
- ✅ 委托专家时，可以看到专家的处理过程
- ✅ 子会话消息与主会话消息有明确区分
- ✅ 可以折叠/展开子会话详情

## 技术细节

### 会话生命周期

```typescript
// 会话创建
const session = await createSession({
    profileKey: "outline.planner",
    currentProjectRoot: root,
    initial: {...},
    kind: "outline-planning",  // 新增：标记为大纲规划会话
    tags: ["outline", projectId],  // 新增：便于查询
})

// 保存到工作台记录
await workbenchSession.commit({
    activeSessionId: session.sessionId,
    sessions: [
        ...existingSessions,
        {
            sessionId: session.sessionId,
            title: "新会话",
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
        }
    ]
})
```

### 会话恢复

```typescript
// 启动时恢复
const record = await workbenchSession.load()
const savedSessionId = record.activeSessionId

if (savedSessionId) {
    try {
        // 验证会话仍然存在
        const recovery = await api.getSessionRecovery(savedSessionId)
        activeSessionId.value = savedSessionId
        session.applyRecovery(recovery)
        await stream.start(savedSessionId)
    } catch (error) {
        // 会话不存在，创建新会话
        await ensureSession()
    }
} else {
    // 首次使用，创建会话
    await ensureSession()
}
```

### 会话列表查询

使用现有的会话仓库 API：

```typescript
// server/agent/session/session-repo.ts 已有
async listSessions(query: AgentSessionListQueryDto): Promise<SessionListResult>

// 查询当前项目的大纲规划会话
const sessions = await api.listSessions({
    currentProjectRoot: projectRoot,
    kinds: ["outline-planning"],
    limit: 50,
})
```

## 数据迁移

### 现有用户迁移

由于现有实现没有持久化会话，不需要数据迁移。新版本启动时：
- 如果 `activeSessionId` 不存在 → 创建新会话（当前行为）
- 如果 `activeSessionId` 存在 → 尝试恢复（新行为）

### 向后兼容

`OutlineWorkbenchRecord` 新增字段都是可选的：
- 旧记录没有 `activeSessionId` → 按当前逻辑创建新会话
- 新记录有 `activeSessionId` → 尝试恢复会话

## 用户体验改进

### 当前体验（差）

1. 用户创建了一个复杂的大纲
2. 与 Agent 讨论了多轮优化
3. 退出工作台去做其他事
4. 再次打开 → **所有对话历史消失** ❌
5. 用户必须重新开始对话

### 优化后体验（好）

1. 用户创建了一个复杂的大纲
2. 与 Agent 讨论了多轮优化
3. 退出工作台去做其他事
4. 再次打开 → **对话历史仍在** ✅
5. 用户可以继续上次的对话
6. 可以新建会话开始新的讨论主题
7. 可以切换回历史会话查看之前的讨论

## 安全性考虑

### 会话隔离

- 会话按项目隔离（`currentProjectRoot`）
- 切换项目时不显示其他项目的会话
- 会话数据存储在项目目录（`.nbook/agent/traces/`）

### 会话清理

- 提供"删除会话"功能
- 可选：自动清理 N 天前的会话
- 可选：限制每个项目的会话数量上限

## 预估工作量

- **阶段 1（持久化）**：2-3 天
- **阶段 2（会话管理 UI）**：3-4 天
- **阶段 3（子会话可见性）**：3-5 天

**总计**：8-12 天

## 后续优化

1. **会话搜索**：在会话列表中搜索消息内容
2. **会话标签**：给会话打标签分类（如"伏笔讨论"、"线路规划"）
3. **会话导出**：导出会话为 Markdown 或 PDF
4. **会话分享**：分享会话给团队成员
5. **会话模板**：基于历史会话创建模板
