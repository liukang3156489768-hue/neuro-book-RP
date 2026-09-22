# 晴窗 UI/API 连接与验证

2026-09-20。开发者批准先核对连接再按晴窗风格实装；Demo 不作为功能规格。以下连接来自现有源码调查，不等同于已实际执行全部 API。

## UI 与数据所有权

| 界面 | Owner | 实际连接与保护条件 |
| --- | --- | --- |
| 书架与作品切换 | `ProjectPickerScreen`、`novel-ide` store、`useProjectSession` | `GET/POST /api/projects`、封面接口；`POST /api/projects/open` 后等待 `GET /api/projects/presence` SSE 的 matching `presence_ready`，才激活数据面。 |
| 文件树与 Studio | `novel-ide` store、`useMarkdownStudioController`、页面事件 | `/api/workspace-files/tree`、`stat`、`read`、`PUT write`；创建、重命名、上传下载继续经 store。写入带 `baseContent`、`expectedMtimeMs`，冲突进入原弹窗，不强制覆盖。 |
| 文件外部变化 | `useWorkspaceFileEvents`、页面同步队列 | `GET /api/workspace-files/events` SSE，按当前 Project 或 user-assets 隔离。 |
| Agent | `AgentChatSurface`、`useAgentSessionApi`、`useAgentSessionStream` | `/api/agent/sessions`、`/{id}`、`/{id}/invocations`、`commands`、`tree`、`abort`、`events`；事件恢复带 `after/eventEpoch`。不能以动画为由替换会话、复制 SSE 或改变激活时机。 |
| 行内 AI | 页面 inline editor controller 与独立会话 | 与右侧聊天共享协议但不共享所有权；发送/停止、引用与结果审查仍走原 handler。不得因 Demo 只有一个输入框而移除。 |
| 输入草稿与附件 | `useAgentSessionApi` | `/api/agent/composer-drafts` GET/PUT/DELETE；会话附件上传、解析、snapshot 和 message entry 原接口。外壳不保存第二份草稿。 |
| 剧情 | `NovelPlotPanel` 与 Plot workbench | `/api/projects/plot/tree`、`workbench`、`threads`、`scenes`、`chapters` 及相应写入；参数保留真实 `projectRoot`。 |
| 世界状态 | `WorldEngineWorkbenchDialog` | `/api/projects/world-engine/subjects`、`slices`、slice edit 和 subject-file-proposals；保留 dirty/saving 状态与切换保护。 |
| 变更/追踪/任务 | 既有 inbox、trace API、jobs feed | `/api/workspace-history/inbox`、`/api/agent/traces/**`、`/api/agent/jobs`、`jobs/events`；既有查看/取消/审查入口保留。 |
| 登录与账户 | auth session、页面 | `/api/auth/me`、`POST /api/auth/logout`，不通过改主题改鉴权。 |

## 设置不是单一配置对象

- 外壳直接读取 `GET /api/app/version`，维护 scope/section 与当前面板 dirty/loading/saving；保存、恢复委托六个业务面板。
- 全局/项目读取：`GET /api/config/editor-snapshot`；保存分别 `PUT /api/config/global` 与 `PUT /api/config/project`。`useConfigApi` 构造 workspace 查询并在保存后增加 config revision。
- 模型：library、provider-templates、provider-references、model-check、provider-discover。check/discover 会访问外部 Provider，本次不自动调用。凭据继续使用原 draft/masked/clear 合同，不读取或记录原值。
- Agent Profile：`GET /api/agent/profiles/settings`、`build-status`，profile-home reset 仅保留入口，不在视觉 smoke 中执行。
- 费用：`GET /api/config/exchange-rate`；后端负责缓存与外部汇率获取，UI 优化不新增轮询。
- 主题：bootstrap → store → `resolveTheme` → `useIdeTheme`；切换经 `useThemeManager` 即时应用，再按原全局 UI 分支保存，失败回滚。沿用 `light` ID，保留 sepia/暗色/自定义选择。
- 浏览器的编辑器与布局偏好继续由 store 持久化；Desktop 设置继续使用 bridge。启动鉴权继续是 Boot Config，不合并到全局模型配置。

## 改动与验证记录

### 实现范围

- `app/pages/index.vue`：作品/文件标题、悬浮面板、覆盖抽屉、隐藏区域 inert、关闭焦点恢复、Agent 原生命周期上的过渡；修复 user-assets 文件抽屉无法收起。窄屏 Agent 会话栏与 Studio 互斥，Desktop 外壳保留扣除标题栏后的高度。
- `NovelIdeActivityBar.vue`、`NovelIdeToolPanel.vue`：圆角导航与工具抽屉、可访问按钮名称。`MarkdownStudioWorkbench.vue` 移除固定 640px 最小宽度。
- `NovelIdeSettingsDialog.vue`：约三分之二面积的设置弹窗、独立滚动、窄屏横向分类和固定保存区；主题子弹窗打开时父层不处理 Escape。原 script 和六类配置操作保持。
- `theme-tokens.ts`：沿用 light ID 的晴窗浅蓝灰主题；其他主题及源码默认值不变。本机按开发者选择，经原 Global Config API 仅提交 UI 分支，把 sepia 切换为 light；保留自定义主题，不提交其他配置分支。
- 四个修改的 UI 组件补同名组件边界说明；API/store/后端/schema 未修改。

### 已执行验证

- 应用 `bun run --cwd packages/neuro-book typecheck` 通过。
- Project ready、Agent API、Agent SSE、模型设置草稿：4 文件 55 测试通过；主题解析与变量：6 文件 22 测试通过；工作台导航和保留的设置响应式合同：2 文件 5 测试通过，共 82 测试。
- 测试使用 Node + `startVitest` 的前端聚焦配置：root 为应用包，`config:false`、`environment:node`、`nbook` alias 指向应用包；setupFiles 和 globalSetup 均保留 `@notnotype/neuro-book-test-support/vitest`。标准应用测试启动被 Windows 现有 Agent snapshot fixture 的 symlink EPERM 阻塞；因此不宣称标准全量测试通过。
- 删除设置响应式合同中两个绑定旧 class/固定高度字符串的实现镜像断言，以真实浏览器桌面/390px尺寸与溢出检查替代；未修改其余 Profile/模型面板断言。
- 无头 Edge + Playwright 访问运行中的 `http://localhost:3000`，打开真实作品“那些年”；Project presence 与 workspace-files events 保持连接，文件树加载，无页面运行错误。
- 1440×1000：设置稳定尺寸为 1180.8×820，占视口 67.24%；四个作用域均可切换，分类随作用域保持，保存/恢复入口存在。
- 390×844：设置为366×692.1，页面 scrollWidth=390，内容区 clientWidth=scrollWidth=354；保存与恢复位于可见区域。主界面 scrollWidth=390，工具和 Agent 抽屉稳定宽度326；工具关闭后 inert=true、aria-hidden=true、宽度0，焦点返回 files 按钮；Agent 关闭后节点卸载。
- 独立代码复核发现窄屏 Agent 会话栏和 Studio 可重叠，已加入互斥处理并再次通过应用 typecheck。最后一轮浏览器检查受审批服务 403 中断，互斥修复尚未完成浏览器复验。user-assets 打开新标签，原页面等待脚本超时，因此其收起修复本轮仅代码复核，不宣称已有浏览器证据。

### 截图证据

实际产品截图位于本任务显式输出目录 `C:/Users/liu/.codex/visualizations/2026/09/20/01a0bd78-35d1-7a91-8df0-f20657181551/`：

- `qingchuang-workbench.png`：1440×1000 主工作台。
- `qingchuang-settings.png`：1440×1000 设置。
- `qingchuang-workbench-mobile.png`：390×844 收起工具后的工作台。
- `qingchuang-settings-mobile.png`：390×844 设置。

### 验证边界

浏览器仅操作布局、设置分类和项目选择，未编辑/删除真实正文，未执行 Provider check/discover、模型生成或配置凭据保存。文件写入冲突、附件上传、Plot/World 修改等本轮仅调查既有 owner 和连接，没有逐项端到端重测。Desktop 原生窗口尚未运行，标题栏高度仅完成代码复核。完整可访问性和所有旧业务弹窗不属于本轮已完成的验收。

开发服务器首次加载和 HMR 期间曾出现动态模块 MIME/加载失败；reload 后实际页面加载、后续操作无 console warning/error 和 pageerror。未确认该瞬态问题的根因，不把 HTTP 200 视为页面验收。

本机 Git/.agents 写权限审批服务返回 503；开发者随后指示先更改。源码按此指示在当前工作区实施，不执行受阻的 Git/.agents 写入，不声称已有 Work 登记或 worktree。最终浏览器只读状态检查及关闭新建验收浏览器均返回自动审批服务 403，未执行这些调用，没有绕过审批；新建无头浏览器清理未能确认。远端写入、发布和真实模型均未获授权。

### Agent Profile 覆盖设置外壳的回归修复

用户随后提供大屏截图：Profile 标题和内容盖住配置中心标题、一级分类和作用域工具栏。代码确认 Profile 原根节点的 `xl:absolute xl:inset-0` 依赖旧内容区的定位边界；外壳迁移后该边界丢失，绝对定位回退到整个 Dialog。此前仅切换作用域的浏览器检查未捕捉这一布局回归。

修复将 Profile 改为正常文档流中的 flex 面板，由设置宿主在 xl 下逐层分配剩余高度。Profile 列表和表单保留独立滚动，其他分类与小屏保留整体滚动；未改 API、脚本或配置保存逻辑。补充 Profile 组件说明及设置宿主的布局约束。

两个修改组件的 script/template/style 编译通过，现有设置响应式合同 2 项通过，文档检查通过；独立代码复核确认高度、宽度与断点一致。浏览器只读复验再次遭自动审批服务 403 阻断，未获得修复后的真实截图；静态检查不替代此项视觉验证。按用户要求仅保留工作区改动，不执行暂存、提交或写入 `.git`。

### 页面型窗口统一尺寸

根据用户追加的四张截图，将公共 Dialog 的 xl/full 预设统一为设置原先采用的82%视口宽高；设置本身删除局部尺寸覆盖，统一消费 `app/utils/dialog-layout.ts`。因此剧本、世界引擎、请求记录、变更收件箱、RAG、Profile工作台、账户和图片预览自动获得相同比例。公共标题/底部不压缩，内容保留可收缩滚动区域。

批量迁移先 dry run，确认每文件仅命中一个弹窗标签后更改以下13个组件的尺寸属性：DiffWorkbenchDialog、AgentSessionDialog、AgentSessionTreeDialog、ModelDiscoveryDialog、ModelLibraryDialog、NovelIdeModelEditDialog、WorkspaceCharacterDetailPanel、WorkspaceLocationProfileDialog、WorkspaceRuleProfileDialog、ProfileTemplatePreviewDialog、AgentJobsDialog、AgentContextInspectorDialog、ThemeEditorDialog。业务请求、字段、事件保持原样。DialogWindow 增加 workbench 尺寸并首次居中，拖动/缩小视口时约束到屏幕内；简短确认和输入框继续使用原内容尺寸。

本轮浏览器工具恢复，可操作真实“那些年”工作区。1920×1080下设置、世界引擎、剧本工作台稳定尺寸均为1574.39×885.59；请求记录和变更收件箱实测与其误差小于1px（入场动画采样）。主题编辑窗口约1574.4×885.6，打开后取消，没有保存主题。390×844下剧本窗口366×692.08、页面scrollWidth=390；可拖动窗口缩放后边界位于视口内，取消按钮可点击。仅验证窗口边界，未宣称所有业务双栏均已完成移动端重排。

同时复验上一轮Profile越界修复：1920×1080下Profile区域为x=510.98、y=282.20、宽1120、高665.59；设置工具栏底部y=236.20，Profile完整位于其下方，不再覆盖顶部栏。

44个弹窗组件和使用页面的script/template/style编译通过，应用typecheck通过，文档检查通过。新增公共Dialog/DialogWindow说明；上述仅改尺寸的既有业务组件仍缺少独立同名说明，未在本轮扩写其业务合同。截图输出为任务可视化目录的`qingchuang-world-unified.png`和`qingchuang-plot-unified.png`。所有修改仅保留工作区文件，没有暂存、提交或写入Git元数据。
