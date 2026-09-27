# 工作台编辑能力待实现清单（一.1）

**状态**：阶段一至四的前端编辑界面已实现（2026-09-26），浏览器验收未执行  
**前置依赖**：schema-extension-work-in-progress.md 中的所有工作（已完成）  
**目标**：为大纲规划模块工作台提供完整的手动编辑能力

## 实际实现记录（2026-09-26）

下文清单写于实现前，其中的 `/api/outline/...` REST 端点、`Scheme` 数据模型、Pinia store 和新建服务文件均**未采用**。所有写入都复用已存在的单路由 `server/api/projects/outline/[...segments].ts` 与领域操作（`library-action`、`fork-entry`、`analyze-detail`/`adopt-detail`、`foreshadowing-action`、`line-action`、`preview-line-deletion`、`preview-legacy-line-upgrade`、`inspect-line`、`analyze-line`/`fix-line`、`preview-object-deletion`/`remove-object`），前端不自行推导伏笔状态、节点有效性或写入资格。下文复选框保留为原始需求，不逐项勾选。

| 阶段 | 落点（`packages/neuro-book/app/`） | 行为 |
|---|---|---|
| 一 大纲库 | `components/novel-ide/outline/OutlineLibraryPanel.vue`、`OutlineEntryForm.vue`、`composables/useOutlineWorkbenchActions.ts` | 方案链新建、改名、删除预览；条目新建、编辑、移动、删除预览；共享条目写时分叉（要求换标题）；总纲全局确认 |
| 二 细纲 | `OutlineDetailAnalysisPanel.vue` | 写作指导、参考文件（含待补）、篇幅字段编辑；分析报告逐条确认偏离与冲突处理后正式采用 |
| 三 伏笔 | `OutlineForeshadowingPanel.vue`、`outline-foreshadow-form.ts` | 伏笔定义与设计分项编辑、确认；服务端派生状态、来源、已过章节数和异常标记只读展示；章节大纲正文按选区插入标记 |
| 四 线路 | `OutlineLinePanel.vue`、`OutlineLineAnalysisPanel.vue` | 新建/编辑草稿线路；按故事顺序的节点条带（前移、后移、更换条目、删除）；连线增删；删除预览按影响哈希确认；设为主线、退回草稿、旧版线路升级（分叉点保留一条连线）；节点红/黄状态取自 `inspect-line`；分析后逐条说明冲突再固定 |

与原清单的取舍与未完成项：

- 线路采用按故事顺序排列的节点条带，不做自由画布、拖拽与自动布局；节点 `position` 暂不使用。
- 草稿线路的所有节点在服务端都判为黄色（尚无固定上下文），界面只对草稿显示红色，黄色仅用于已固定线路的“需重新固定”。
- 未实现：伏笔标记悬停卡片与标记内联编辑、素材索引“继承/追加/排除/覆盖”高级编辑器（当前 schema 只有 `materialRefs`）、阶段五的 Agent 感知选中对象与端到端流程。
- 伏笔状态文案“待埋设”已按原始设计改为“待使用”。
- 证据：大纲前端 8 个测试文件 30 项（含工作台合同 3 项）通过，应用 `typecheck` 与 `docs:check` 通过。浏览器人工验收、真实模型的细纲/线路分析均未验证。

## 概述

工作台编辑能力让用户能够在全屏工作台界面中直接操作大纲库、伏笔库和线路规划的所有对象，而不依赖 Agent 生成。这是用户对规划数据的直接控制入口，也是 Agent 协助的基础。

## 三大功能区域

### 一、大纲库编辑

#### 1.1 总纲管理

**功能需求**：
- [ ] 创建全局唯一总纲
- [ ] 编辑总纲内容（标题、正文、核心冲突、主题、结局方向）
- [ ] 删除总纲（需二次确认，展示所有级联影响）
- [ ] 查看引用该总纲的方案链列表

**UI 组件**：
- 总纲编辑器（富文本或 Markdown）
- 删除确认对话框，列出级联影响
- 引用追踪面板

**后端接口**：
- `POST /api/outline/entries` - 创建总纲
- `PUT /api/outline/entries/:id` - 更新总纲
- `DELETE /api/outline/entries/:id` - 删除总纲（需检查引用）
- `GET /api/outline/entries/:id/references` - 查询引用关系

**验证点**：
- 不允许创建第二个总纲
- 删除前必须展示所有方案链引用
- 用户确认后才能删除

#### 1.2 方案链管理

**功能需求**：
- [ ] 新增方案链（命名、描述、关联总纲）
- [ ] 编辑方案链元信息
- [ ] 删除方案链（展示影响范围）
- [ ] 在方案链之间切换查看
- [ ] 复制条目到其他方案（初始为引用同一对象）

**UI 组件**：
- 方案链选择器（下拉或标签页）
- 方案链编辑对话框
- 复制/引用操作菜单

**后端接口**：
- `POST /api/outline/schemes` - 创建方案链
- `PUT /api/outline/schemes/:id` - 更新方案链
- `DELETE /api/outline/schemes/:id` - 删除方案链
- `GET /api/outline/schemes` - 列出所有方案链
- `POST /api/outline/schemes/:id/copy-entry` - 跨方案复制条目

**数据模型**：
```typescript
type Scheme = {
  id: string;
  name: string;
  description?: string;
  outlineId: string;  // 关联的总纲 ID
  createdAt: string;
  updatedAt: string;
};
```

**验证点**：
- 方案链切换时保留编辑状态
- 删除方案链前展示卷纲、章节大纲数量
- 跨方案复制初始为引用，不是副本

#### 1.3 卷纲管理

**功能需求**：
- [ ] 在方案链下新增卷纲
- [ ] 编辑卷纲（标题、正文、起点、发展、转折、落点）
- [ ] 移动卷纲（调整顺序，不影响稳定 ID）
- [ ] 删除卷纲（展示下级章节大纲影响）
- [ ] 查看卷纲的章节大纲列表

**UI 组件**：
- 卷纲列表（支持拖拽排序）
- 卷纲编辑器
- 章节大纲预览面板

**后端接口**：
- `POST /api/outline/entries` - 创建卷纲（关联 schemeId）
- `PUT /api/outline/entries/:id` - 更新卷纲
- `PUT /api/outline/entries/:id/order` - 调整顺序
- `DELETE /api/outline/entries/:id` - 删除卷纲
- `GET /api/outline/entries/:id/children` - 获取下级条目

**验证点**：
- 移动不改变稳定 ID
- 删除前展示所有下级章节大纲
- 顺序变化只影响显示，不影响线路剧情顺序

#### 1.4 章节大纲管理

**功能需求**：
- [ ] 在卷纲下新增章节大纲
- [ ] 编辑章节大纲（标题、正文、事件、冲突、转折、结果）
- [ ] 移动/排序章节大纲
- [ ] 删除章节大纲（展示细纲、伏笔标记、线路节点、正文关联影响）
- [ ] 查看章节大纲的细纲
- [ ] 管理素材索引（添加、移除 lorebook 引用）
- [ ] 管理伏笔标记（插入、编辑、删除）

**UI 组件**：
- 章节大纲列表（树形或平铺）
- 章节大纲编辑器（支持伏笔标记插入）
- 素材索引选择器（lorebook 文件选择）
- 伏笔标记工具栏（插入埋设/强化/回收标记）
- 删除影响预览对话框

**后端接口**：
- `POST /api/outline/entries` - 创建章节大纲
- `PUT /api/outline/entries/:id` - 更新章节大纲
- `PUT /api/outline/entries/:id/materials` - 更新素材索引
- `DELETE /api/outline/entries/:id` - 删除章节大纲
- `GET /api/outline/entries/:id/impact` - 查询删除影响

**伏笔标记格式**（Markdown 注释）：
```markdown
<!-- nb:foreshadow id="f-001" action="plant" marker-id="m-123" -->
主角注意到墙角的古旧木箱
<!-- /nb:foreshadow -->

<!-- nb:foreshadow id="f-001" action="reinforce" marker-id="m-124" -->
木箱上的纹路似曾相识
<!-- /nb:foreshadow -->

<!-- nb:foreshadow id="f-001" action="recover" marker-id="m-125" -->
木箱打开，里面是父亲留下的信
<!-- /nb:foreshadow -->
```

**验证点**：
- 删除前必须展示完整影响范围
- 伏笔标记插入后立即解析并更新伏笔库状态
- 素材索引使用稳定 ID，不是显示名称
- 删除标记后重新计算伏笔状态

#### 1.5 细纲管理

**功能需求**：
- [ ] 为章节大纲新增细纲
- [ ] 编辑细纲正文
- [ ] 管理细纲的结构化标注：
  - [ ] 写作指导（场景锚定，一.2 完成后启用）
  - [ ] 参考文件（结构化 references，一.2 完成后启用）
  - [ ] 场景篇幅（sceneBudgets，一.2 完成后启用）
  - [ ] 素材索引（继承 > 追加 > 排除 > 覆盖）
- [ ] 保存为草稿或正式文本
- [ ] 正式保存前触发偏差分析
- [ ] 查看偏差分析结果
- [ ] 删除细纲

**UI 组件**：
- 细纲编辑器（Markdown 或富文本）
- 写作指导注释编辑器（插入 `nb:guidance` 块）
- 参考文件管理面板（locator, purpose, pending 标记）
- 场景篇幅分配表（scene, wordCount）
- 素材索引高级编辑器（继承/追加/排除/覆盖四种模式）
- 保存选项（草稿 / 正式）
- 偏差分析结果面板

**后端接口**：
- `POST /api/outline/entries/:chapterId/detailed` - 创建细纲
- `PUT /api/outline/entries/:id/detailed` - 更新细纲
- `POST /api/outline/entries/:id/analyze` - 触发偏差分析
- `GET /api/outline/entries/:id/analysis-result` - 获取分析结果
- `DELETE /api/outline/entries/:id/detailed` - 删除细纲

**偏差分析流程**：
1. 用户点击"保存为正式"
2. 前端调用分析接口，显示加载状态
3. 后端调用 AI 服务，对比细纲与章节大纲
4. 返回偏差列表：缺失要素、冲突、不一致
5. 前端展示结果，用户选择：
   - 修订重试
   - 确认带警告保存
   - 取消保存
6. 自动模式可带警告保存，讨论模式需用户确认

**素材索引优先级**（详细规则）：
```typescript
// 继承：未声明时沿用章节大纲
if (!detailedOutline.materialOverrides) {
  return chapterOutline.materials;
}

// 追加：detailedOutline.materialsAppend
const inherited = chapterOutline.materials;
const appended = detailedOutline.materialsAppend || [];
let result = [...inherited, ...appended];

// 排除：detailedOutline.materialsExclude
const excluded = new Set(detailedOutline.materialsExclude || []);
result = result.filter(m => !excluded.has(m.id));

// 覆盖：detailedOutline.materialsOverride（按类别全量替换）
if (detailedOutline.materialsOverride) {
  for (const [category, items] of Object.entries(detailedOutline.materialsOverride)) {
    result = result.filter(m => m.category !== category);
    result.push(...items);
  }
}

return deduplicateById(result);
```

**验证点**：
- 草稿不触发分析，不进入正文交接
- 正式保存必须完成分析
- 分析失败不能当作通过校验
- 素材索引优先级正确计算
- 写作指导、参考文件、场景篇幅在一.2 完成后启用

#### 1.6 共享条目与写时分叉

**功能需求**：
- [ ] 检测条目被多个位置引用
- [ ] 修改共享条目时弹窗确认
- [ ] 确认后创建新文件（新稳定 ID、新文件名）
- [ ] 原文件和其他引用不受影响
- [ ] 查看条目的所有引用位置
- [ ] 禁止将分叉条目重新合并

**UI 组件**：
- 写时分叉确认对话框：
  - 显示当前引用该条目的所有位置
  - 说明分叉后果（创建独立副本）
  - 确认 / 取消按钮
- 引用位置列表（可跳转）

**后端接口**：
- `GET /api/outline/entries/:id/references` - 查询引用位置
- `POST /api/outline/entries/:id/fork` - 写时分叉（创建新条目，更新当前位置引用）

**分叉逻辑**：
1. 用户尝试编辑共享条目
2. 检测到多个引用位置
3. 弹窗展示引用列表
4. 用户确认分叉
5. 后端：
   - 创建新文件（新稳定 ID、新 slug）
   - 复制条目内容到新文件
   - 更新当前编辑位置的引用指向新 ID
   - 原文件不变，其他引用不变
6. 前端切换到编辑新条目

**验证点**：
- 分叉前必须确认
- 新条目有独立稳定 ID
- 原条目和其他引用不受影响
- 禁止反向合并操作

### 二、伏笔库编辑

#### 2.1 伏笔条目管理

**功能需求**：
- [ ] 新增伏笔条目
- [ ] 编辑伏笔设计内容：
  - [ ] 名称
  - [ ] 核心构思（表面呈现与背后关联，一.2 完成后结构化）
  - [ ] 埋设建议
  - [ ] 回收建议
  - [ ] 设计分项（一.2 完成后启用）
- [ ] 查看伏笔状态（草稿 / 待使用 / 已埋设 / 已回收）
- [ ] 查看埋设和回收标记来源
- [ ] 查看已过章节数（一.2 完成后启用）
- [ ] 删除伏笔（需先解除所有标记引用）

**UI 组件**：
- 伏笔列表（按状态分组或筛选）
- 伏笔编辑器
- 设计分项表单（coreIdea, emotionalTone, narrativeTiming, characterReaction, executionNotes）
- 标记来源列表（可跳转到章节大纲位置）
- 已过章节数显示（按方案分别展示）
- 删除阻止提示（列出活动标记）

**后端接口**：
- `POST /api/outline/foreshadowing` - 创建伏笔
- `PUT /api/outline/foreshadowing/:id` - 更新伏笔
- `GET /api/outline/foreshadowing/:id` - 获取伏笔详情
- `GET /api/outline/foreshadowing/:id/markers` - 获取标记来源
- `GET /api/outline/foreshadowing/:id/elapsed-chapters` - 获取已过章节数（按方案）
- `DELETE /api/outline/foreshadowing/:id` - 删除伏笔

**伏笔状态派生逻辑**（只读，不可手动设置）：
```typescript
function deriveForeshadowingStatus(foreshadowing: Foreshadowing): Status {
  const markers = parseAllMarkersFromOutlineEntries(foreshadowing.id);
  const plantMarkers = markers.filter(m => m.action === 'plant' && m.valid);
  const recoverMarkers = markers.filter(m => m.action === 'recover' && m.valid);
  
  if (plantMarkers.length === 0 && recoverMarkers.length === 0) {
    return '待使用';
  }
  if (plantMarkers.length > 0 && recoverMarkers.length === 0) {
    return '已埋设';
  }
  if (plantMarkers.length > 0 && recoverMarkers.length > 0) {
    return '已回收';
  }
  // 异常：只有回收无埋设
  return {status: '异常', error: '回收先于埋设'};
}
```

**验证点**：
- 状态只从标记派生，不可手动设置
- 删除前必须解除所有活动标记
- 标记来源可追溯到具体章节大纲和位置
- 已过章节数按方案分别计算

#### 2.2 伏笔标记插入与管理

**功能需求**：
- [ ] 在章节大纲编辑器中插入伏笔标记
- [ ] 选择伏笔条目（从伏笔库）
- [ ] 选择动作类型（plant / reinforce / recover）
- [ ] 标记可见文本范围
- [ ] 界面以下划线注释形式呈现
- [ ] 鼠标悬停显示伏笔信息
- [ ] 编辑标记（修改动作类型或伏笔引用）
- [ ] 删除标记
- [ ] 标记变化后立即重解析并更新伏笔状态

**UI 组件**：
- 伏笔工具栏（插入按钮）
- 伏笔选择对话框（搜索、筛选伏笔库）
- 标记编辑器（内联或弹窗）
- 标记装饰（下划线、颜色区分 plant/reinforce/recover）
- 悬停提示卡片（显示伏笔名称、动作、核心构思）

**前端逻辑**：
```typescript
// 插入标记
function insertForeshadowMarker(
  editor: Editor,
  range: Range,
  foreshadowId: string,
  action: 'plant' | 'reinforce' | 'recover'
) {
  const markerId = generateMarkerId();
  const markdown = `<!-- nb:foreshadow id="${foreshadowId}" action="${action}" marker-id="${markerId}" -->\n${range.text}\n<!-- /nb:foreshadow -->`;
  editor.replaceRange(range, markdown);
  // 保存后后端自动解析并更新伏笔状态
}
```

**后端解析**：
- 保存章节大纲时自动调用 `parseForeshadowMarkers(entryBody)`
- 提取所有 `nb:foreshadow` 标记
- 验证格式、foreshadowId 存在性、action 合法性
- 更新伏笔库的标记来源记录
- 重新计算伏笔状态
- 返回异常标记列表（格式错误、ID 不存在等）

**验证点**：
- 标记插入后立即可见
- 保存后触发解析
- 解析结果同步到伏笔库
- 格式错误标记保留原文并标出异常
- 删除标记后重新计算状态

#### 2.3 伏笔异常处理

**异常类型**：
- 回收先于埋设（无 plant 标记但有 recover 标记）
- 引用伏笔不存在（foreshadowId 无效）
- 标记格式损坏（未闭合、缺少属性）
- 来源章节大纲已删除

**UI 展示**：
- [ ] 伏笔列表标记异常条目（警告图标）
- [ ] 伏笔详情显示异常信息
- [ ] 异常标记列表（可跳转到来源位置）
- [ ] 异常不阻止查看，但阻止进入正式使用

**后端接口**：
- `GET /api/outline/foreshadowing/:id/anomalies` - 获取异常列表

**验证点**：
- 异常不静默忽略
- 异常信息可追溯到具体标记
- 修复异常后自动重新计算状态

### 三、线路规划编辑

#### 3.1 线路节点图编辑

**功能需求**：
- [ ] 在画布上添加节点
- [ ] 关联节点到大纲条目（选择总纲/卷纲/章节大纲）
- [ ] 连接节点（创建边）
- [ ] 删除节点或边
- [ ] 设置节点链类型（主线 / 支线 / 角色线 / IF 线等）
- [ ] 固定节点（标记为正式使用）
- [ ] 查看节点状态（草稿 / 固定 / 重复 / 失效）
- [ ] 自动布局或手动拖拽节点

**UI 组件**：
- 节点图画布（类似流程图编辑器）
- 节点编辑面板（关联条目、类型、状态）
- 节点工具栏（添加、删除、连接、固定）
- 线路类型选择器（下拉菜单）
- 节点装饰（颜色区分状态：草稿、固定、红色失效、黄色待分析）

**后端接口**：
- `POST /api/outline/lines/:lineId/nodes` - 添加节点
- `PUT /api/outline/lines/:lineId/nodes/:nodeId` - 更新节点
- `DELETE /api/outline/lines/:lineId/nodes/:nodeId` - 删除节点
- `POST /api/outline/lines/:lineId/edges` - 创建边
- `DELETE /api/outline/lines/:lineId/edges/:edgeId` - 删除边
- `PUT /api/outline/lines/:lineId/nodes/:nodeId/fix` - 固定节点

**数据模型**：
```typescript
type LineNode = {
  id: string;
  lineId: string;
  outlineEntryId: string;  // 关联的大纲条目
  position?: {x: number; y: number};  // 可选 UI 坐标
  status: 'draft' | 'fixed' | 'duplicate' | 'invalid';
  lineType?: 'main' | 'sub' | 'character' | 'if' | 'emotion' | 'mystery' | 'faction';
};

type LineEdge = {
  id: string;
  lineId: string;
  fromNodeId: string;
  toNodeId: string;
};
```

**验证点**：
- 节点必须关联有效大纲条目
- 边必须连接同一 line 内的两个节点
- 主线节点链唯一性由数据约束保证
- 固定后的节点可供 `writer.pro` 读取

#### 3.2 线路结构校验

**校验规则**（程序自动检查）：
- [ ] 引用失效：节点关联的大纲条目不存在
- [ ] 重复节点：同一 line 内多个节点引用同一条目
- [ ] 断链：节点孤立，无入边或无出边（起点和终点除外）
- [ ] 逆序：节点顺序与从左到右顺序冲突
- [ ] 成环：线路形成环路

**UI 展示**：
- [ ] 校验错误列表面板
- [ ] 错误节点高亮（红色边框）
- [ ] 错误详情提示（悬停或点击）
- [ ] 修复建议

**后端接口**：
- `POST /api/outline/lines/:lineId/validate` - 触发校验
- `GET /api/outline/lines/:lineId/validation-result` - 获取校验结果

**验证点**：
- 保存线路时自动触发校验
- 校验失败的线路不能固定
- 错误信息可追溯到具体节点

#### 3.3 线路语义冲突分析（AI）

**分析项**（AI 负责，程序不做）：
- 因果冲突：事件 A 必须在事件 B 之前，但线路顺序相反
- 人物状态冲突：人物在 X 死亡，但后续节点仍出现
- 节奏问题：高潮过密或过疏
- 其他语义矛盾

**功能需求**：
- [ ] 触发 AI 冲突分析
- [ ] 查看分析结果（冲突列表、证据、建议）
- [ ] 标记已处理或忽略
- [ ] 记录忽略理由

**UI 组件**：
- 分析结果面板
- 冲突卡片（显示冲突类型、涉及节点、证据、建议）
- 处理选项（已修复 / 忽略 / 转待办）

**后端接口**：
- `POST /api/outline/lines/:lineId/analyze-conflicts` - 触发 AI 分析
- `GET /api/outline/lines/:lineId/conflicts` - 获取冲突列表
- `PUT /api/outline/lines/:lineId/conflicts/:conflictId` - 更新冲突状态

**验证点**：
- AI 分析是建议，不自动改写
- 用户可忽略分析结果（记录理由）
- 分析失败不阻止查看线路

#### 3.4 主线唯一性与切换

**功能需求**：
- [ ] 每个规划版本最多一条主线
- [ ] 设置节点链为主线（单一入口）
- [ ] 切换主线时原链保留但失去主线属性
- [ ] UI 明确标识主线节点

**UI 组件**：
- 主线设置按钮（在节点链或线路面板）
- 主线确认对话框（切换时提示）
- 主线节点装饰（加粗边框或特殊颜色）

**后端逻辑**：
```typescript
function setMainLine(lineId: string, projectKey: string) {
  // 检查当前是否已有主线
  const currentMain = getMainLine(projectKey);
  if (currentMain && currentMain.id !== lineId) {
    // 取消旧主线的主线标记
    updateLine(currentMain.id, {isMain: false});
  }
  // 设置新主线
  updateLine(lineId, {isMain: true});
}
```

**验证点**：
- 全局最多一条主线
- 切换主线时旧主线保留
- 主线节点视觉明确区分

#### 3.5 固定与正文交接

**固定逻辑**：
- [ ] 用户点击"固定"按钮
- [ ] 检查节点关联的章节大纲是否有正式细纲
- [ ] 检查线路结构校验是否通过
- [ ] 固定后节点状态变为 `fixed`
- [ ] 只有固定节点可供 `writer.pro` 读取

**正文交接**：
- [ ] `writer.pro` 调用接口，传入 lineId 和 revisionAnchor
- [ ] 返回该线路从左到右的固定节点列表
- [ ] 每个节点包含：章节大纲、正式细纲、素材索引、参考文件、写作指导、本章伏笔标记
- [ ] 草稿、未固定、重复、红色、黄色节点不在返回范围

**后端接口**：
- `PUT /api/outline/lines/:lineId/nodes/:nodeId/fix` - 固定节点
- `GET /api/outline/lines/:lineId/writer-context` - 正文交接接口（只读）

**验证点**：
- 固定前必须通过结构校验
- 只有正式细纲的章节可固定
- `writer.pro` 无法读取未固定节点

## 实现步骤建议

### 阶段一：大纲库基础编辑（不依赖 schema v2）

1. 实现总纲、卷纲、章节大纲的 CRUD
2. 实现方案链管理
3. 实现移动、排序（不影响稳定 ID）
4. 实现删除影响预览
5. 实现共享条目检测与写时分叉

**验收标准**：
- 用户可手动创建完整的三级大纲结构
- 删除操作展示完整影响
- 共享条目修改触发分叉确认

### 阶段二：细纲编辑（部分依赖 schema v2）

1. 实现细纲 CRUD（基础字段）
2. 实现素材索引管理（基础版，不依赖 v2）
3. 实现草稿 / 正式保存选项
4. 实现偏差分析调用与结果展示
5. 等待一.2 完成后，启用：
   - 写作指导注释编辑
   - 参考文件结构化编辑
   - 场景篇幅分配

**验收标准**：
- 细纲可保存为草稿或正式
- 正式保存触发偏差分析
- 分析结果可查看并决定保存或修订

### 阶段三：伏笔库编辑（部分依赖 schema v2）

1. 实现伏笔条目 CRUD（基础字段）
2. 实现伏笔标记插入界面
3. 实现标记解析与状态派生
4. 实现标记来源追溯
5. 实现异常检测与展示
6. 等待一.2 完成后，启用：
   - 设计分项字段编辑
   - 已过章节数显示

**验收标准**：
- 伏笔标记插入后立即解析
- 状态从标记派生，不可手动设置
- 异常标记不静默忽略

### 阶段四：线路规划编辑

1. 实现节点图画布与节点 CRUD
2. 实现边的创建与删除
3. 实现线路类型选择
4. 实现节点固定功能
5. 实现结构校验
6. 实现 AI 冲突分析调用
7. 实现主线唯一性与切换
8. 实现正文交接只读接口

**验收标准**：
- 用户可手动编排节点图
- 结构校验自动触发
- 只有固定节点可供正文读取

### 阶段五：集成与验收

1. 三段式界面切换（大纲库 / 伏笔库 / 线路规划）
2. 工作台布局持久化（按项目）
3. Agent 区与工作区联动
4. 端到端测试：手动创建大纲 → 插入伏笔 → 编排线路 → 固定 → 正文读取
5. 浏览器验收

**验收标准**：
- 工作台布局正确保存和恢复
- Agent 能感知当前选中对象
- 完整流程通畅

## 前端技术栈与组件库

### 核心组件

**大纲编辑器**：
- 基于 TipTap 或 Monaco Editor
- 支持 Markdown 语法
- 支持插入结构化注释（伏笔标记、guidance）

**节点图编辑器**：
- 考虑使用 Vue Flow 或 Reactflow（需 Vue 适配）
- 或自研基于 SVG/Canvas 的轻量编辑器
- 支持拖拽、连线、布局

**对话框与面板**：
- 复用 `nb-ui` 的 Dialog 组件
- 抽屉面板用于详情查看

### 状态管理

**Pinia Store 结构**：
```typescript
// stores/outline.ts
export const useOutlineStore = defineStore('outline', {
  state: () => ({
    currentSchemeId: null,
    outlineEntries: [],
    foreshadowings: [],
    lines: [],
  }),
  actions: {
    async loadScheme(schemeId: string) { /*...*/ },
    async createEntry(entry: Partial<OutlineEntry>) { /*...*/ },
    async updateEntry(id: string, patch: Partial<OutlineEntry>) { /*...*/ },
    async deleteEntry(id: string) { /*...*/ },
    // ... 其他 actions
  },
});
```

## 后端实现清单

### 新增 API 路由

**方案链管理**：
- `POST /api/outline/schemes`
- `GET /api/outline/schemes`
- `GET /api/outline/schemes/:id`
- `PUT /api/outline/schemes/:id`
- `DELETE /api/outline/schemes/:id`

**大纲条目管理**（已有基础，需扩展）：
- `GET /api/outline/entries/:id/references` - 查询引用
- `GET /api/outline/entries/:id/children` - 获取下级条目
- `GET /api/outline/entries/:id/impact` - 删除影响预览
- `POST /api/outline/entries/:id/fork` - 写时分叉
- `PUT /api/outline/entries/:id/order` - 调整顺序
- `PUT /api/outline/entries/:id/materials` - 更新素材索引
- `POST /api/outline/entries/:id/analyze` - 偏差分析

**细纲管理**：
- `POST /api/outline/entries/:chapterId/detailed`
- `PUT /api/outline/entries/:id/detailed`
- `DELETE /api/outline/entries/:id/detailed`
- `GET /api/outline/entries/:id/analysis-result`

**伏笔管理**（已有基础，需扩展）：
- `GET /api/outline/foreshadowing/:id/markers` - 标记来源
- `GET /api/outline/foreshadowing/:id/elapsed-chapters` - 已过章节数
- `GET /api/outline/foreshadowing/:id/anomalies` - 异常列表

**线路管理**：
- `POST /api/outline/lines`
- `GET /api/outline/lines/:id`
- `PUT /api/outline/lines/:id`
- `DELETE /api/outline/lines/:id`
- `POST /api/outline/lines/:lineId/nodes`
- `PUT /api/outline/lines/:lineId/nodes/:nodeId`
- `DELETE /api/outline/lines/:lineId/nodes/:nodeId`
- `PUT /api/outline/lines/:lineId/nodes/:nodeId/fix`
- `POST /api/outline/lines/:lineId/edges`
- `DELETE /api/outline/lines/:lineId/edges/:edgeId`
- `POST /api/outline/lines/:lineId/validate` - 结构校验
- `GET /api/outline/lines/:lineId/validation-result`
- `POST /api/outline/lines/:lineId/analyze-conflicts` - AI 分析
- `GET /api/outline/lines/:lineId/conflicts`
- `PUT /api/outline/lines/:lineId/conflicts/:conflictId`
- `GET /api/outline/lines/:lineId/writer-context` - 正文交接（只读）

### 服务层新增功能

**`packages/neuro-book/server/outline/library.ts`**：
- `getEntryReferences(entryId)` - 查询引用关系
- `getEntryChildren(entryId)` - 获取下级条目
- `previewDeleteImpact(entryId)` - 删除影响预览
- `forkSharedEntry(entryId, currentSchemeId)` - 写时分叉
- `reorderEntries(parentId, entryIds)` - 调整顺序
- `updateMaterialsIndex(entryId, materials)` - 更新素材索引
- `parseForeshadowMarkers(entryBody)` - 解析伏笔标记
- `deriveForeshadowingStatus(foreshadowingId)` - 派生伏笔状态
- `getForeshadowingMarkers(foreshadowingId)` - 获取标记来源
- `getForeshadowingAnomalies(foreshadowingId)` - 获取异常

**新建 `packages/neuro-book/server/outline/line-planning.ts`**：
- `createLine(projectKey, lineData)` - 创建线路
- `addNode(lineId, nodeData)` - 添加节点
- `addEdge(lineId, edgeData)` - 添加边
- `deleteNode(lineId, nodeId)` - 删除节点
- `deleteEdge(lineId, edgeId)` - 删除边
- `fixNode(lineId, nodeId)` - 固定节点
- `validateLineStructure(lineId)` - 结构校验
- `analyzeLineConflicts(lineId)` - AI 冲突分析
- `setMainLine(projectKey, lineId)` - 设置主线
- `getWriterContext(lineId, revisionAnchor)` - 正文交接

**新建 `packages/neuro-book/server/outline/deviation-analysis.ts`**：
- `analyzeDetailedOutlineDeviation(detailedId, chapterId)` - 偏差分析（调用 AI）

### 测试覆盖

**单元测试**：
- [ ] 引用关系查询
- [ ] 删除影响预览
- [ ] 写时分叉逻辑
- [ ] 伏笔标记解析
- [ ] 伏笔状态派生
- [ ] 素材索引优先级计算
- [ ] 线路结构校验
- [ ] 主线唯一性

**集成测试**：
- [ ] 创建完整三级大纲
- [ ] 共享条目修改触发分叉
- [ ] 伏笔标记插入并解析
- [ ] 细纲偏差分析流程
- [ ] 线路节点固定与正文交接

**E2E 测试**：
- [ ] 手动创建大纲 → 插入伏笔 → 编排线路 → 固定 → 模拟正文读取
- [ ] 删除大纲条目展示影响
- [ ] 伏笔异常检测与修复

## 注意事项

1. **依赖关系**：本文档中依赖 schema v2 的功能（写作指导、参考文件、场景篇幅、伏笔设计、已过章节数）需等待一.2 完成后启用
2. **渐进实现**：按阶段实现，每个阶段完成后验收，避免大批量改动
3. **UI/UX 设计**：工作台编辑界面需设计稿或原型图，确保交互流畅
4. **性能考虑**：节点图编辑器对大型图的性能优化（虚拟化、懒加载）
5. **权限控制**：所有写入操作需检查 Project 权限
6. **事务一致性**：批量操作（如删除卷纲影响多个章节）需在同一事务内完成

## 参考资料

- [大纲规划 Proposal](../../../../../docs/proposals/outline-planning-module.md)
- [实施计划](../../implementation-plan.md) - Phase 2/3/4
- [大纲库 Spec](../../../../../docs/specs/outline/planning-library.md)
- [伏笔 Spec](../../../../../docs/specs/outline/foreshadowing.md)
- [线路规划 Spec](../../../../../docs/specs/outline/line-planning.md)
