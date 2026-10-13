---
schema: nbook.work/v1
workId: w00019-writing-module
issueId: null
---

# 正文写作模块落地

## 目标与授权

本 Work 承接开发者 2026-09-28 至 2026-09-29 的讨论与确认：把大纲规划的细纲写成正文。设计与取舍见 [正文写作模块 Proposal](../../../docs/proposals/writing-module.md)（accepted）。

2026-09-29 开发者确认了以下内容：

- 四份 `planned` Spec 与交接 Spec 的改写；
- 补充的全部默认规则；
- 写作模块以大纲库层级为准，线路规划暂时只供用户梳理剧情。

确认后，开发者要求拆分实现任务。

当前授权范围：

- 按下方切片在主工作区实现、写测试和做本地验证；
- 按需更新对应的 Spec 与 Task 快照。

未授权、需另行确认：

- 提交、推送、PR 或其他远端写入；
- 调用项目内已配置 API 以外、需付费或需用户凭据的真实模型（2026-09-29 开发者允许用项目内已配置的 API 做真实模型验收）；
- 使用真实用户作品验收；
- 删除或覆盖用户已有文件。

## 执行位置

主工作区 `master`，不建 worktree。原因是写作模块直接依赖大纲规划模块（w00018），而后者的改动还没有提交：交接代码 `packages/neuro-book/server/outline/writer-context.ts` 与细纲格式都在主工作区里。从 `master` 新建的 worktree 会缺少这些内容。这是开发者此前“在主工作区开发、不提交”的约定。大纲规划的改动提交后，后续切片可以改在 `.worktree/w00019-writing-module` 进行。

## 合同

| capability | Spec |
|---|---|
| `outline.writer-handoff` | [writer-handoff.md](../../../docs/specs/outline/writer-handoff.md) |
| `writing.prose-binding` | [prose-binding.md](../../../docs/specs/writing/prose-binding.md) |
| `writing.collaboration` | [collaboration.md](../../../docs/specs/writing/collaboration.md) |
| `writing.issue-feedback` | [issue-feedback.md](../../../docs/specs/writing/issue-feedback.md) |
| `writing.workspace-ui` | [workspace-ui.md](../../../docs/specs/writing/workspace-ui.md) |

## 实施切片

按依赖顺序排列。按 Work 规则，只在前一片结果明确后才创建下一片的 Task，下表只是计划，不是已登记的 Task。

| 序 | 切片 | 合同 | 依赖 | 内容 |
|---|---|---|---|---|
| 1 | 交接改为按大纲库读取 | `outline.writer-handoff` | 无 | 按写作方案返回章节目录与章节上下文；移除对线路的依赖；伏笔标记取自章节大纲。已登记为 [t01](tasks/t01-library-based-handoff/README.md) |
| 2 | 正文绑定与章节状态 | `writing.prose-binding` | 1 | 作品写作设置；正文文件头 `writing` 字段；创建正文文件与卷目录；章节状态派生；手动关联与解除；只读 HTTP 与写入接口 |
| 3 | 写作素材的程序部分 | `writing.collaboration` 中的程序字段 | 1 | 文风文件解析；字数口径；场景切分（多份细纲、写作提示、首标题前内容）；按场景截取细纲原文、段落写作指导、伏笔标记；上一章结尾截取；摘录按位置取原文；结构 A 到 D 的校验与渲染。全部是纯函数，可以单测 |
| 4 | 问题回流的存储 | `writing.issue-feedback` | 1 | 问题记录格式与按章存储；去重；待复核派生；忽略；查询接口 |
| 5 | 三个 Profile 与写作工作流 | `writing.collaboration` | 2、3、4 | 主创、助手、写手 Profile 与工具权限；基于 `nb-workflow` 的场景循环、审阅与重写、运行记录与恢复、停止与继续、写作中的版本复核 |
| 6 | 改写流程 | `writing.collaboration` 改写部分 | 5 | 目标段落扩展与上下两段截取；结构 D；新旧对照与确认替换 |
| 7 | 写作界面 | `writing.workspace-ui` | 2、4、5 | 左栏“大纲”容器与活动栏入口、章节树、状态与问题徽标、未关联正文；中间只读显示与正文编辑；右栏“写作”容器嵌入现有会话界面；进度卡片、运行期只读；从编辑器发起改写。拆为 [t08](tasks/t08-writing-run-http/README.md)（服务端）与 [t09](tasks/t09-writing-workspace-ui/README.md)（界面） |
| 8 | 验收 | 全部 | 1 到 7 | 浏览器验收、390px 布局、示例项目 smoke；真实模型验收用项目内已配置的 API（2026-09-30 开发者授权） |

切片 3 和 4 互不依赖，可以在切片 1 之后并行。

### 验收反馈

2026-09-30 开发者验收后提出四个问题，讨论后确认：细纲模板按新设计重做（不兼容旧细纲，用户重新生成），其余三项按讨论中的建议实施。授权范围同上。

| 序 | 切片 | 合同 | 依赖 | 内容 |
|---|---|---|---|---|
| 9 | 细纲模板重做 | `outline.writer-handoff`、`writing.collaboration` | 1 到 8 | 细纲正文为“章节总览”加场景一级标题，frontmatter 增加章节人称与逐场景的 `scenes`；结构检查在分析与采用时阻断；写作素材、结构 A 到 C 与助手提示随之调整；大纲表单与生成模板同步 |
| 10 | 细纲正式采用入口 | 大纲库界面 | 9 | 细纲与其他层级一样在顶部操作行提供“正式采用”，先自动分析，无偏差冲突时直接确认 |
| 11 | 文风管理 | `writing.prose-binding`、`writing.workspace-ui` | 8 | 写作视图文风选择处的新增、编辑、删除；用户发起的文风文件增删不受“写作模块不写 lorebook”限制 |
| 12 | 写作会话控件 | `writing.workspace-ui` | 8 | 三个角色的模型、思考档位与温度；每章多个会话的新建、切换与删除 |

2026-10-01 开发者第二轮验收提出两个问题和三条建议，讨论后确认：写作进度加抽屉折叠；写作字数容差放宽到上下 50%，场景边界收紧（允许结尾铺垫，严禁展开下一场景）；助手提示按调用种类分模式载入，并为整章编写模式预留位置但暂不实现；大纲规划 Agent 直接载入模板。

| 序 | 切片 | 合同 | 依赖 | 内容 |
|---|---|---|---|---|
| 13 | 第二轮验收修正 | `writing.collaboration`、`writing.workspace-ui`、`outline.agent-assistance` | 9 到 12 | 进度抽屉与限高；50% 容差与场景边界；助手模式片段与整章模式预留；规划 Agent 载入模板 |

2026-10-01 开发者认为细纲的场景字段卡片混乱、阅读体验差，给出新模板，讨论后确认：细纲写作信息全部写在正文模板里，去掉 frontmatter 的 `scenes`、`perspective`、`guides` 与段落标注；场景增加伏笔（标记、状态、作用、效果）；禁用写法并入只约束情节走向的“禁止事项”；一章只用一份细纲，字数按总览目标上下 50%。旧细纲不兼容，需要重新生成。

| 序 | 切片 | 合同 | 依赖 | 内容 |
|---|---|---|---|---|
| 14 | 细纲模板第三版 | `outline.writer-handoff`、`writing.collaboration`、`outline-entry-templates` | 9 到 13 | 正文模板解析与结构检查共用；细纲编辑界面只留正文、模板插入与问题列表；写作素材、结构 A 到 C 与助手提示按新字段调整；规划 Agent 模板与工具说明同步 |

## 当前状态

- 2026-10-07：[t19](tasks/t19-sequential-scene-planning/README.md) 改为逐场景规划与审核：讨论模式每项经主创及用户确认，自动模式每项经独立审核自动推进，整章规划完成后进入正文写作；检查点保留已确认规划，进度区分待规划、规划中与待写。验证与运行资产同步见 Task。
- 2026-10-04：[t18](tasks/t18-detail-material-review/README.md) 完成新版细纲、按需资料补充与写作前独立审核，提取/规划/解析/写手已接通；来源变更阻止过期写入，旧运行保留并通过新流程续写。相关 Mock 回归、全应用类型检查、资产编译与运行目录检查通过，服务恢复至 3001；真实模型效果待开发者验收。设计见 [Proposal](../../../docs/proposals/writing-detail-material-review.md)。
- 2026-09-29：设计文档完成并经开发者确认；Work 已登记，[t01](tasks/t01-library-based-handoff/README.md) 可以开始。
- 2026-09-29：t01 完成，含经开发者同意的细纲审阅范围收窄；下一片可以从切片 2、3、4 中登记。
- 2026-09-29：[t02](tasks/t02-prose-binding/README.md) 完成：写作设置、正文归属与章节状态、手动关联，以及服务端的正文创建和依据写入；接着做切片 3。
- 2026-09-29：[t03](tasks/t03-writing-materials/README.md) 完成：文风、字数、场景切分与素材、上一章结尾、摘录，以及结构 A 到 D 的校验与渲染（纯函数）；接着做切片 4。
- 2026-09-29：[t04](tasks/t04-issue-store/README.md) 完成：问题记录的按章存储、登记去重、待复核派生、复核与忽略，以及 `GET issues` 和 `POST ignore-issue`；问题的可见范围按写作方案而不是正文归属，与 Spec 原文不同，待开发者确认。切片 2 到 4 已完成，下一片可以登记切片 5。
- 2026-09-29：切片 5 拆为 t05（工作流内核）与 t06（Profile、工具权限与主创工具）。[t05](tasks/t05-writing-workflow-kernel/README.md) 完成：运行记录、整章写作工作流、停止与续写、进程中断恢复，用 Mock 模型验证；接着做 t06。
- 2026-09-29：[t06](tasks/t06-writing-profiles/README.md) 完成：`writing.lead`、`writing.assistant`、`writing.writer` 三个 Profile，主创的状态查询、发起、续写、停止、应答场景规划和读正文工具（运行在后台任务中推进，停下时把报告交回主创），助手限定范围的资料工具；Mock 验证，未做真实模型验收。切片 5 完成，HTTP 接口与进度界面留给切片 7，改写流程留给切片 6。
- 2026-09-30：[t07](tasks/t07-rewrite-flow/README.md) 完成切片 6：局部改写的定位、规划、审阅、新旧对照确认与替换，主创的改写工具；Mock 验证。接着做切片 7。
- 2026-09-30：开发者要求依次完成切片 6 到 8，真实模型验收用项目内已配置的 API。切片 7 拆为 t08（服务端）与 t09（界面）。[t08](tasks/t08-writing-run-http/README.md) 完成：进度投影、HTTP 运行接口（不开放发起）、章节会话，界面上续写与应答后的报告交回本章会话；Mock 验证。接着做 t09。
- 2026-09-30：[t09](tasks/t09-writing-workspace-ui/README.md) 完成切片 7 的界面：左栏大纲视图、中间只读条目与空正文页、右栏写作会话与进度卡片、运行期编辑器只读、右键“改写选中内容”；组件测试与 Mock 验证。切片 7 完成，接着做切片 8 验收。
- 2026-09-30：[t10](tasks/t10-acceptance/README.md) 完成切片 8：浏览器验收（含 390px 与深浅主题）、示例项目 Smoke 与真实模型验收通过，就地修复助手结构提交与停止提示两处缺陷。全部切片完成；四份写作 Spec 维持 planned，状态提升、正常归属正文的界面解除入口待开发者决定。
- 2026-09-30：开发者验收后提出四个问题，登记为切片 9 到 12；[t11](tasks/t11-detail-template/README.md) 开始切片 9。
- 2026-09-30：t11 完成切片 9：细纲新模板（章节总览、场景一级标题与 `scenes` 字段一一对应）及写作模块适配；接着做切片 10（细纲正式采用入口）。
- 2026-09-30：[t12](tasks/t12-detail-adopt-entry/README.md) 完成切片 10：草稿细纲在操作行“正式采用”，先分析，无偏离冲突时直接采用。
- 2026-10-01：[t13](tasks/t13-style-management/README.md) 完成切片 11：写作设置里文风的新增、编辑、删除；开发者授权文风增删由程序写入 `lorebook/instruction/`，不经模型。过程中误把 `server/writing/host.test.ts` 整文件覆盖（目录未入库，无法恢复），已按原范围重建正文创建、关联解除、文风校验、设置非法四组测试。
- 2026-10-01：[t14](tasks/t14-session-controls/README.md) 完成切片 12：本章多会话的切换、新建、删除，三个角色的模型、思考与温度；Profile 的 temperature 配置顺带在 harness 中生效。切片 9 到 12 全部完成，前端由开发者真实测试。
- 2026-10-01：[t15](tasks/t15-acceptance-round2/README.md) 完成切片 13：第二轮验收的两个问题与助手模式拆分、整章模式预留、规划 Agent 模板载入。
- 2026-10-01：[t16](tasks/t16-detail-template-v3/README.md) 完成切片 14：细纲模板第三版。前端与真实模型由开发者测试。
- 2026-10-01：开发者要求把场景字数与整章目标的总和偏离容差从 15% 放宽到 70%。写作字数容差（judgeScene）仍保持 50%。
- 2026-10-04：[t17](tasks/t17-writing-session-ui/README.md) 完成右栏 UI 优化：模型设置移至底部左侧，顶部长会话下拉限制在可收缩列；场景、重试与局部改写的写手思考和正文按需读取，默认折叠。定向测试、类型检查和 Mock 浏览器验收通过；真实模型由开发者后续测试。
