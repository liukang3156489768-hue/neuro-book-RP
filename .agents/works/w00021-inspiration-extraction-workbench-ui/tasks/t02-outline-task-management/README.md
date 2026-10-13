---
schema: nbook.task/v2
taskId: t02-outline-task-management
---

# 大纲提取任务管理与文档修复

## 授权与范围

2026-10-04 开发者要求修复此前三份文档的 YAML frontmatter 问题，并为大纲提取增加与素材提取同位置的任务列表、新建、切换和删除能力。复用 Work 已批准的主工作区，不提交、不调用真实模型、不删除真实作品产物。

合同：[大纲提取](../../../../../docs/specs/inspiration/outline-extraction.md)、[细纲模板](../../../../../docs/specs/outline/outline-entry-templates.md)。删除任务复用既有服务端清理合同，已写入大纲方案和素材文件保留。

## 当前快照

2026-10-04 已完成。

- 模型选择旁的管理区域按入口显示大纲/素材列表，共用 FormSelect、新建和删除控件。大纲列表恢复最近任务，切换显示对应进度与方案结果，新建重置章节修正、切分和去向；删除复用现有任务服务，先停止运行，再清理记录及临时产物，保留已写入大纲方案/条目。
- 新增大纲任务列表加载、选择和删除动作；结果请求与初始历史恢复都带选择代次保护，旧响应不能接管新任务或覆盖当前方案。删除失败保留结果并说明原因。
- `outline-entry-templates.md` 补齐 planned 行为规范元数据、合同章节和注册表登记；两份已废弃标注文档迁至 `packages/neuro-book/docs/archived/reference/`，修正当前入口和引用。没有晋升 implemented。

## 有效证据

- 四个文件共 40 项通过：`bun run --cwd packages/neuro-book test app/composables/useInspirationExtraction.test.ts app/composables/useExtractionTaskTracker.test.ts app/components/novel-ide/inspiration/extraction/extraction-views.test.ts server/api/inspiration/extraction/routes.test.ts`。新增覆盖列表恢复、切换对应、新建默认去向、迟到结果隔离、初始列表迟到不接管新设置、删除失败及成功。
- 最终全应用 `bun run --cwd packages/neuro-book typecheck` 通过。
- `bun run docs:check` 0 failures，83 条既有非阻断 warnings；三项缺 YAML frontmatter 的失败均消除。范围内 `git diff --check` 无 whitespace 错误。
- 浏览器：本机自动浏览器导航到 HTTP 测试端口发生加载超时，改用真实 `InspirationExtractionPanel` 与 nb-ui 的 Vite 临时 bundle 直接载入隔离浏览器，模拟任务 API；恢复、历史切换、类型切换、新建/启动/删除和窄屏下拉选择全部通过。桌面 1603px：模型右缘 368、任务左缘 376；390px：文档 scrollWidth 375，任务范围 8..367，任务 top 162 位于模型 bottom 154 下方，无水平溢出。临时 fixture 与脚本在系统 Temp，不成为产品资产。
- 未执行真实模型提取、真实任务删除或完整项目页面旅程；浏览器结果只证明真实组件的交互与布局，不能替代真实模型或完整宿主验收。
