---
schema: nbook.task/v2
taskId: t08-outline-workbench-ui
---

# 全屏大纲规划工作台 UI

## 目标与范围

执行实施计划 Phase 6：提供 Project 作用域的全屏左右分栏工作台，持久化 Agent 区布局与用户偏好，展示大纲库、伏笔库和线路规划三个只读视图，并为规划 Agent 流式上下文保留专属 UI 容器。组件不自行推导伏笔状态、线路资格或权限，也不伪造真实模型输出。

## 当前快照（2026-09-25）

- 新增 `useOutlineWorkbenchData`，并行读取 `snapshot`、`library-trees`、`foreshadowing-states` 三个 Project API；请求按 `projectRoot` 隔离，迟到结果不能污染新 Project，视图直接消费服务端 DTO。
- 新增 `OutlineWorkbenchDialog.vue`：全屏 Dialog、约五分之一 Agent 区、拖拽分隔线、左侧宽度不超过窗口中线、按 Project Storage 恢复布局；已包含思考开关、模型选择、温度增减、讨论/自动模式和三段只读视图。
- 左侧已通过 `useOutlineWorkbenchAgent` 接入规划 Profile、真实 Agent Session、SSE 流、会话恢复、取消、待处理用户输入和审批提交；工作台不自行执行规划写入，也不伪造模型结果。
- `index.vue` 已挂载工作台并在关闭 Project 时清理开关；`NovelIdeActivityBar.vue` 已增加“大纲规划”入口和 Project 门禁。
- Project Storage 定义与会话已在 `shared/storage/outline-workbench.ts`、`app/utils/outline/outline-workbench-session.ts` 落地；非 Project 工作面使用默认值且不写盘，损坏记录不覆盖原记录。

## 有效验证

- `bun run --cwd packages/neuro-book typecheck`：通过。
- `bun run --cwd packages/neuro-book test app/components/novel-ide/NovelIdeActivityBar.test.ts --config vitest.frontend.config.ts`：1 文件、4 项通过。
- `bun run --cwd packages/neuro-book test app/components/novel-ide/outline/OutlineWorkbenchDialog.contract.test.ts --config vitest.frontend.config.ts`：1 文件、2 项通过。

## 未验证与未完成

- 未执行浏览器人工验收；未验证真实全屏尺寸、拖拽中线边界、项目切换恢复和窄屏不支持边界。
- `outline-workbench-session.test.ts` 已覆盖缺失记录、Project 切换恢复、损坏记录不覆盖、冲突重试和非 Project 不写盘；完整浏览器尺寸仍需人工确认。
- 规划 Agent 的真实 Session／流式／取消／审批接线已有组件合同和工作台接入，但 Profile 运行时 Windows fixture、默认全包和真实模型仍未验证。
- Phase 6 仍保持进行中，不能将 Spec 晋升为 `implemented`。

## 下一步

先按统一 Work 门禁执行浏览器人工验收，确认 Project 隔离、拖拽边界、三视图只读语义和审批／取消交互；随后处理 Profile 运行时 fixture 与默认全包环境边界。

## 合同

- [实施计划](../../implementation-plan.md)
- [工作台 UI Spec](../../../../../docs/specs/outline/workbench-ui.md)
- [Storage 定义](../../../../../packages/neuro-book/shared/storage/outline-workbench.ts)

## 2026-09-25 Agent 与异常展示收尾

- `useOutlineWorkbenchAgent` 与 `OutlineWorkbenchAgentPane` 已实际接入规划 Profile、SSE 流、会话恢复、取消、待处理用户输入和审批提交；工作台只把 Project 会话作为 UI 容器，不自行执行规划写入。
- `outline-workbench-session.test.ts` 已覆盖缺失记录、Project 切换恢复、损坏记录不覆盖、冲突重试和非 Project 不写盘，当前 4 项通过；规划 Agent 工作台合同、异常标记展示合同和 Markdown 编辑器合同组合 8 项通过。
- 伏笔库新增逐章标记解析异常展示，损坏章节仍保留服务端返回的其他有效来源。浏览器人工验收仍未执行。

## 2026-09-26 工作台编辑能力（一.1）

- 三个视图由只读改为可编辑，写入全部经 `useOutlineWorkbenchActions` 调用现有单路由领域操作，组件不推导伏笔状态、节点有效性或写入资格：
  - 大纲库 `OutlineLibraryPanel.vue`、`OutlineEntryForm.vue`、`OutlineDetailAnalysisPanel.vue`：方案链与条目增改删、移动、共享条目写时分叉、总纲全局确认、写作指导／参考文件／篇幅字段、细纲分析后逐条确认采用。
  - 伏笔库 `OutlineForeshadowingPanel.vue`、`outline-foreshadow-form.ts`：定义与设计分项编辑、确认；章节大纲正文按选区插入标记。
  - 线路规划 `OutlineLinePanel.vue`、`OutlineLineAnalysisPanel.vue`：草稿线路新建与编辑、节点条带（前移／后移／更换条目／删除）、连线增删、按影响哈希确认删除、设为主线、退回草稿、旧版线路升级、分析后逐条说明冲突再固定；节点状态取自 `inspect-line`。
- 验证：`bun run test app/components/novel-ide/outline app/utils/outline --config vitest.frontend.config.ts` 8 文件 30 项通过（含工作台合同 3 项）；`docs:check` 6578 文件、0 失败；应用 typecheck 通过（常规堆内存下一次 V8 崩溃，`NODE_OPTIONS=--max-old-space-size=8192` 重跑通过）。
- 未完成：线路自由画布与拖拽、伏笔标记悬停卡片、素材索引高级编辑器；浏览器人工验收和真实模型的 `analyze-detail`／`analyze-line` 未验证。

## 2026-09-26 规划未初始化 ENOENT 修复

- **现象**：打开工作台后反复提示 `ENOENT: no such file or directory, open '...\outline\manifest.yaml'`。
- **原因**：只有 `POST /api/projects/outline/open`（`openReadyPlanning`）会初始化 `outline/manifest.yaml`，但 `useOutlineWorkbenchData` 只调用 snapshot、library-trees 和 foreshadowing-states 三个只读接口；仓储读取时直接 `fs.readFile`，原始错误连同本机路径透传到界面和 Agent 工具。
- **改动**：
  - `useOutlineWorkbenchData.refresh` 对每个 Project 首次加载先调用 open，完成初始化和事务恢复；同一 Project 不重复调用，失败后下次刷新重试；
  - `OutlineRepository.readCanonicalFiles` 在缺少 manifest 时抛出 `OutlineTransactionError("NOT_INITIALIZED")`，路由映射为 409，只读入口仍不创建文件。
- **证据**：新增 `useOutlineWorkbenchData.test.ts` 3 项（默认 `vitest.config.ts` 收集 `app/composables`，前端配置不收集），以及 `storage.test.ts` 的未初始化用例，均通过。补测时发现该 composable 未显式导入 `readonly`，只靠 Nuxt 自动导入才能运行，已补上导入。大纲前端 8 文件 30 项仍通过。浏览器人工验收未执行。

## 2026-09-28 大纲库与伏笔库直接编辑

- 目标：取消查看态与编辑态，大纲库各级条目和伏笔选中即直接编辑，正文用富文本，标注从浮动菜单操作，改动自动保存。
- 新增：`OutlineRichTextEditor.vue`（富文本正文与标注浮动菜单）、`useOutlineAutosave.ts`（防抖保存、回显与冲突判断），以及 `OutlineEntryForm`、`OutlineLibraryPanel`、`OutlineForeshadowingPanel` 的同名 `.md`。
- 重写：`OutlineEntryForm.vue`、`OutlineLibraryPanel.vue`、`OutlineForeshadowingPanel.vue`；`OutlineDetailAnnotations.vue` 增加当前标注高亮与聚焦。
- 规格：`workbench-ui.md` 新增“大纲库与伏笔库的直接编辑”行为与验收条目；`planning-library.md`、`foreshadowing.md`、`detail-writing-guide-annotation.md`、大纲 `README.md` 同步。
- 工作台合同测试的 CSS 变量提取不再把 BEM 修饰类（`marker--plant`）误判为变量；富文本编辑器中 4 个未定义变量改为 nb-ui token。
- 验证：前端配置跑 `app/components/novel-ide/outline`、`app/utils/outline`、`app/components/markdown-studio`、`app/composables` 共 15 文件 89 项通过；默认配置跑 `useOutlineAutosave.test.ts` 3 项通过；应用 typecheck 通过（`NODE_OPTIONS=--max-old-space-size=12288`）。
- 未验证：浏览器中的输入、浮动菜单、自动保存节奏，`390×844` 与浅色、深色主题下的布局。

## 当前未完成边界

- 仍未在真实浏览器验证全屏尺寸、拖拽中线、Project 切换关闭重开、窄窗口不支持边界和审批/取消交互。
- Profile 运行时的 Windows symlink/目录权限夹具仍不能启动，默认全包和真实模型仍未执行；浏览器人工验收也未执行，Phase 6 继续保持进行中。
