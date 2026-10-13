# 项目提案

`docs/proposals/` 保存尚未生效、需要评审的产品或工程方案。Proposal 把原始自然语言整理成问题、目标、备选方案和影响，用来决定“应该采用什么长期行为”；它不是 Spec、实现 Task、待办清单或过程日志。

当前活跃提案：

- [`写手酒馆预设兼容与编排工作区`](./writing-sillytavern-preset-compatibility.md)：写手样本及产品接入开发已授权，编辑、变量作用域、参数与输出行为见 planned Spec；通用插件和增强工作区仍为 `draft`。

- [`角色管理工作区与可移植 Demo`](./character-management-workspace.md)：单项目 `/character/` 文件来源、三栏角色页、图片相对路径、按方案隔离经历／关系／知识；数据原则已确认，先交付独立 Demo，正式接入待 UI 评审，状态为 `reviewing`。

- [`摘要模型与自定义 Provider 配置`](./context-management-model-settings.md)：为上下文摘要选择独立的全局模型，并提供可自由填写与修改连接参数的 Custom Provider 空模板，状态为 `accepted`。

- [`细纲资料补充与独立审核`](./writing-detail-material-review.md)：统一地点、服饰与角色引用模板，助手按情节读取资料，独立审核通过后交写手，状态为 `accepted`。

- [`三模块统一提示词管理`](./unified-prompt-management.md)：全局管理设计、提取、规划与写作的全部模型提示词，前置消息支持三种角色，已有会话固定版本、内置默认只读；Demo 已评审，已授权正式实装，状态为 `accepted`。

- [`设计工作台素材改编`](./inspiration-design-adaptation.md)：显式选择现有角色、势力等参考，保存来源快照，审阅后另存新素材、保留原素材，状态为 `accepted`。
- [`大纲规划 Agent 的提取素材运用与改编模式`](./outline-material-use-and-adaptation.md)：角色人设、经历与关系运用，笔记先索引后正文，基础资料只读、按方案维护改编记录与稳定章节定位，状态为 `accepted`。
- [`大纲规划原创与改编流程重构`](./outline-original-adaptation-flow.md)：会话模式锁定、原创／改编独立提示词、素材类别前置检查和改编工作区原子创建，状态为 `accepted`。

- [`大纲规划模块`](./outline-planning-module.md)：替换《新小说编写计划》中的大纲与细纲部分和伏笔部分，含大纲库、伏笔库、线路规划、伏笔埋入与回收管理，以及模块 Agent 与三个专用子 Agent，状态为 `accepted`。
- [`正文写作模块`](./writing-module.md)：接在大纲规划之后把细纲写成正文，含工作台写作界面、正文与规划绑定、主创/助手/写手三角色的助手与作家系统和问题回流，状态为 `accepted`。
- [`Inspiration 作品大纲提取与大纲库接轨`](./inspiration-outline-extraction.md)：修复为每方案一个总纲，新增“原文 → 细纲 → 章纲 → 卷纲 → 总纲”的程序化提取流水线、划卷与重复提取去向，以及与之分开的九类素材提取流水线，状态为 `accepted`。
- [`Inspiration 作品提取界面优化与旧入口下线`](./inspiration-extraction-workbench-ui.md)：沿用旧分块预览与选择形式，优化作品提取页布局、素材选块、大纲切分方式、下线旧入口并清除旧提取会话与草稿、修复二级菜单错位；本轮范围为 A 到 E，其余问题另开批次，状态为 `accepted`。
- [`角色分组提取与缓存友好请求`](./material-extraction-cache-and-character-batching.md)：按角色覆盖率在同一分块内分组提取，稳定模板先于动态目标，并记录任务关联的缓存用量；真实 Provider 缓存命中率另行验收，状态为 `accepted`。
- [`跨小说项目共享素材库与向量检索`](./shared-material-library-vector-search.md)：用户级共享写作手法与写作素材，采用 Markdown 正文与 SQLite 派生索引、按需求检索后读取正文的设想；仅记录后续优化灵感，写入去向、迁移与接口尚待决策，状态为 `draft`。

- [`../packages/neuro-book/docs/proposals/character-workbench.md`](../../packages/neuro-book/docs/proposals/character-workbench.md)：Character 导航、搜索、编辑与 Low-code Form 合同，状态为 `reviewing`。
- [`Agent Skills 项目化适配`](../../packages/neuro-book/docs/proposals/agent-skills-adaptation.md)：状态为 `accepted`；旧适配流程作为历史保留，当前专项技能与验证分工由 P-005 最新决策取代。
- [`../packages/neuro-book/docs/proposals/agent-model-execution-surfaces.md`](../../packages/neuro-book/docs/proposals/agent-model-execution-surfaces.md)：Harness Agent、completion 与 headless 三套调用面、Catalog、授权和 Workflow 重放边界，状态为 `accepted`。
- [`p-005-development-workflow-governance.md`](./p-005-development-workflow-governance.md)：`P-005`，Work 本地登记、无正式角色的 Task 当前快照、主 Agent 直接执行与按需协调、专项技能和最小充分验证，状态为 `accepted`。
- [`应用运行时与内置插件架构`](../../packages/neuro-book/docs/proposals/application-runtime-and-plugins.md)：状态为 `accepted`，接受基础架构及“环境/小内核 → 最小服务插件 → Lab → Files → Settings → World/Plot”分段方向；前两片七项 `planned` Spec 已登记。本轮交付规范与实施规划，未实施产品；任意热卸载/升级仍仅为后续评估。
- [`model-roles-contract.md`](./model-roles-contract.md)：模型角色的后端契约（全局配置 `roles` 段、按 role 解析模型的优先级、本地模型已由 Provider 机制覆盖的结论），状态为 `draft`，等待「未决取舍」拍板。
- [`nb-ui-surface-model.md`](./nb-ui-surface-model.md)：nb-ui 表面模型，把材质（玻璃 / 实心，整页只有一层且只有它开模糊）与层级（不透明色阶，可嵌套、按位置自动推导）拆成两条轴，材质层有可读性不透明度下限，状态为 `accepted`。
- [`../packages/neuro-book/docs/proposals/workbench-view-host.md`](../../packages/neuro-book/docs/proposals/workbench-view-host.md)：Workbench 与 View Host（descriptor 注册表、可序列化拆分树原语、布局状态四类分层、视图跨容器与容器跨栏移动），状态为 `accepted`。
- [`workbench-commands.md`](./workbench-commands.md)：命令系统与单一注册表（命令单一身份、`when` 上下文求值、交互入口统一分发命令 id、命令面板与派生快捷键表），状态为 `draft`。
- [`storage-service-and-sync.md`](./storage-service-and-sync.md)：跨独立 data 在线同步的身份对齐、复制确认、冲突与删除收敛，状态为 `draft`；已批准本地行为见 [storage.persistence](../specs/storage/persistence.md)。
已完成沉淀的信息架构提案见 [`../packages/neuro-book/docs/archived/proposals/documentation-information-architecture.md`](../../packages/neuro-book/docs/archived/proposals/documentation-information-architecture.md)。
已否决的 nb-ui 浮层 portal 宿主提案见 [`../packages/neuro-book/docs/archived/proposals/nb-ui-overlay-portal-host.md`](../../packages/neuro-book/docs/archived/proposals/nb-ui-overlay-portal-host.md)，仅供重开时参考。

## 何时需要 Proposal

满足任一条件时创建 Proposal：

- 新增产品功能或改变用户可观察行为；
- 跨越多个模块、数据所有权或进程边界；
- 改变持久化格式、公开接口、权限、安全、安装、发布或兼容承诺；
- 存在两个以上长期方案，需要记录取舍和放弃原因。

局部修复、机械迁移和现有 `implemented` Spec 内的实现不单独创建 Proposal；它们直接进入根 `.agents/works/` 的 Work/Task，并在需要时同步 Spec。期望行为仍有歧义的 bug 先进入 Proposal，不能由实现者猜测。

## 最小结构

每个 Proposal 使用英文 kebab-case 文件名，并包含：

1. `状态`：draft、reviewing、accepted、rejected 或 superseded；
2. `问题`：用户或系统面对的可观察问题；
3. `目标与非目标`；
4. `当前行为与证据`；
5. `方案、备选方案和取舍`；
6. `数据、接口、安全、迁移、发布与回滚影响`；
7. `对 Spec 的预期改动`：目标 capability、输入、输出、状态、副作用、失败与验收；
8. `决策记录`：日期、决策者和结论。

## 生效规则

- `draft`和`reviewing`只供讨论，不能被代码、测试或Agent当作当前行为依据。
- `accepted` 表示长期取舍已决定，可更新 `planned` Spec，并按当前已知结果创建或复用根 `.agents/works/` 的 Work 与 Task；Proposal 本身不自动成为规范或执行授权。
- 实施前把已批准行为写入[`../specs/README.md`](../specs/README.md)注册的当前规范。Task可引用Proposal并协作准备指定Spec，但只有开发者明确接受的决定可进入`planned`合同。
- `.agents/works/` 记录 current 一次设计或实现的范围、授权、当前快照和证据链接；Work/Task 引用 Proposal 与 Spec，不复制正文。`.agents/tasks/` 只保存 legacy provenance。
`rejected`、`superseded` 和已经完成沉淀的 Proposal 移入 [`../packages/neuro-book/docs/archived/`](../../packages/neuro-book/docs/archived/) 下的 proposals 分类；当前规范不依赖归档内容才能被理解。

