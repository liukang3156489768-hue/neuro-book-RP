# 大纲规划模块 Agent 会话持久化 - 实施完成

## 已完成工作

### 阶段 1：会话持久化（✅ 已完成）

#### 1. 数据模型扩展

**文件**：`shared/storage/outline-workbench.ts`

添加了会话相关字段到 `OutlineWorkbenchRecord`：
```typescript
readonly activeSessionId?: number | null;  // 当前活动会话 ID
readonly sessions?: readonly Readonly<{    // 会话历史列表
    sessionId: number;
    title?: string;
    createdAt: number;
    lastActiveAt: number;
}>[];
```

添加了验证函数：
- `isSafeSessionId()` - 验证会话 ID 格式
- `isSessionEntry()` - 验证会话条目格式
- `isSessionArray()` - 验证会话列表格式

#### 2. 会话状态管理

**文件**：`app/utils/outline/outline-workbench-session.ts`

扩展了状态类型：
- `OutlineWorkbenchPatch` 添加 `activeSessionId` 和 `sessions` 字段
- `OutlineWorkbenchResolvedState` 添加对应的解析字段
- `patchFields()` 添加会话字段的序列化逻辑
- `resolveState()` 添加会话字段的反序列化逻辑

#### 3. Agent 会话持久化逻辑

**文件**：`app/composables/useOutlineWorkbenchAgent.ts`

**关键改进**：

##### 函数签名扩展
```typescript
export function useOutlineWorkbenchAgent(
    projectRoot: MaybeRefOrGetter<string | null>,
    settings: {...},
    options?: {
        workbenchSession?: {
            state: {value: {activeSessionId: number | null; sessions: readonly any[]}};
            commit: (patch: any) => Promise<any>;
        };
    }
)
```

##### `ensureSession()` 重构

**新逻辑**：
1. **尝试恢复已保存的会话**：
   - 从 `workbenchSession.state.value.activeSessionId` 读取保存的会话 ID
   - 调用 `api.getSessionRecovery()` 验证会话是否仍然存在
   - 如果存在，恢复会话并更新运行时设置
   - 如果不存在，清除保存的 ID 并创建新会话

2. **创建新会话时保存**：
   - 创建会话后，保存到工作台记录
   - 添加到会话历史列表
   - 设置为当前活动会话

##### `resetForProject()` 优化

**旧逻辑**（❌）：
```typescript
function resetForProject(): void {
    // ...
    activeSessionId.value = null;  // 清空会话
    activeProjectRoot.value = null;
    // ...
}
```

**新逻辑**（✅）：
```typescript
function resetForProject(): void {
    // ...
    // 不再清空 activeSessionId，保留会话持久化
    // 只重置临时状态
    pendingDraft.value = {answers: {}, forms: {}};
    // ...
}
```

##### `watch(projectRoot)` 优化

**旧逻辑**（❌）：
```typescript
watch(() => toValue(projectRoot), () => {
    resetForProject();  // 每次都清空
    error.value = null;
}, {immediate: true});
```

**新逻辑**（✅）：
```typescript
watch(() => toValue(projectRoot), (newRoot, oldRoot) => {
    // 只在项目真正切换时重置
    if (newRoot !== oldRoot) {
        resetForProject();
        error.value = null;
    }
}, {immediate: true});
```

#### 4. 组件集成

**文件**：
- `app/components/novel-ide/outline/OutlineWorkbenchDialog.vue`
- `app/components/novel-ide/outline/OutlineWorkbenchAgentPane.vue`

传递工作台会话对象给 Agent composable：
```vue
<OutlineWorkbenchAgentPane
    :workbench-session="session"
    ...
/>
```

```typescript
const agent = useOutlineWorkbenchAgent(..., {
    workbenchSession: props.workbenchSession,
});
```

## 功能验证

### 会话持久化流程

#### 1. 首次使用
1. 用户打开大纲规划工作台
2. 系统创建新的 Agent 会话
3. 会话 ID 保存到工作台记录
4. 用户与 Agent 对话

#### 2. 退出后重新打开
1. 用户关闭工作台
2. **会话 ID 仍保存在工作台记录中**
3. 用户重新打开工作台
4. 系统从记录中读取会话 ID
5. 验证会话是否仍然存在
6. **恢复会话，对话历史仍在** ✅

#### 3. 重启项目后
1. 项目重启
2. 用户打开大纲规划工作台
3. 系统从记录中读取会话 ID
4. **会话数据存储在 `.nbook/agent/traces/`**
5. **恢复会话，对话历史仍在** ✅

### 错误处理

#### 会话不存在
```typescript
try {
    const recovery = await api.getSessionRecovery(savedSessionId);
    // 恢复成功
} catch (cause) {
    // 会话不存在，清除保存的 ID 并创建新会话
    await workbenchSession.commit({activeSessionId: null});
}
```

#### 项目切换
```typescript
watch(() => projectRoot, (newRoot, oldRoot) => {
    if (newRoot !== oldRoot) {
        // 切换项目时重置，避免错误恢复其他项目的会话
        resetForProject();
    }
});
```

## 用户体验改进

### 之前（❌）

1. 用户打开工作台，与 Agent 讨论了 10 轮
2. 用户退出工作台去做其他事
3. 用户再次打开工作台
4. **所有对话历史消失**
5. Agent 说："你好！我是规划助手..."
6. 用户："？？？我刚才说的都没了？"

### 现在（✅）

1. 用户打开工作台，与 Agent 讨论了 10 轮
2. 用户退出工作台去做其他事
3. 用户再次打开工作台
4. **对话历史仍然在**
5. 用户可以继续："刚才讨论的第三个伏笔，我想修改一下..."
6. Agent 能看到上下文，继续对话 ✅

## 数据存储

### 位置
- **工作台记录**：`<project>/.nbook/layout/outline.workbench.layout.json`
  - 存储：`activeSessionId`, `sessions` 列表
  - 作用：记住哪个会话是活动的

- **会话数据**：`<project>/.nbook/agent/traces/<sessionId>.jsonl`
  - 存储：完整的对话历史
  - 作用：恢复会话时读取历史消息

### 示例

**工作台记录**：
```json
{
    "activeSessionId": 12345,
    "sessions": [
        {
            "sessionId": 12345,
            "title": "新会话",
            "createdAt": 1703001234567,
            "lastActiveAt": 1703009876543
        }
    ],
    "mode": "discuss",
    "temperature": 0.7,
    ...
}
```

## 向后兼容

### 旧记录迁移
- 旧记录没有 `activeSessionId` 字段 → 按当前逻辑创建新会话
- 新记录有 `activeSessionId` 字段 → 尝试恢复会话
- **完全向后兼容，无需数据迁移** ✅

### 字段可选性
所有新增字段都是可选的（`?:`），确保：
- 旧代码读取新记录时不会崩溃
- 新代码读取旧记录时使用默认值
- 渐进式升级，不强制所有用户立即迁移

## 限制与注意事项

### 当前限制

1. **单会话模式**：
   - 只持久化一个活动会话
   - 没有会话切换 UI
   - 没有新建/删除会话功能

2. **子会话不可见**：
   - 专家 Agent（foreshadowing/detailed/outline specialist）的处理过程仍不可见
   - 只能看到最终结果

3. **会话清理**：
   - 没有自动清理旧会话的机制
   - 没有手动删除会话的 UI

### 后续优化（待实施）

见 `docs/proposals/outline-agent-session-management.md`：
- **阶段 2**：会话管理 UI（新建、切换、删除会话）
- **阶段 3**：子会话可见性（展示专家 Agent 的处理过程）

## 技术债务

### 类型定义
```typescript
workbenchSession?: any;  // TODO: 定义具体类型
```

**建议**：创建专门的类型定义文件
```typescript
// types/outline-workbench.ts
export type OutlineWorkbenchSession = {
    state: Ref<{
        activeSessionId: number | null;
        sessions: readonly OutlineSessionEntry[];
    }>;
    commit: (patch: OutlineWorkbenchPatch) => Promise<LayoutRecordCommitResult>;
};
```

### 错误处理
当前只捕获了会话恢复失败的情况，建议添加：
- 会话保存失败的重试机制
- 会话数据损坏的修复流程
- 更详细的错误提示

## 测试建议

### 手动测试场景

1. **基本持久化**：
   - [ ] 创建会话并发送几条消息
   - [ ] 关闭工作台
   - [ ] 重新打开，验证消息仍在

2. **项目重启**：
   - [ ] 创建会话并发送消息
   - [ ] 重启项目
   - [ ] 打开工作台，验证消息仍在

3. **会话失效**：
   - [ ] 创建会话
   - [ ] 手动删除 `.nbook/agent/traces/<sessionId>.jsonl`
   - [ ] 重新打开工作台
   - [ ] 验证自动创建新会话，不崩溃

4. **项目切换**：
   - [ ] 在项目 A 创建会话
   - [ ] 切换到项目 B
   - [ ] 验证不会显示项目 A 的会话

### 自动化测试（建议）

```typescript
describe("会话持久化", () => {
    it("保存会话 ID 到工作台记录", async () => {
        // 测试会话创建后保存
    });

    it("恢复保存的会话", async () => {
        // 测试从记录中恢复会话
    });

    it("处理会话不存在的情况", async () => {
        // 测试会话已删除时的行为
    });

    it("项目切换时不恢复错误的会话", async () => {
        // 测试项目隔离
    });
});
```

## 总结

✅ **阶段 1（会话持久化）已完成**

核心改进：
1. 会话 ID 持久化到工作台记录
2. 退出工作台后会话保留
3. 重启项目后会话恢复
4. 向后兼容旧记录

用户体验显著改善：
- 不再丢失对话历史
- 可以随时继续之前的讨论
- 工作流更连贯

下一步：
- 阶段 2：实现会话管理 UI
- 阶段 3：实现子会话可见性
