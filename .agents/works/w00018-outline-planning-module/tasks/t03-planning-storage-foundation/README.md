---
schema: nbook.task/v2
taskId: t03-planning-storage-foundation
---

# 规划存储基础

## 目标与范围

本 Task 执行大纲规划模块 Phase 1：建立结构化规划文件的确定性 schema、解析/校验、稳定 ID、版本/hash、规范文件仓储、跨文件事务基础、恢复 journal、索引重建入口、影响预览和规划域批次撤销基础。

本 Task 只实现规划存储基础，不实现大纲库 UI、线路节点图 UI、完整 Agent 工作流、模型调用、旧《新小说编写计划》迁移、Plot 双写或正文写入。

## 完成快照（2026-09-24）

Phase 1 规划存储基础已落地：

- `format.ts` 实现 manifest/Markdown/YAML 解析、确定性校验、稳定 ID、内容 hash、伏笔标记及线路结构检查；`fork.ts` 提供共享条目写时分叉。
- `repository.ts` 与 `index.ts` 从规范文件重建完整快照，校验 manifest 引用、对象版本与 revision CAS；`planning-index.ts` 将规范快照投影到可删除重建的 Project SQLite，索引不反写规范文件。
- `transaction.ts` 提供文件 hash 与 Project generation CAS、多文件 staging/journal/故障恢复、部分发布回滚及冲突式批次撤销；拒绝损坏 journal、未完成事务和事务产物链接逃逸。关闭重开后允许当前 ready generation 在全部文件 CAS 成立时撤销旧批次，但拒绝旧 ready 继续操作。
- `operations.ts` 区分对象删除与方案 placement 关系删除的影响预览、确认和独立结果，总纲删除另需二次确认；`host.ts` 在 Project file-index mutation gate 内执行并记入 Project History，提交后索引/历史失败遵循已有 fail-open 与后续对账合同。
- `packages/neuro-book/server/api/projects/outline/[...segments].ts` 暴露打开、快照、发布、影响预览、确认删除和撤销的数据面入口；不包含工作台 UI 与 Agent 审批层。

实际验证：

- `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：8 个文件、47 项通过。包含真实 Project 关闭/重开、旧 generation 拒绝、SQLite 删除重建、跨 generation 撤销、总纲二次确认、关系删除不删对象、外部编辑、故障注入和链接逃逸。测试中的 History/SQLite 错误告警为主动注入的提交后降级场景。
- `bun run --cwd packages/neuro-book typecheck`：通过。
- `bun run docs:check`：通过，检查 6502 个文档文件、0 项失败。

证据边界：聚焦配置隔离了默认 Vitest Agent 全局 fixture；默认全包 Vitest 此前在当前 Windows 沙盒受 symlink `EPERM` 阻断，本轮未重跑，**没有**宣称全包通过。HTTP 路由有模拟事件的合同测试，尚未执行浏览器或运行中服务器 HTTP 手工验收。History 的实际 Project lifecycle 已经过宿主入口，单个写/删/改名调用及提交后故障由聚焦测试覆盖，但未单独进行「进程在规范文件 commit 与 History 归因之间崩溃」的真实进程注入；缺账由现有 watcher reconcile 以 external 对账，不保留原操作者归因。UI、Agent、真实模型、Plot 适配、旧文件导入和正文交接属于后续 Phase，相关 Spec 继续保持 `planned`，不提前宣称整个模块已实现。

## Phase 1 schema 收尾复验

- 补齐条目 front matter 的 `materialRefs`、`writingGuidance`、`referenceFiles`、`targetWords` 可选字段；草稿和旧文件不必补写新字段，往返读取保持字段原值。文件引用拒绝绝对路径、`..`、反斜杠及非法字符，篇幅要求必须为正整数。Workspace 实际读取仍由其自身 containment 与链接检查负责。
- 扩展格式回归和规范文件快照往返测试；大纲模块聚焦测试 9 文件 54 项通过，应用 typecheck 通过；`docs:check` 通过（6504 个文档文件，0 项失败）。历史/索引降级警告是主动故障注入，不代表测试失败。
- Phase 2 的方案树与草稿操作已有部分代码，正式采用分析等仍未完成；不将它们算作 Phase 1 完成证据，也不晋升 `planned` Spec。全包测试、运行中 HTTP/浏览器和真实模型均未执行。

## Phase 1 补强与复验

- 标记解析现在对未闭合的伏笔注释和交叉嵌套 fail-closed，普通注释不受影响；方案 placement 和 entry parentId 分别拒绝循环层级。回归测试先复现了缺口。
- 聚焦测试 8 文件 49 项通过，应用 typecheck 与 docs:check 通过（文档检查 6502 文件，0 失败）。History/SQLite 告警来自故障注入。
- 默认全包测试、运行中 HTTP/浏览器及真实模型未执行，后续 Phase 和相关 planned Spec 不提前宣称完成。

## Phase 1 规范层级校验收尾

- 按现有领域创建合同统一校验规范文件 entry parent、方案 placement 父级类型与细纲 chapterId/parentId 一致性；保留总纲直属章节的既有能力，异常快照 fail-closed，无效批次不能部分落盘。
- 回归测试覆盖非法关系及拒绝写盘；大纲聚焦测试 9 文件 59 项、应用 typecheck、文档检查（6504 文件，0 失败）均通过。聚焦测试的 History/SQLite 告警为主动故障注入；全包默认测试、运行中 HTTP/浏览器验收和真实模型未执行，不纳入 Phase 1 的完成声称。
- Phase 1 存储与领域服务合同已收尾；Phase 2 的正式采用分析、后续 UI/Agent/正文交接与旧文档迁移仍未完成，相关完整能力 Spec 保持 planned。

## Phase 1 当前复验

- 按既定 Phase 1 门禁复核规范文件、事务、Project lifecycle 与现有回归；未发现尚需补写的 Phase 1 合同或代码。`bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：9 文件、61 项通过；`bun run --cwd packages/neuro-book typecheck`：通过；`bun run docs:check`：检查 6504 文件，0 失败。
- 聚焦测试中的 History 不可用及 SQLite 连接告警来自主动故障注入。未执行默认全包测试、运行中 HTTP/浏览器验收和真实模型调用；这些不冒充 Phase 1 的通过证据。已有 Phase 2 代码尚未完成完整功能，不计入 Phase 1。

## Phase 1 交付复核

- 复核 Phase 1 的 schema/解析、稳定 ID、关系与写时分叉基础、伏笔标记解析、线路结构校验、Project CAS、多文件 journal/恢复、索引重建及删除影响预览/批次撤销；本轮未发现尚需补写的 Phase 1 功能。补充核对原始发布入口：它拒绝绕过领域操作创建或修改大纲条目、改变方案链和直接删除；受信的领域操作仍能提交，真实 ready Project 测试验证被拒绝的原始编辑不会改动文件。细纲 AI 分析与正式采用是 Phase 2 门禁，不把原始发布拒绝误记为该能力已完成。
- 本次重新运行 `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：9 文件、62 项通过；`bun run --cwd packages/neuro-book typecheck`：通过；`bun run docs:check`：检查 6504 文件、0 失败。History/SQLite 告警来自聚焦测试主动故障注入。
- 默认全包测试、运行中 HTTP/浏览器及真实模型仍未执行；Phase 2–8 未完成，完整能力 Spec 保持 `planned`。本轮未提交、推送或修改其他任务文件。

## Phase 1 最新完成状态复核

- 对照实施计划 Phase 1 门禁、本 Task 必须交付和合同测试场景，未发现尚未实现的 Phase 1 存储基础项；本次不修改产品代码，后续阶段不计入 Phase 1 剩余工作。
- 当前包含后续阶段进行中改动的工作树运行 `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：15 文件、114 项通过；`bun run --cwd packages/neuro-book typecheck`：通过；`bun run docs:check`：检查 6519 个文档文件，0 失败。114 项是整个大纲模块聚焦测试总数，非 Phase 1 专项计数；History/SQLite 与请求校验告警对应故障注入或拒绝场景。
- 默认全包测试、运行中 HTTP/浏览器人工验收与真实模型调用未执行；后续阶段仍在开发，完整能力 Spec 保持 `planned`，不把 Phase 1 完成等同于整个模块完成。

## 2026-09-25 Phase 1 完成复核

- 逐项核对实施计划 Phase 1 门禁与本 Task 的八项交付、合同测试场景；规范文件唯一真相源、Project 生命周期与 generation/CAS、多文件 journal 恢复、索引重建、影响预览和冲突撤销已有实现及回归。没有遗留的 Phase 1 产品代码待补；本轮未修改产品代码。当前工作树还包括后续阶段正在开发的内容，不能把全模块测试总数算作 Phase 1 专项测试。
- `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts --maxWorkers=1`：16 文件、129 项通过；应用 `typecheck` 通过。`--maxWorkers=2` 的首次运行在 128 项通过后因 Vitest worker 意外退出而失败，因此以单 worker 完整通过的运行作为本轮证据；History/SQLite 和 HTTP 拒绝告警来自故障注入或预期拒绝。默认全包、完整 Nuxt/浏览器人工验收和真实模型调用未执行；Phase 2–8 不因 Phase 1 完成而宣称完成。

## 2026-09-24 Phase 1 复验

- 对照实施计划 Phase 1 门禁与本 Task 的交付、场景清单，当前代码和测试未发现未完成的 Phase 1 项；不把 Phase 2 的细纲分析、正式采用等计入 Phase 1。
- 在当前包含 Phase 2 进行中改动的工作树运行 `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：12 文件、75 项通过；`bun run --cwd packages/neuro-book typecheck`：通过；`bun run docs:check`：6512 文件、0 失败。测试中的 History/SQLite 告警为主动故障注入。测试总数为大纲模块总数，并非 Phase 1 单独计数。
- 未执行默认全包测试、运行中 HTTP/浏览器验收和真实模型调用；Phase 2–8 尚未完成，不提升相关 Spec 成熟度。

## Phase 1 缺失条目诊断校验收尾

- 复核后续线路只读诊断时发现：外部丢失条目会跳过整个 manifest/entry 结构校验，掩盖无关方案损坏。现在只豁免已确认缺失的条目 ID 所直接依赖的引用和父级类型校验；现存条目层级、方案重复/循环与跨方案父级仍须通过校验。manifest 另外拒绝两个对象指向同一规范文件路径，防止丢失文件掩盖别名损坏。正常快照、发布、撤销及正文读取仍严格拒绝缺失文件。
- 增加丢失条目与重复方案并存的真实 ready Project 回归，以及格式层直接依赖关系和路径别名回归。模块聚焦测试按 8+8 文件分组运行，82+48 项全部通过；应用 `typecheck` 与 `docs:check`（6521 文件、0 失败）通过。两次单命令 16 文件运行均出现 Vitest worker 意外退出（分别完成 15 文件、127/130 项和 15 文件、124/130 项），故不宣称单命令全套通过；默认全包、完整 Nuxt/浏览器与真实模型未验证。Phase 2–8 不属于 Phase 1 已完成范围。

## 本轮 Phase 1 完成复验

- 对照实施计划与本 Task 交付、验收清单，现有存储、CAS、事务 journal、恢复、SQLite 重建和影响预览无已知待补代码；后续阶段的线路红色节点修复不属于 Phase 1。
- 当前工作树运行 `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts`：16 文件、132 项通过（计数包含后续阶段测试）；`bun run --cwd packages/neuro-book typecheck`：通过；`bun run docs:check`：6522 文件、0 失败。History/SQLite 告警来自测试注入的失败情境。
- 未执行默认全包测试、完整 Nuxt/浏览器人工验收或真实模型调用；不以 Phase 1 完成宣称 Phase 2–8 或整个模块完成。

## 2026-09-25 Phase 1 当前门禁复核

- 对照实施计划和 t03 的八项交付，存储基础无已知待开发功能；Phase 2–4 的部分实现不是 Phase 1 完成证据，也不据此晋升整个模块的 planned Spec。
- 当前工作树独立运行 Phase 1 相关聚焦测试（format、storage、planning-index、host、lifecycle、HTTP route）为 6 文件、82 项通过；应用 typecheck 通过；docs:check 检查 6523 个文件、0 失败。History/SQLite 告警来自主动故障注入。
- 同轮完整 outline-local 首跑曾出现 Vitest worker 意外退出：16/17 文件、148/150 项通过，退出码为 1；在不并行运行 typecheck 的情况下原命令单独重跑，17 文件、150 项全部通过。首跑原因未定位，不将偶发失败隐去；默认全包测试、完整 Nuxt/浏览器人工验收和真实模型调用未执行。

## 2026-09-25 Phase 1 用户请求复核

- 对照 Phase 1 八项交付与验收场景，规范文件、generation/文件 CAS、事务恢复、索引重建、影响预览和冲突撤销仍有实现及合同回归；无待补的 Phase 1 产品功能，本次未制造重复实现或修改产品代码。
- 当前工作树的 `bun run --cwd packages/neuro-book test --config vitest.outline-local.config.ts --maxWorkers 1 --testTimeout 20000` 限定 format、storage、planning-index、host、lifecycle、HTTP route 六个文件后，82 项全部通过；应用 `typecheck` 通过；`bun run docs:check` 检查 6530 文件、0 失败。六文件默认 5 秒超时运行有一项 Phase 2 跨父级移动生命周期用例耗时约 5.2 秒而失败；本次通过的是明确放宽测试超时后的真实运行，不隐去原失败。History/SQLite 告警来自故障注入。
- 尚未执行默认全包测试、完整 Nuxt/浏览器或真实模型调用；Phase 2–8 和整个模块不能据此宣称完成。

## 授权来源与边界

- 承接 [t02 领域映射与持久化决策](../t02-domain-mapping-and-persistence-decision/README.md)、[实施计划](../../implementation-plan.md)、[大纲规划 Proposal](../../../../../docs/proposals/outline-planning-module.md) 和 ADR 0022。
- 结构化项目文件是唯一规范来源；SQLite 只作为可重建索引、查询加速和解析摘要。
- 规划模块与 Plot 互补，不创建 Plot 的平行 Story/Scene 真相源，不修改 Plot Prisma schema，不建立 migration。
- 不修改用户作品数据、`lorebook/` 或正文；不调用真实模型；不提交、推送或创建 PR。

## 必须交付

1. `outline/manifest.yaml`、entry Markdown、伏笔 Markdown、线路 YAML 的 schema 常量、解析器和确定性校验器。
2. 带类型前缀的稳定 ID、对象版本、内容 hash、manifest revision 和文件名 slug 处理；移动、重排和改名不能改变稳定 ID。
3. manifest placement 表达全局唯一总纲下的多方案链关系，并支持共享条目引用和写时分叉的底层数据基础。
4. 伏笔标记的语法解析基础：成对注释、唯一 marker、允许 action、未知 ID/动作和损坏标记的 fail-closed 诊断。
5. 线路节点、边、业务 sequence 和 UI position 的结构化读写；主线唯一、无环、无逆序、引用存在性和重复节点的确定性校验入口。
6. 基于 Project generation、文件版本/hash 和 manifest revision 的 CAS 检查。
7. 多文件 staging/journal、确定性发布顺序、失败保留原文件、恢复入口和 SQLite 重建入口。
8. 对象删除与关系删除的影响预览数据，以及不覆盖后续修改的批次撤销基础。

## 核心不变量

- 任何索引写入都不能反向覆盖规范文件。
- 解析失败、schema 不支持、引用不存在、版本冲突或事务状态不完整时必须 fail-closed。
- 全局总纲只能有一个；`kind: total` 不能脱离 manifest 根总纲存在。
- `kind: detail` 必须关联章节大纲，不能独立成为线路节点。
- 对象删除和关系删除使用不同命令与不同影响预览，不能隐式级联删除共享对象。
- 临时文件、journal 和已发布规范文件必须可区分；未完成事务不能被索引当作正式数据。
- 撤销只在 CAS 仍匹配时执行；如果用户或外部编辑已经产生后续版本，撤销转为人工预览。

## 建议实现顺序

1. 先写 parser/validator 的合同测试和 fixture，再实现 schema 类型与规范化序列化。
2. 实现稳定 ID、hash、manifest/entry/foreshadow/line repository，并验证关闭重开可恢复。
3. 接入 Project file index mutation gate 和 Project History 的写入/删除/重命名记录，但不把 History accept/revert 当作领域事务。
4. 实现 staging/journal、原子文件发布、失败恢复和索引重建；用故障注入覆盖多文件部分失败。
5. 实现影响预览、对象/关系删除分离、CAS 批次撤销，并补充外部编辑和并发冲突测试。

## 合同测试与验收门禁

至少覆盖以下场景：

- 新项目创建规范目录并可关闭、重开、从文件完整恢复；
- 删除 SQLite 规划索引后可以由规范文件重建，且不会修改规范文件；
- 损坏 YAML/Markdown、未知 schema、未知引用、重复稳定 ID、未知伏笔标记和未成对标记被拒绝；
- 多条方案链共同引用唯一总纲；共享条目修改可以生成新 ID/新文件，而不覆盖源文件；
- 移动、重排、改名保持稳定 ID；对象删除与关系删除的预览和结果不同；
- manifest revision、目标文件 version/hash 或 Project generation 过期时拒绝提交；
- 多文件发布部分失败时原文件保持可读，journal 可恢复，索引不会暴露半成品；
- 撤销遇到后续修改时不强制覆盖，生成冲突预览；
- 线路业务顺序与 UI 坐标独立保存，环、逆序、主线重复和重复引用被拒绝；
- 规划文件从工作区外部修改后，下一次读取重新解析而不是盲信旧索引。

完成后记录实际运行命令、测试数量、失败注入结果和未验证边界。只有实现和验证证据齐备后，才能将对应 planned Spec 晋升为 implemented，并创建 Phase 2 Task。

## 明确不在本 Task

- 大纲库、伏笔库、线路规划和全屏工作台的产品 UI；
- Agent 讨论/自动模式、审批界面、SSE 流式协作和模型 provider；
- AI 偏差分析、线路语义冲突分析和自动修复；
- `writer.pro` 正式交接接口；
- 旧文档导入、Plot 适配器和正文编写流程。

## 完成条件

- 规划 schema、parser、validator、repository 和事务基础具有合同测试。
- 结构化文件可重建，SQLite 只做索引；损坏、并发和部分失败语义均有测试证据。
- Work README、相关 Spec 和本 Task 快照同步真实实现状态。
- 未完成能力和未运行门禁明确记录，不以文档代替实现证据。




