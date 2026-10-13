---
schema: nbook.work/v1
workId: w00018-outline-planning-module
issueId: null
---

# 大纲规划模块落地

## 目标与授权

本 Work 承接开发者在 2026-09-24 明确提出的请求：根据已确认的大纲规划模块设计，正式建立可执行的开发计划、行为合同和分阶段落地路径，为后续实现做准备。

2026-09-26，开发者授权：回退对现有 `writer` 的改造、删除迁移功能、恢复《新小说编写计划》原文、将原始设计的三个规划 Agent 作为模块主 Agent 的子 Agent 实装，并把原始设计补充并入 Proposal。

本轮授权覆盖：将 `docs/proposals/outline-planning-module.md` 整理为 accepted Proposal；建立 `planned` 行为 Spec；调查现有 Plot、Project Workspace、文件历史、Agent 会话和 `writer.pro` 的所有权边界；编写实施计划、依赖关系、迁移策略、验证门禁和后续 Task 入口。2026-09-24 起，开发者进一步授权 t03 Phase 1 存储基础代码与合同测试。后续持续目标明确要求 Phase 1 后按照实施计划继续开发其余阶段；Phase 2 的 t04 保持未完成；已启动 t05 Phase 3 的伏笔存储与派生工作，后续阶段按验收与依赖推进。过去仅针对 Phase 1 的 UI/Agent/迁移限制不视为整个 Work 的完成范围缩减；提交和远端写入仍须单独授权。

当前未执行且不自动授权：创建实现 worktree、调用需付费或用户凭据的真实模型、使用真实用户数据验收、删除或覆盖已有文件、重置工作区、暂存无关改动、提交、推送、创建 PR 或其他远端写入。后续计划中的数据迁移须按预览与确认合同实施，不得以当前许可擅自覆盖用户作品。

## 当前范围

大纲库、细纲、伏笔库、伏笔标记解析、线路规划、模块 Agent、`writer.pro` 单向交接和全屏工作台 UI 的合同与实施顺序。大纲库承载灵感与可复用方案，线路规划中的固定节点才是正文使用入口。

## 当前状态

- 2026-10-03 开发者授权规划 Agent 的素材运用与改编优化，交由 [t12](tasks/t12-material-use-and-adaptation/README.md) 在现有主工作区实施。文档与代码已完成，领域、真实工具/HTTP、Profile 与组件定向回归通过，运行 Profile 资产已编译；浏览器与真实模型验收未完成，具体限制见 Task。此前不自动授权的范围以本次明确修改与本地验证授权为准，真实模型、用户数据写入、提交和远端操作仍未授权。

- **2026-09-26 线路规划重做**：开发者指出线路规划与设计预期偏差很大，确认改为方案级共享节点图加横向分格，旧线路文件直接废弃。t11 接手，取代 t06 的线路数据模型与领域操作，详见 [t11](tasks/t11-line-graph-redesign/README.md)。
- **2026-09-26 纠偏**：开发者指出此前开发误把《新小说编写计划》原始设计当作已开发模块。本模块只替换其中的大纲与细纲部分和伏笔部分，其余部分仍按原始设计开发。本次按开发者决定：
  - 三个原始规划 Agent 作为模块主 Agent 的只读专用子 Agent 实装（t07）；
  - 原始设计补充并入 Proposal 与 Spec；
  - 回退对现有 `writer` 的改造（t09），删除迁移功能（t10），恢复《新小说编写计划》原文。

  对照与依据见 [original-design-reconciliation.md](original-design-reconciliation.md)。下文 2026-09-25 及更早的 writer Profile、`--fixed-outline` 和迁移相关记录均已作废，只作历史保留。
- 2026-09-26 原始设计补充的 schema 扩展（一.2）已完成：条目与伏笔 schema v2、结构化参考文件与待补告警、细纲场景写作指导、伏笔设计分项和已过章节数，详见 t07 的 Schema 扩展节。工作台编辑能力（一.1）随后按 [workbench-editing-todo.md](workbench-editing-todo.md) 进行。
- 2026-09-26 工作台编辑能力（一.1）前端界面已完成：大纲库、细纲分析采用、伏笔库与标记插入、线路规划均复用现有领域操作，不新增端点；实际落点与未完成项见 [workbench-editing-todo.md](workbench-editing-todo.md) 的实现记录与 t08。大纲前端 8 文件 30 项（含工作台合同 3 项）、应用 typecheck 和 docs:check（6578 文件、0 失败）通过；浏览器与真实模型分析未验证。已按 v1 采用的开发细纲需重新保存并分析。
- Proposal 已 accepted，Phase 0 的领域映射、规范文件所有权与 ADR 0022 已完成；Phase 1 t03 的规划存储基础于 2026-09-24 完成，证据见 Task 快照。
- `packages/neuro-book/server/outline/` 已具备规范文件 schema/校验、稳定 ID、写时分叉、SQLite 可重建投影、ready Project generation/CAS、事务 journal/回滚与撤销、对象与关系分别预览和删除、总纲二次确认、Project History 记账；HTTP 数据面已接入。真实 Project 关闭/重开、索引丢失重建及跨 generation 撤销已通过聚焦测试。
- Phase 1 schema 收尾补全规划条目的素材引用、写作指导、参考文件及篇幅字段，拒绝越界引用与非法篇幅；并在规范快照处校验 entry 与方案 placement 的父级类型以及细纲章节关联，拒绝无效批次部分写盘。大纲模块聚焦验证 9 文件 59 项、应用 `typecheck` 通过；`docs:check` 通过（检查 6504 个文档文件，0 项失败）。全包默认测试此前受 Windows 沙盒的 Agent fixture symlink `EPERM` 阻断，未重跑；浏览器和运行中 HTTP 手工验收未执行。
- 对 Phase 1 当前工作树复验：聚焦测试最新 9 文件 62 项、应用 `typecheck` 和 `docs:check`（6504 文件，0 失败）均通过；原始发布入口拒绝绕过条目与方案关系的领域操作，ready Project 回归验证拒绝编辑后文件保持不变；无已知待开发的 Phase 1 剩余项。此前的 59 项为旧快照；全包默认测试、运行中 HTTP/浏览器人工验收未执行。
- Phase 2 已有方案树、草稿领域操作、非细纲正式采用、跨方案共享分叉与素材元数据、跨父级 `move-entry`。本轮进一步接通 Pi 后端简单方向生成，只返回可审阅草案，真实模型未调用；聚焦测试 11 文件 69 项、应用 `typecheck` 通过。细纲的独立 AI 分析请求、当前 ready generation 报告签发与确认采用入口已落地；报告随正式条目写入规范文件并进入 History。相关方案变更会同事务撤回依赖旧报告的正式细纲并解固定受影响线路；跨方案共享、关闭重开和异常恢复仍需回归，Phase 2 未完成，Spec 保持 `planned`。详情见 t04。
- 2026-09-24 对当前包含 Phase 2 进行中改动的工作树复核 Phase 1：无新缺口；大纲聚焦测试 12 文件 75 项、应用 typecheck 和 docs:check（6512 文件、0 失败）通过。该计数包含 Phase 2 回归，不视为 Phase 2 完成证据；未进行全包、运行中 HTTP/浏览器或真实模型验收。
- Phase 2 补强：细纲撤回或直接编辑后解固定所属章节线路，未受影响方案保持原状；模拟 ready 会话隔离与事务故障恢复可观测。大纲聚焦测试 12 文件 78 项、应用 typecheck 通过；真实 Project 关闭重开现已在 t04 真实生命周期回归覆盖。
- 2026-09-24 Phase 2 继续：共享细纲分叉不再将原分析报告带入新草稿；真实 Project 跨方案分叉、关闭重开和跨 generation 撤销已有回归。大纲聚焦测试 12 文件 81 项（限制 Vitest worker 为 2）、应用 typecheck 通过；并行运行曾出现 worker 意外退出，串行重跑通过；运行中 HTTP/浏览器、全包测试及真实模型仍未验证。
- Phase 2 跨方案挂载回归：修复已采用细纲挂到新方案时的分析报告漏撤回与章节线路未解固定；真实 Project 关闭重开仍保持草稿与两个方案关系。大纲聚焦测试 12 文件 83 项、应用 `typecheck` 通过；Phase 2 未完成，未执行全包/运行中 HTTP/浏览器或真实模型验收，详见 t04。
- Phase 2 细纲报告时效补强：将持久报告上下文摘要限于所属方案及所引用规范条目的版本/hash，防止无关方案变化导致误判；签发报告单独绑定 manifest revision 保持正式采用的 CAS。大纲聚焦测试 12 文件 84 项、应用 `typecheck` 通过；Phase 2 仍在进行，其他验收门禁见 t04。
- 2026-09-25 Phase 1 交付复核：t03 的存储、事务、恢复、索引重建与影响预览无已知待开发项；本轮大纲聚焦测试 12 文件 85 项、应用 `typecheck` 和 `docs:check`（6512 文件、0 失败）通过。计数包含 Phase 2 新增的真实 Project 跨父级移动回归；Phase 2 仍在进行，默认全包、运行中 HTTP/浏览器及真实模型验收尚未执行，详见 t04。
- Phase 2 方案链删除补强：预览显示专属条目及固定线路阻断影响，带 revision 确认只删除方案关系、保留条目文件；真实 ready Project 覆盖 History 归因、关闭重开及跨 generation 撤销，正式细纲 History 归因增加真实时间线断言。大纲聚焦测试 12 文件 88 项及应用 `typecheck` 通过；Phase 2 尚未完成，完整验收边界见 t04。
- Phase 2 继续：补齐方案链改名领域及 HTTP 请求、ready Project History/关闭重开/撤销，并收窄共享细纲报告的自动撤回作用域，避免无关方案改名撤回其他方案的有效报告；新挂载仍撤回。大纲聚焦测试 12 文件 88 项、应用 `typecheck` 通过；全包、运行中 HTTP/浏览器与真实模型尚未验证，详见 t04。
- Phase 2 增加真实 H3 TCP/Project 路由链路回归：草稿、正式采用、细纲分析确认、关闭重开与时效错误贯通；模型响应仍使用 mock，未覆盖完整 Nuxt、浏览器或真实模型。大纲聚焦测试 13 文件 89 项、应用 `typecheck` 通过，默认全包测试未执行，详见 t04。
- Phase 2 关系删除补齐固定线路最后挂载阻断：预览显示影响，提交复验；共享章节仍有其他方案挂载时允许解除当前关系。真实 ready Project 关闭重开回归先 RED 后 GREEN；大纲聚焦测试 13 文件 90 项与应用 typecheck 通过，未执行默认全包、完整 Nuxt/浏览器或真实模型验收，详见 t04。
- Phase 3 t05 进展：伏笔定义草稿／确认的 ready Project 事务与 HTTP 入口、固定线路四状态及来源异常派生已实现；真实 H3 创建、确认、关闭重开与过期请求回归通过。只读按章隔离损坏标记并返回诊断，严格读取与发布继续 fail-closed；真实规范文件回归覆盖其他章节来源不丢失及 hash/front matter 损坏整体拒绝。最新大纲聚焦测试 14 文件 101 项、应用 typecheck 和 docs:check（6516 文件、0 失败）通过；默认全包、完整 Nuxt／浏览器和真实模型仍未验收，详见 t05。Agent 审批与 UI 仍未完成，详见 t05。
- Phase 4 t06 已启动：通用文件发布入口阻止绕过线路固定与复核，保留草稿及同字节改名；真实 ready Project 回归验证拒绝后字节不变，修正旧生命周期测试夹具。大纲聚焦测试 14 文件 103 项、应用 typecheck 通过。完整线路领域操作、方案作用域、AI 分析、UI 与正文交接仍未完成，详见 t06。
- 2026-09-25 复核 Phase 1 无已知剩余开发项；继续 Phase 4 的方案归属切片：v2 线路绑定方案，v1 保留可读但不推断方案；规范快照拒绝未知方案及跨方案节点，按方案判断主线和固定重复。聚焦测试 14 文件 106 项、应用 typecheck、docs:check（6517 文件、0 失败）通过；Phase 4 的业务操作、分析及全链路验收尚未完成。
- Phase 4 继续：草稿线路领域操作已实现创建、编辑、加节点与连边；删除节点／边采用独立预览、依赖边影响摘要和显式版本确认，通用文件入口不能绕过草稿改写。v2 固定线路校验非空和连续可达，v1 旧文件保持可读。真实 Project 与 H3 回归覆盖 History、重开、CAS、撤销；聚焦测试 15 文件 114 项及应用 typecheck 通过。固定业务入口及语义冲突分析仍未完成，详见 t06。
- 主工作区存在其他任务的修改，继续保护；本阶段没有修改 Plot/Prisma schema、作品数据或正文，没有真实模型调用，也没有提交与远端写入。

- Phase 4 增加从规范快照判定固定线路的红／黄失效及只读有效节点门禁；旧 v1 与任何失效节点均被整体拒绝。聚焦测试 16 文件 122 项、typecheck 和 docs:check（6521 文件、0 失败）通过；尚未接入正文 Agent，重新分析／重新固定仍未实现，Phase 4 和整个模块未完成。

- Phase 4 继续接通固定线路失效查询与只读节点 CAS、确认撤回后重新分析／重新固定；旧 v1 线路可明确选方案升级为 v2 草稿，不继承历史固定资格，保留 ID 和节点，并支持事务撤销；查询新增同方案重复节点标注。聚焦大纲测试 16 文件 128 项、应用 typecheck 和 docs:check（6521 文件、0 失败）通过；真实 HTTP、浏览器、默认全包及 `writer.pro` 接线仍未验收。

- 2026-09-25 复核 Phase 1：实施计划和 t03 的存储基础交付均已有实现与回归，无待补产品代码。本次包含后续阶段改动的聚焦测试在 `--maxWorkers=1` 下 16 文件、129 项通过，应用 typecheck 通过；`--maxWorkers=2` 首轮 worker 意外退出，未算通过。Phase 4 新增真实 TCP/H3 ready Project 合同回归（4 项），不等于完整 Nuxt／浏览器验收；Phase 2–8、`writer.pro` 接线、默认全包测试及真实模型验收仍未完成。

- Phase 4 只读线路检查已能对外部删除的 manifest 条目文件返回红色节点，并将其余节点标为待重新审查；严格写入与正文读取仍拒绝该快照，其他文件损坏继续 fail-closed。真实 ready Project 与 TCP/H3 回归覆盖该行为，聚焦测试 16 文件、129 项和应用 typecheck 通过；外部文件丢失后的重新关联/修复流程与后续阶段仍待实现。

- Phase 1 诊断校验收尾：丢失条目只在只读线路检查中豁免该对象的直接依赖关系，仍拒绝重复方案、其他结构损坏和 manifest 文件路径别名；正常快照与写入保持 fail-closed。新增格式及 ready Project 回归。大纲聚焦测试分两组 8+8 文件，82+48 项通过，应用 typecheck 与 docs:check（6521 文件、0 失败）通过；单命令全模块两次因 worker 意外退出未通过，未把部分执行记为全通过。Phase 2–8、默认全包与浏览器/真实模型验收仍未完成。

- Phase 4 草稿节点已支持同方案条目的领域重新关联，并保留图节点身份、顺序、边和布局；旧分析强制失效。ready Project 与 HTTP 聚焦测试 2 文件 18 项、应用 typecheck、docs:check（6521 文件、0 失败）通过。外部删除条目文件导致的红色节点修复仍需要受限事务入口，不能由普通重新关联绕过严格快照；Phase 2–8 未完成。

- Phase 1 本轮交付复验未发现待补产品代码：大纲聚焦测试 16 文件、132 项通过（包含后续阶段测试），应用 typecheck 通过，docs:check 检查 6522 文件、0 失败；未执行默认全包、完整 Nuxt/浏览器或真实模型验收。Phase 4 的丢失条目修复只有未接线的领域准备代码，不宣称可用；Phase 2–8 和整个 Work 仍未完成。

- 2026-09-25 Phase 4 红色节点受限修复已接通 ready Project 与真实 TCP/H3；外部文件恢复时事务前提失效会拒绝发布、回滚且不覆盖恢复文件，修复还会撤回所属方案其他固定线路旧报告。聚焦测试 17 文件 138 项与应用 typecheck 通过；完整 Nuxt/浏览器、默认全包、writer.pro 接线及其他阶段仍未完成，详见 t06。

- 2026-09-25 Phase 4 新增同方案主线确认式切换：旧主线如已固定则撤回资格，两条线路的分析报告失效并原子发布；真实 TCP/H3 补齐红色缺失引用修复后重新采用、分析、固定、重开与正文只读闭环。聚焦测试 17 文件 142 项、应用 typecheck 和 docs:check（6523 文件、0 失败）通过；Phase 1 仍已完成，Phase 2–8 和整个 Work 仍进行中。完整 Nuxt／浏览器、默认全包、真实模型与 `writer.pro` 接线未验收，详情见 t06。

- 2026-09-25 复核 Phase 1 实施清单，存储基础无待开发项；正在实施的 Phase 4 补齐主线／IF 线节点单出边结构门禁，修正回归导入后大纲聚焦测试 17 文件、143 项和应用 typecheck 均通过。Phase 2–8 仍未完成；默认全包、完整 Nuxt／浏览器及真实模型均未验收。详情见 t03、t06。

- 2026-09-25 Phase 4 历史固定 v1 分叉 YAML 的读取兼容性已补回：旧文件可恢复但不能用于正文，v2 仍阻断违规分叉。全模块 17 文件／145 项分两批（88+57 项）通过，应用 typecheck 通过；首次单批全组因 Vitest worker 意外退出而非通过。旧版违规分叉的用户确认式升级、完整 Nuxt／浏览器与后续阶段仍未完成，详情见 t06。

- Phase 7 补强：writer Profile 移除 bash，文件工具服务端拒绝 writer 直接访问规划、跨 Project 读写及非正文 Markdown 修改；真实路径、硬链接和混合补丁回归通过。大纲及文件权限聚焦 20 文件／210 项在单 worker 下通过，应用 typecheck 和 docs:check（6527 文件、0 失败）通过；双 worker 复跑曾意外退出，不计入通过；规划只读查询尚未接入 writer，Phase 7 与模块整体仍未完成。详情见 t09。

- 2026-09-25 再核 Phase 1 无待开发项；Phase 7 将 writer Profile 接入固定线路只读工具，payload 可选传入完整版本锚点，服务端仍拒绝原始规划文件读取。聚焦测试 21 文件／213 项、应用 typecheck、docs:check（6529 文件，0 失败）通过；Profile 运行时 fixture 因 Windows symlink EPERM 未验证。调用方锚点、素材文件内容与端到端验收尚缺，Phase 7 及整个 Work 未完成，见 t09。

- 2026-09-25 应开发者要求复核 Phase 1 剩余项：t03 的八项交付均已有实现，本次无需重复开发；六文件聚焦测试在显式 20 秒测试超时下 82/82 通过，应用 typecheck 通过，docs:check（6530 文件、0 失败）通过。默认 5 秒测试超时下的 Phase 2 生命周期用例曾超时，详见 t03；Phase 2–8 与整个模块仍未完成。

- 2026-09-25 Phase 6 开始实现：新增 Project 作用域的工作台 Storage 定义与会话、新增三 API 只读数据 composable、全屏左右分栏 `OutlineWorkbenchDialog`，并接入页面和活动栏。工作台限制 Agent 区不超过窗口中线，布局按 Project 保存；视图只消费服务端返回的库树、伏笔状态和线路 DTO。应用 typecheck、活动栏聚焦测试（4 项）和工作台合同测试（2 项）通过；浏览器验收、Storage 会话完整行为测试、真实规划 Agent 流式/审批接线尚未完成，Phase 6 保持进行中，详见 t08。
## 当前 Task

- [t01-contract-and-architecture-plan](tasks/t01-contract-and-architecture-plan/README.md)：已完成 Proposal、planned Specs、ADR 0022、实施计划和文档验证。
- [t02-domain-mapping-and-persistence-decision](tasks/t02-domain-mapping-and-persistence-decision/README.md)：已完成领域映射、schema、文件事务/恢复和 Plot 只读交接边界；证据见 Task 快照。`bun run docs:check` 已通过。

- 2026-09-25 Phase 1 再复验无剩余项：当时大纲测试 18 文件／157 项、应用 typecheck 与 docs:check（6526 文件、0 失败）通过。继续 Phase 7 只读交接，增加当前固定线路的有效伏笔定义及来源，排除草稿定义和无前置埋设的回收；最终聚焦测试 18 文件／158 项、应用 typecheck 与 docs:check（6526 文件、0 失败）通过。`writer.pro` 工具权限及素材文件实际读取仍未接线，Phase 2–8 与整个 Work 未完成。
- [t03-planning-storage-foundation](tasks/t03-planning-storage-foundation/README.md)：Phase 1 规划存储基础完成；实现、验证证据和未验证边界见 Task 快照。
- [t04-outline-library-and-detailed-outline](tasks/t04-outline-library-and-detailed-outline/README.md)：Phase 2 实施中；细纲分析与采用、跨方案作用域及异常事务已有聚焦回归，真实关闭重开已有回归，运行中验收仍待完成。
- [t05-foreshadowing-parser-and-derived-state](tasks/t05-foreshadowing-parser-and-derived-state/README.md)：Phase 3 产品代码已收尾；损坏章节专用 repair 事务、Agent 建议审批、TipTap 标记编辑器和工作台异常展示已有实现与聚焦回归，浏览器、默认全包、Profile 运行时和真实模型验收仍待完成。
- [t06-line-planning-and-conflict-gates](tasks/t06-line-planning-and-conflict-gates/README.md)：线路数据模型与领域操作已被 t11 取代；草稿图、删除预览、结构门禁、语义分析／固定审批和只读失效判定已有回归，正文接线及运行中验收仍待完成。
- [t07-outline-agent-approval-and-streaming](tasks/t07-outline-agent-approval-and-streaming/README.md)：Phase 5 Agent 工具、审批、审计、事件流、取消和迟到隔离已有实现与 faux Session 黑盒回归；Profile 运行时、浏览器、默认全包和真实模型验收仍待完成。
- [t08-outline-workbench-ui](tasks/t08-outline-workbench-ui/README.md)：Phase 6 已接入全屏工作台、Project 布局持久化、三只读视图和真实规划 Agent Session/SSE/审批容器；浏览器尺寸与运行时 fixture 验收仍待完成。
- [t09-writer-pro-handoff](tasks/t09-writer-pro-handoff/README.md)：Phase 7 规划侧固定线路只读投影与素材按需读取仍有效，伏笔来源不再携带定义正文；2026-09-26 已回退对现有 `writer` 的改造，`writer.pro` 待按原始设计另行开发。
- [t10-migration-acceptance-and-release](tasks/t10-migration-acceptance-and-release/README.md)：2026-09-26 撤销并删除旧文档迁移功能；Phase 8 只保留验收与发布准备，尚未开始。
- [t11-line-graph-redesign](tasks/t11-line-graph-redesign/README.md)：2026-09-26 线路规划重做，P0 文档完成，代码实施中。

- 2026-09-25 最新收口证据：大纲聚焦配置单 worker 25 个测试文件、239 项通过，应用 typecheck 与 docs:check（6558 个文档文件、0 失败）通过；测试中的 HTTP schema 拒绝、History 故障注入和 Windows 临时 SQLite 告警均为预期或环境告警，不影响断言通过。
- 2026-09-25 Phase 7 调用方锚点已接通：写作 workflow smoke 增加 `--fixed-outline` 与 `REAL_MODEL_SMOKE_FIXED_OUTLINE`，新增脚本合同 3 项通过；素材读取和来源审计已有真实 H3／工具回归。
- 2026-09-25 Phase 3 损坏标记 repair 已接通：专用预览／提交、严格候选解析、CAS、事务／History／generation 门禁和 Agent action 均已有回归；浏览器、默认全包、Profile 运行时和真实模型仍未执行。
- 2026-09-25 Phase 8 代码级收口：迁移 HTTP 合同由 11 项增至 14 项，补齐中断 journal 重开恢复、symlink/junction 源拒绝、旧 generation apply 隔离及重开后 rollback；migration Spec 仍因默认全包、运行中长请求并发、浏览器和正式发布包门禁保持 `planned`。

## 完成条件

1. Proposal 明确标记为 accepted，并保留未决实施决策清单。
2. 所有首期能力均有唯一 `planned` Spec 和 `docs/specs/README.md` 登记。
3. 实施计划包含阶段、依赖、交付物、验收门禁、迁移和回滚策略。
4. `bun run docs:check` 通过；未运行的代码、模型调用和浏览器门禁明确标记为未验证。
5. t02 已完成后续实现所需的数据所有权与持久化决策；t03 只负责规划存储基础，不提前实现 UI、Agent 全流程、迁移或 Plot 双写。

## 来源

- [大纲规划模块 Proposal](../../../docs/proposals/outline-planning-module.md)
- [现有 Plot Reference](../../../packages/neuro-book/assets/reference/plot/README.md)
- [Spec 流水线](../../../docs/specs/README.md)
- [测试与验收门禁](../../../docs/testing/README.md)










