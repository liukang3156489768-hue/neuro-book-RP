# Schema 扩展工作进度（一.2）

**状态**：已完成（2026-09-26）。以下为中断时的原计划，仅作历史保留；实际字段与原计划不同，以 [t07 的 Schema 扩展节](tasks/t07-outline-agent-approval-and-streaming/README.md) 和各 Spec 的“实现合同”节为准。  
**创建时间**：2026-09-26

## 目标概览

实现原始设计补充中的五项 schema 扩展，要求：
- Entry schema 从 v1 升级到 v2
- Foreshadowing schema 从 v1 升级到 v2
- 向后兼容：v1 文件仍可读取，新写入使用 v2 格式

## 五项扩展详细说明

### 1. 参考文件结构化

**当前状态**：Entry v1 使用 `referenceFiles?: readonly string[]`  
**目标状态**：Entry v2 使用 `references?: Reference[]`

```typescript
type Reference = {
  locator: string;      // 文件路径或资料标识
  purpose?: string;     // 所用部分和用途说明
  pending: boolean;     // 是否标记为"待补"
};
```

**影响范围**：
- `packages/neuro-book/server/outline/format.ts` - schema 定义与序列化
- `packages/neuro-book/server/outline/library.ts` - 读取与写入调用
- `packages/neuro-book/server/outline/writer-materials.ts` - 正文交接读取
- HTTP route schemas - API 契约
- DTOs - 前后端类型定义
- `packages/neuro-book/app/composables/useOutlineWorkbenchData.ts` - 前端类型

**验证要点**：
- v1 文件读取时 `referenceFiles` 应转换为 `references`（`pending: false`）
- v2 写入时只保存 `references`，不再写 `referenceFiles`
- "待补"标记的 reference 在偏差分析和正文交接中作为告警

### 2. 场景锚定写作指导

**当前状态**：写作指导混在细纲正文中，无结构化锚点  
**目标状态**：从 entry body 解析 `<!-- nb:guidance scene="..." -->` 注释

```markdown
<!-- nb:guidance scene="开场" -->
此场景应快速切入，略写环境描写，重点表现角色初次登场的冲击力。
<!-- /nb:guidance -->
```

**数据结构**：
```typescript
type GuidanceAnnotation = {
  scene: string;        // 场景标识
  content: string;      // 指导内容
  startOffset: number;  // 在 body 中的起始位置（用于来源追溯）
};

// Entry v2 添加派生字段
type OutlineEntryV2 = {
  // ... 其他字段
  guidanceAnnotations?: readonly GuidanceAnnotation[];  // 从 body 解析得到
};
```

**影响范围**：
- `packages/neuro-book/server/outline/format.ts` - 解析逻辑
- `packages/neuro-book/server/outline/writer-context.ts` - 正文交接读取
- 测试覆盖解析成功、格式错误、嵌套注释等场景

**验证要点**：
- 解析器应提取所有 `nb:guidance` 注释块
- 格式错误（未闭合、缺少 scene 属性）应标记异常但不阻止读取
- `writer.pro` 读取时应能按场景过滤指导内容

### 3. 场景篇幅预算

**当前状态**：只有章节总字数，无场景级分配  
**目标状态**：细纲支持 `sceneBudgets` 字段

```typescript
type SceneBudget = {
  scene: string;        // 场景标识，对应 guidance 的 scene
  wordCount: number;    // 该场景目标字数
};

// Entry v2 细纲字段扩展
type OutlineEntryV2 = {
  // ... 其他字段
  sceneBudgets?: readonly SceneBudget[];  // 场景字数分配
};
```

**影响范围**：
- `packages/neuro-book/server/outline/format.ts` - schema 定义与序列化
- `packages/neuro-book/server/outline/writer-context.ts` - 正文交接读取
- HTTP route schemas 和 DTOs
- 前端工作台编辑界面（一.1 阶段实现）

**验证要点**：
- 场景字数总和可以不等于章节总字数（允许弹性分配）
- 场景标识应与 `guidanceAnnotations` 的 scene 对应
- `writer.pro` 读取时应获得本章各场景的字数约束

### 4. 伏笔设计分项

**当前状态**：Foreshadowing v1 字段较平面  
**目标状态**：Foreshadowing v2 添加结构化 `design` 字段

```typescript
type ForeshadowingDesign = {
  coreIdea: string;              // 核心构思：表面呈现与背后关联
  emotionalTone?: string;        // 情感基调
  narrativeTiming?: string;      // 叙事时机：何时埋设、何时回收
  characterReaction?: string;    // 角色反应：不同角色对线索的反应
  executionNotes?: string;       // 执行要点：呈现方式、暗示程度、预期效果
};

type ForeshadowingV2 = {
  // ... v1 字段
  design?: ForeshadowingDesign;
};
```

**影响范围**：
- `packages/neuro-book/server/outline/format.ts` - schema 定义与序列化
- `packages/neuro-book/server/outline/library.ts` - 伏笔读写
- HTTP route schemas 和 DTOs
- 前端伏笔库界面

**验证要点**：
- v1 文件读取时 `design` 为 undefined
- v2 写入时保存完整 design 结构
- `foreshadowing` 子 Agent 应能根据 design 内容生成更精准的建议

### 5. 已过章节数（派生指标）

**当前状态**：无该指标  
**目标状态**：从固定线路动态计算 `elapsedChapters`

```typescript
type ForeshadowingStatusWithMetrics = {
  // ... 现有状态字段
  elapsedChapters?: number;  // 埋设到当前（或到回收）的章节数
};
```

**计算逻辑**：
1. 取该伏笔首个有效埋设所在的章节节点
2. 在固定线路中找到该节点位置
3. 从该位置往右计数，直到：
   - 未回收：线路中最后一个已固定且已关联正文的章节节点
   - 已回收：首个有效回收所在的章节节点
4. 计数时只统计已关联正文的章节节点（线路节点可能尚未写作）

**影响范围**：
- `packages/neuro-book/server/outline/library.ts` - 新增 `computeElapsedChapters` 函数
- 需要访问线路规划数据（Phase 4 的线路服务）
- 伏笔状态查询时动态计算，不持久化到文件

**验证要点**：
- 同一伏笔在不同方案下可能有不同的 elapsedChapters
- 章节重排或线路改动后应重新计算
- 超期未回收的伏笔应通过该指标发现并告警

## 已完成部分

### Schema 版本常量升级

**文件**：`packages/neuro-book/server/outline/format.ts`

```typescript
// 已修改
export const OUTLINE_ENTRY_SCHEMA = "nbook.outline-entry/v2" as const;
export const OUTLINE_FORESHADOW_SCHEMA = "nbook.outline-foreshadowing/v2" as const;
```

## 未完成部分详细清单

### 核心实现文件

#### 1. `packages/neuro-book/server/outline/format.ts`

**待添加类型定义**：
```typescript
// Reference 类型（替代 referenceFiles）
export type Reference = {
  locator: string;
  purpose?: string;
  pending: boolean;
};

// Guidance 注释类型
export type GuidanceAnnotation = {
  scene: string;
  content: string;
  startOffset: number;
};

// 场景篇幅类型
export type SceneBudget = {
  scene: string;
  wordCount: number;
};

// 伏笔设计类型
export type ForeshadowingDesign = {
  coreIdea: string;
  emotionalTone?: string;
  narrativeTiming?: string;
  characterReaction?: string;
  executionNotes?: string;
};
```

**待修改 Entry 序列化**：
- `serializeOutlineEntry()` 函数需处理 v2 字段
- `parseOutlineEntry()` 函数需兼容 v1 → v2 转换
- 添加 `parseGuidanceAnnotations()` 从 body 提取注释

**待修改 Foreshadowing 序列化**：
- `serializeForeshadowing()` 函数需处理 design 字段
- `parseForeshadowing()` 函数需兼容 v1 → v2

#### 2. `packages/neuro-book/server/outline/library.ts`

**待添加函数**：
```typescript
// 计算已过章节数
export function computeElapsedChapters(
  foreshadowingId: string,
  lineId: string,  // 特定线路
  projectKey: string
): number | undefined;
```

**待更新调用点**：
- 所有读取 entry 的地方需处理 v2 字段
- 所有写入 entry 的地方需序列化 v2 字段

#### 3. `packages/neuro-book/server/outline/writer-context.ts`

**待更新函数**：
- `getChapterContext()` 需提取和传递：
  - `references` 替代 `referenceFiles`
  - `guidanceAnnotations` 按场景过滤
  - `sceneBudgets` 作为字数约束

#### 4. `packages/neuro-book/server/outline/writer-materials.ts`

**待更新函数**：
- 素材准备逻辑需处理 `references` 的 `pending` 标记
- 遇到 `pending: true` 的 reference 应返回告警

### HTTP Schema 与 DTO

#### 待创建/更新的 DTO 文件

位置：`packages/neuro-book/shared/dto/outline/`（或相应位置）

**ReferenceDTO**：
```typescript
export type ReferenceDTO = {
  locator: string;
  purpose?: string;
  pending: boolean;
};
```

**GuidanceAnnotationDTO**：
```typescript
export type GuidanceAnnotationDTO = {
  scene: string;
  content: string;
  startOffset: number;
};
```

**SceneBudgetDTO**：
```typescript
export type SceneBudgetDTO = {
  scene: string;
  wordCount: number;
};
```

**ForeshadowingDesignDTO**：
```typescript
export type ForeshadowingDesignDTO = {
  coreIdea: string;
  emotionalTone?: string;
  narrativeTiming?: string;
  characterReaction?: string;
  executionNotes?: string;
};
```

**OutlineEntryDTO 更新**：
```typescript
export type OutlineEntryDTO = {
  // ... 现有字段
  references?: ReferenceDTO[];           // 替代 referenceFiles
  guidanceAnnotations?: GuidanceAnnotationDTO[];
  sceneBudgets?: SceneBudgetDTO[];
};
```

**ForeshadowingDTO 更新**：
```typescript
export type ForeshadowingDTO = {
  // ... 现有字段
  design?: ForeshadowingDesignDTO;
  elapsedChapters?: number;  // 查询时动态计算
};
```

#### 待更新的 HTTP Route Schema

位置：`packages/neuro-book/server/api/outline/` 相关路由

**需要更新的接口**：
- `GET /api/outline/entries/:id` - 返回 Entry v2
- `POST /api/outline/entries` - 接受 Entry v2
- `PUT /api/outline/entries/:id` - 接受 Entry v2
- `GET /api/outline/foreshadowing/:id` - 返回 Foreshadowing v2
- `POST /api/outline/foreshadowing` - 接受 Foreshadowing v2
- `PUT /api/outline/foreshadowing/:id` - 接受 Foreshadowing v2

### 前端类型更新

#### `packages/neuro-book/app/composables/useOutlineWorkbenchData.ts`

**待更新类型**：
```typescript
// 当前仍使用
referenceFiles?: readonly string[]

// 需改为
references?: readonly Reference[]
guidanceAnnotations?: readonly GuidanceAnnotation[]
sceneBudgets?: readonly SceneBudget[]
```

**注意**：前端 UI 实现在一.1 阶段，此处只需类型对齐。

### 测试覆盖

#### 单元测试文件待创建/更新

**`packages/neuro-book/server/outline/format.test.ts`**：
- [ ] Entry v1 → v2 兼容读取
- [ ] Entry v2 序列化/反序列化
- [ ] `referenceFiles` → `references` 转换
- [ ] `guidanceAnnotations` 解析（正常、缺 scene、未闭合、嵌套）
- [ ] `sceneBudgets` 序列化
- [ ] Foreshadowing v1 → v2 兼容读取
- [ ] Foreshadowing v2 序列化/反序列化
- [ ] `design` 字段处理

**`packages/neuro-book/server/outline/library.test.ts`**：
- [ ] `computeElapsedChapters` 函数测试
  - 未回收伏笔：计数到线路末尾
  - 已回收伏笔：计数到回收位置
  - 章节无正文关联：跳过计数
  - 不同方案不同结果

**`packages/neuro-book/server/outline/writer-context.test.ts`**：
- [ ] 正文交接包含 v2 字段
- [ ] `pending: true` 的 reference 产生告警
- [ ] `guidanceAnnotations` 按场景过滤
- [ ] `sceneBudgets` 传递正确

#### 集成测试

**规划工具测试更新**：
- [ ] Agent 提交 Entry v2 数据
- [ ] Agent 提交 Foreshadowing v2 数据
- [ ] 偏差分析识别"待补" reference

## 实现步骤建议

### 阶段一：类型定义与 v1 兼容读取

1. 在 `format.ts` 添加 v2 类型定义
2. 实现 `parseOutlineEntry()` 的 v1 → v2 转换逻辑
3. 实现 `parseForeshadowing()` 的 v1 → v2 转换逻辑
4. 编写兼容性测试，确保 v1 文件可读

### 阶段二：v2 序列化与写入

1. 实现 `serializeOutlineEntry()` 的 v2 序列化
2. 实现 `serializeForeshadowing()` 的 v2 序列化
3. 实现 `parseGuidanceAnnotations()` 从 body 解析注释
4. 编写序列化往返测试

### 阶段三：调用点更新

1. 更新 `library.ts` 所有读写调用
2. 更新 `writer-context.ts` 正文交接逻辑
3. 更新 `writer-materials.ts` 素材准备逻辑
4. 实现 `computeElapsedChapters()` 函数

### 阶段四：HTTP 与前端对齐

1. 创建/更新 DTO 定义
2. 更新 HTTP route schema
3. 更新前端 composable 类型
4. 编写 API 集成测试

### 阶段五：验收

1. 运行 `bun run --cwd packages/neuro-book typecheck`
2. 运行全部相关测试
3. 手动验证 v1 文件迁移到 v2
4. 手动验证"待补" reference 告警
5. 手动验证 guidance 注释解析

## 参考资料

- [大纲规划 Proposal](../../../../../docs/proposals/outline-planning-module.md) - 原始设计补充章节
- [实施计划](../../implementation-plan.md) - Phase 2 大纲库与细纲
- [Agent 协助 Spec](../../../../../docs/specs/outline/agent-assistance.md) - Agent 交接契约

## 注意事项

1. **向后兼容性**：所有 v1 文件必须能正常读取，不能要求用户手动迁移
2. **告警不阻塞**：`pending: true` 的 reference 和格式错误的 guidance 应产生告警但不阻止使用
3. **派生字段不持久化**：`guidanceAnnotations` 和 `elapsedChapters` 从源数据动态计算，不写入文件
4. **删除 referenceFiles**：v2 写入时不再保存 `referenceFiles` 字段，避免双重真相源
5. **测试优先**：每完成一个函数立即补测试，避免累积技术债

## 子代理中断点

**子代理 aa105172fab027d43**：
- 完成了初步调查和类型定义草案
- 开始修改 `format.ts` 时遇到 API 余额错误

**子代理 a561a8f02f2a3e786**：
- 尝试继续上一轮工作
- 同样因 API 余额不足中断

**恢复建议**：
- 直接从阶段一开始，不依赖子代理的部分工作
- 优先完成 `format.ts` 的类型定义和解析逻辑
- 每个阶段完成后提交一次，避免大批量改动
