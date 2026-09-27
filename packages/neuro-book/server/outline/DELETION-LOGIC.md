# 大纲库删除逻辑

## 概述

本文档说明大纲库删除功能的设计与实现。

## 删除行为

### 1. 叶子条目删除（章节、细纲）

**行为**：直接删除，不要求预先解除引用

- 删除操作立即执行
- 线路图中引用该条目的节点会失效，由前端标记为红色并提示用户处理
- Placement 引用自动清理
- 伏笔标记引用保留（由用户后续处理）

**示例**：
```
总纲
└── 卷纲
    └── 章节A  ← 删除此章节，直接删除
```

### 2. 容器条目删除（总纲、卷纲）

**行为**：级联删除所有子条目

删除容器条目时会：
- 删除自身及所有子孙条目
- 删除所有相关的 placement 关系
- 在删除前提示用户将删除的条目总数

**示例**：
```
总纲
└── 卷纲A  ← 删除此卷纲
    ├── 章节1  ← 被级联删除
    │   └── 细纲1-1  ← 被级联删除
    └── 章节2  ← 被级联删除
```

删除提示：将删除 4 个条目（1 卷纲 + 2 章节 + 1 细纲）

### 3. 总纲删除

**特殊要求**：需要二次确认标志 `confirmedTotal`

删除总纲会：
- 级联删除所有子条目（卷纲、章节、细纲）
- 清理所有方案中的 placement 关系
- 将 manifest 中的 `totalId` 设为 `null`

## 线路图节点处理

删除被线路图节点引用的条目时：
- **不阻止删除**：条目可以正常删除
- **返回影响信息**：`affectedGraphNodes` 列出所有受影响的节点
- **前端标记**：前端将失效节点标记为红色，提示用户处理

## API

### `inspectPlanningObject(snapshot, targetId): PlanningObjectImpact`

检查删除影响，返回：
- `entryKind`：条目类型
- `children`：直接子条目列表
- `cascadeCount`：级联删除总数（包括自身）
- `references`：外部引用列表（不阻止删除）
- `affectedGraphNodes`：受影响的线路图节点
- `canDeleteObject`：是否可以删除（始终为 `true`）

### `preparePlanningObjectDeletion(options, targetId, confirmedTotal?): Promise<PlanningPublishInput>`

准备删除操作，返回文件变更列表：
- 删除目标条目及级联子条目的文件
- 更新 manifest，移除所有被删除的条目
- 清理所有方案中的 placement 关系

### `preparePlanningObjectDeletionFromSnapshot(snapshot, targetId, confirmedTotal?): PlanningPublishInput`

从已有快照准备删除操作（用于测试和批量操作）。

## 实现细节

### 级联删除算法

```typescript
const allDeleteIds = new Set<OutlineId>([targetId]);

const collectChildren = (id: OutlineId) => {
    for (const entry of snapshot.entries) {
        if (entry.value.parentId === id && !allDeleteIds.has(entry.value.id)) {
            allDeleteIds.add(entry.value.id);
            collectChildren(entry.value.id);  // 递归收集子孙条目
        }
    }
};

collectChildren(targetId);
```

### Placement 清理

删除条目时，自动从所有方案的 `placements` 中移除：

```typescript
plans: manifest.plans.map((plan) => ({
    ...plan,
    placements: plan.placements.filter((p) => !allDeleteIds.has(p.entryId))
}))
```

## 测试

见 `server/outline/operations.cascade-delete.test.ts`

测试覆盖：
- 叶子条目直接删除
- 容器条目级联删除
- 总纲删除二次确认
- 线路图节点引用不阻止删除

## 修改历史

- 2024: 重构删除逻辑，从"先解除引用"改为"级联删除 + 失效节点标记"
