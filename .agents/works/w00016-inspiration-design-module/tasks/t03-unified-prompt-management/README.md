---
schema: nbook.task/v2
taskId: t03-unified-prompt-management
---

# 三模块提示词管理接入

2026-10-04 追加发送顺序优化：开发者要求 system 保持设定的顺序与结构，并核实另两种角色。原实现保留 user/assistant 的相对顺序，但抽离 system 后改变跨角色位置。新 active 快照在用途中持久化 `messageOrder: configured`，哈希纳入此格式；既有快照与 legacy builtin 绑定维持原发送形式。统一渲染保留有序三角色序列；OpenAI Chat Completions / Responses 在正式 Provider onPayload 边界注入原序列，保留后续会话、工具、附件和原回调。不能表达多条或交错 system 的其他接口明确拒绝；其简单前置 system 仍沿用原生协议。

普通 Agent 的准备、RunFrame、TurnSnapshot、压缩后恢复及流式请求已贯通有序序列；写手完整请求不追加旧模板，审阅携带同次原序列；大纲直接调用与新提取/修复同时接入。提取保留配置中的全部消息边界，原文追加一次。可观测记录器改为捕获 onPayload 返回的最终请求体，避免把发送前的草稿载荷当成实际请求。

发送验证：首轮 10 文件中服务、目录、RunFrame、Runtime、大纲、提取修复、Faux 继承与 trace 8 文件通过；发现并修复提取适配器变量重名。提取适配器 5 项通过，新增 Provider 边界 3 项通过（含真实 SDK → 本地 HTTP → trace 原生载荷对比）。完整 Harness 的本地 HTTP 请求验证普通 Agent 首次/续聊以及写手无重复旧模板，2 项通过；提取修复含新序列 4 项通过。应用 typecheck 8GB 重跑通过。接线复核时3001无服务，按标准Source Dev入口恢复3001，migration ready，系统31个Profile重编译0，资产同步更新0；正式API返回200及58个用途，服务保留供验收。本轮无真实模型调用，无真实预设或作品数据写入，无提交或远端操作。布局未改，不扩展浏览器视觉验收。

2026-10-04 追加优化：开发者要求提示词条目右侧新增启用开关；随后明确写手开关独立即时保存，正文仍显式保存，其他 Agent 保持原会话版本。沿用已批准的主工作区例外。本次不实现酒馆宏或预设文件导入。

开关已接入 DTO、预设持久化和统一渲染，停用内容保留但不展开变量、不发送。缺省开关按启用处理，不向旧快照注入默认字段，保留历史哈希。写手即时 toggle 只修改已保存条目的开关并保留其余正文草稿、并发版本和内置保护；新预设和新条目先保存后使用开关。已启用条目必须仍提供用途必需变量。场景正文与局部改写每次写手创建时获取最新配置，同次生成与审阅固定同一快照；主创与助手继续继承旧版本，未接入 managed 提示词的历史流程维持原模板。

追加验证：核心服务、正式视图、配置宿主、真实 Faux Agent 请求及写作 Runtime 5 文件 19 项通过；新增即时写手 Runtime 回归后，Runtime、写作服务和提取请求 3 文件 23 项通过（Runtime 与前组有重叠，不累加）。视图缓存调整后 5 项再通过。应用 typecheck 通过（进程级 8GB）；隔离真实服务与正式组件浏览器检查 14 项通过，390px 内容宽 364px 且无水平溢出。证据在视觉产物目录 `prompt-management-demo/switch-browser-check.json`、`switch-desktop.png`、`switch-narrow.png`。浏览器工具首轮 Bun 因 Vue 编译器缺 TypeScript 解析失败，改 Node/tsx 后成功；脚本曾误点排序手柄，修正展开选择器后通过。未调用真实模型，未修改真实全局预设或小说数据。

验收结束已停止隔离3013服务并清理它创建的两个临时 State Root。接线复核发现3000与用户当前3001均无服务，按标准入口 `NUXT_PORT=3001 bun run --cwd packages/neuro-book dev` 恢复3001，migration ready，31个Profile重编译0，用户资产同步更新0。正式API GET返回200、58用途；真实配置中心只读走查显示局部改写的两个开关、内置均只读、无运行错误。证据 `prompt-management-demo/actual-switch-check.json` 与 `actual-switch-builtin.png`。3001服务保留运行供开发者验收。

2026-10-04 开发者已测试配置中心 Demo，要求内置默认提示词方案不可修改/删除，并授权正式接入。合同见 [prompt-management](../../../../../docs/specs/ui/prompt-management.md)，设计取舍见 [Proposal](../../../../../docs/proposals/unified-prompt-management.md)。沿用本 Work 已批准的主工作区例外，依赖设计、提取、规划与写作的既有未提交实现；不覆盖用户数据，不提交或执行远端写入，不调用真实模型。

已完成正式源码接入：全局用途目录、预设持久化、内置保护、不可变提示词快照及会话/任务继承；配置中心接线和提取、规划、写作调用用途共 58 项（含两项既有整章助手预留阶段）。主 Agent 拥有共享 DTO、核心版本服务、写作模板和统一验收；按 leader 技能将 UI、Agent Runtime 和直接提取调用分派给独立切片。独立集成审查发现并修复 fork 源版本继承、归档主创后的续写继承、旧工作流审阅参数保持原形三处接缝。

完成依据已验证：保存/删除内置遭服务端拒绝；复制自定义能保存，未保存离开丢弃；实际请求包含配置角色及顺序；旧会话和任务恢复、后续专家保持固定版本；新会话使用最新全局选项。直接合同测试、应用类型检查及真实组件隔离浏览器走查已完成。真实模型输出质量不在本轮验收范围。

2026-10-04 证据：流程切片 114 项、Agent Runtime 切片 43 项、UI 切片 9 项定向回归通过；主 Agent 的核心服务/写作/Profile 定向 5 文件 48 项通过，新增写手实际审阅回归后 3 文件 26 项通过，归档写作宿主 1 项通过，fork 6 次真实 Faux 请求集成测试通过。各组有重叠，不将它们累加为全仓测试数。应用 `typecheck` 通过（默认 Node 4GB 首次内存不足，进程级 8GB 重跑成功）；独立 server 检查仍存在原有测试类型诊断，本次相关源文件无新增诊断。`system-assets:prepare` 成功，30 个 Profile 中重编译 1 个陈旧资产。全仓测试及真实 Provider 未执行。

正式组件连接真实服务、独立临时 State Root 的浏览器走查 21 项通过：内置全项只读、复制、角色选择、左键拖动、原子保存、刷新恢复、分类切换丢弃、删除回退、服务端 403、长文本与 390px 下操作可达，无运行错误。桌面窗口面积 0.6724；窄屏窗口 366px，内容水平溢出 0。报告位于显式视觉产物目录的 `prompt-management-demo/integrated-browser-check.json`；隔离服务的临时数据退出后清理。原 3012 Demo 同步只读保护，但正式入口在项目配置中心。Spec 保持 planned 等待开发者验收。

文档检查仅有三份既有 outline 笔记缺 frontmatter 失败，本次 Spec、Proposal、组件与 Task 登记无新增失败。未提交 Git，未发布、未改用户作品或真实全局预设。

实际 Source Dev 服务接线复核：新增模块后旧 Nitro 解析缓存曾返回 extensionless service ENOENT；配置重载又停在 Restarting Nuxt。核实进程身份和标准入口后，仅重启旧 Nuxt 进程并从 `bun run --cwd packages/neuro-book dev` 恢复服务。migration check ready，安装根 31 个 Profile 重编译 1 个，投影同步 updated profiles/assets 均为 0。恢复后的真实 `http://127.0.0.1:3000/api/prompt-management` GET 返回 200、58 个用途；未向真实预设 POST 或发起模型请求。开发服务保留运行供用户验收。

真实主页面浏览器已走“配置中心 → 提示词管理 → 角色人设设计师 → 查看”：58 个用途正常展示，内置正文 readOnly=true、保存预设 disabled=true，无页面运行错误。证据为视觉产物目录的 `actual-project-check.json` 与 `actual-project-builtin.png`。初次以 networkidle 等待被持续后台请求拖到超时，改以实际页面控件就绪验证成功，未据等待超时修改业务代码。
