---
schema: nbook.work/v1
workId: w00020-inspiration-extraction-pipeline
issueId: null
---

# Inspiration 提取流水线与大纲库接轨

## 目标与授权

本 Work 承接开发者 2026-10-01 的讨论与确认：把 Inspiration 设计工作台的“作品提取”重构为两条程序化流水线，并修复大纲库总纲合同。设计与取舍见 [Proposal](../../../docs/proposals/inspiration-outline-extraction.md)（accepted）。

要交付的内容：

- 大纲库总纲改为每方案一个（手动关联才共享），细纲新增“来源提取”采用依据；
- 作品大纲提取：章节识别与划卷、自下而上写入提取方案、后台进度与单章重试、重复提取去向；
- 作品素材提取：九类素材、三种处理模式、校验重试、归类与整合、审阅后写入 `lorebook/` 并标记来源；
- 两条流水线的模型调用一律关闭思考。

不在本 Work 范围：工作台 UI 的整体整理（方向 1，待本 Work 完成后单独进行）；原创设计的流程；写作模块的选方案行为。

当前授权范围：

- 按下方切片在主工作区实现、写测试和做本地验证；
- 按需更新对应的 Spec 与 Task 快照。

未授权、需另行确认：

- 提交、推送、PR 或其他远端写入；
- 真实模型调用（实现与验证先用 Mock 模型；真实模型验收需开发者另行授权）；
- 数据库迁移、发布；
- 使用真实用户作品验收；
- 删除或覆盖用户已有文件。

## 开发范围纪律

**开发时只做计划内的内容。** 具体指：

1. 只实现下方合同表中各 Spec 与对应 Task 规定的行为；不顺手重构、不顺带“改进”邻近代码。
2. 开发中发现的其他模块问题（包括 Inspiration 现有的 refine 无取消／超时、extract 全有或全无、追问复用模板 schema、对话与模式绑定、已保存草稿仍显示待处理、`thinkingLevel` 可能为 undefined、对话框单行 CSS 等已报告问题），**暂不处理**，记入本 Work 的“待报告问题”，在全部切片完成后集中向开发者报告。
3. 仅当某个问题**阻碍了计划内容的开发**（无法编译、测试无法运行、依赖的行为无法使用）时才处理，处理范围限于解除阻碍的最小改动，并在“待报告问题”中单独标注“因阻碍而处理”及原因。
4. 拿不准某个发现算不算阻碍时，按不处理对待并记录，必要时询问开发者。

每个 Task 重复这条纪律，不得因 Task 范围内的“顺便”而扩大范围。

## 执行位置

主工作区 `master`，不建 worktree。原因与 [w00019](../w00019-writing-module/README.md) 相同：本 Work 直接依赖大纲规划模块（w00018）尚未提交的代码，从 `master` 新建的 worktree 会缺少这些内容。这是开发者此前“在主工作区开发、不提交”的约定，开始前请开发者确认；大纲规划改动提交后，后续切片可以改在 `.worktree/w00020-inspiration-extraction-pipeline` 进行。

## 合同

| capability | Spec |
|---|---|
| `outline.planning-library` | [planning-library.md](../../../docs/specs/outline/planning-library.md) |
| `outline.writer-handoff` | [writer-handoff.md](../../../docs/specs/outline/writer-handoff.md) |
| `inspiration.outline-extraction` | [outline-extraction.md](../../../docs/specs/inspiration/outline-extraction.md) |
| `inspiration.material-extraction` | [material-extraction.md](../../../docs/specs/inspiration/material-extraction.md) |
| `inspiration.workbench`（取代首版提取行为） | [inspiration-workbench.md](../../../docs/specs/ui/inspiration-workbench.md) |

## 实施切片

按依赖顺序排列。按 Work 规则，只在前一片结果明确后才创建后续 Task，下表中未标注链接的行只是计划，不是已登记的 Task。

| 序 | 切片 | 合同 | 依赖 | 内容 |
|---|---|---|---|---|
| 1 | 每方案一个总纲 | `outline.planning-library`、`outline.writer-handoff` | 无 | manifest 新 schema 与旧文件归一；新建方案带空总纲；手动关联与解除共用；写时分叉；删除预览列出受影响方案；写作交接按方案读取；Agent 工具与技能文档同步。已登记为 [t01](tasks/t01-per-plan-total/README.md) |
| 2 | 来源提取细纲依据 | `outline.planning-library`、`outline.writer-handoff` | 无（与 1 触及相同文件，顺序执行） | 细纲采用依据“来源提取”；免偏差分析、免上游退回；用户编辑后转普通；写作交接识别。已登记为 [t02](tasks/t02-source-extraction-basis/README.md) |
| 3 | 章节识别与划卷 | `inspiration.outline-extraction` | 无 | 纯数字标题规则、卷标题、用户修正、章节模式／字数模式划卷。已登记为 [t03](tasks/t03-chapter-recognition/README.md) |
| 4 | 后台提取任务框架 | 两个提取 Spec 共用 | 3 | 任务持久化与恢复、按单元状态、取消与继续、单元重试、思考关闭、提示词结构；大纲提取与素材提取共用。已登记为 [t04](tasks/t04-extraction-task-framework/README.md) |
| 5 | 大纲提取流水线 | `inspiration.outline-extraction` | 1、2、4 | 建提取方案与空结构；细纲、章纲、卷纲、总纲四步；校验重试；重提取去向与对比确认。已登记为 [t05](tasks/t05-outline-extraction-pipeline/README.md) |
| 6 | 素材提取基础 | `inspiration.material-extraction` | 无 | 来源标记元数据、四个新模板与校验、核实 `lorebook/` 子文件夹节点结构。已登记为 [t06](tasks/t06-material-extraction-basics/README.md) |
| 7 | 素材提取流水线 | `inspiration.material-extraction` | 4、6 | 逐块逐类调度、已知实体名单、中间产物、归类暂停点、整合、审阅与写入。已登记为 [t07](tasks/t07-material-extraction-pipeline/README.md) |
| 8 | 界面接入 | `inspiration.workbench` 修订 | 5、7 | 章节列表与修正、划卷、进度与重试、去向选择与对比确认、归类与审阅清单。仅接入功能，整体 UI 整理不在本 Work。已登记为 [t08](tasks/t08-extraction-ui-integration/README.md)（阶段 A 路由与接线，阶段 B 界面） |
| 9 | 验收与 Spec 修订 | 全部 | 1 到 8 | Mock 端到端冒烟；`inspiration.workbench` 首版提取描述的修订；真实模型验收清单（不执行，需另行授权）。已登记为 [t09](tasks/t09-acceptance-spec-revision/README.md) |

切片 1、2、3、6 互不依赖（1 与 2 触及相同文件，顺序执行）。

## 待实施时核实的事项

- `lorebook/character/<名称>/` 下能否放置子文件夹作为内容节点并被正常索引（切片 6 核实；Spec 已规定无法时的处理原则）。已核实（t06）：可以，子文件夹是普通内容节点，被扫描索引且无校验问题，依据为 `material-template.test.ts`，无需替代形态，切片 7 可直接使用；
- 旧版本读取新版 manifest 时能否做到明确拒绝（切片 1 核实）；
- `assets/workspace/.nbook/agent/profiles/.compiled/` 下的编译产物是否由构建命令再生，不手改（切片 1 涉及的 Profile 文案变更后核实）；

## 待报告问题

实施中发现的其他模块问题记在这里，全部切片完成后集中向开发者报告。本节在 t09 按类别整理（去重合并，不改变事实）；“因阻碍而处理”的项单独列在 F。

开发者指示（2026-10-02）：发现的问题若不影响开发，只记录，全部开发完毕后一并处理。

### A. 需要开发者决定的产品问题

- **旧“作品分析提取”入口是否下线**：新“作品提取”页签已接入，旧入口按 t08 约定仍保留（代码与数据路径均未改）；是否下线、旧入口保存的 `note` 大纲／细纲如何处置，Spec 已记为待开发者决定（[inspiration-workbench.md](../../../docs/specs/ui/inspiration-workbench.md)）。
- **真实模型验收与能力合同状态**：两个提取 Spec 保持 `planned`，真实模型验收需开发者授权，清单见 [t09](tasks/t09-acceptance-spec-revision/README.md)。
- **提取方案 `references` 指向原作与写作助手读取（t09 核实）**：交接上下文与素材读取接口不会自动加载或整本灌入原作（后者有 64 KiB 上限，超限拒绝而非截断）；但写作助手工具 `read_writing_material` 的可读范围包含本章交接列出的参考路径，该工具读取没有体积上限，助手主动调用时会把整本原作按段号返回进上下文。开发者已确认 `references` 保持现状；这是写作模块既有行为，未处理，是否给该工具加体积上限或把原作路径排除出助手可读范围待开发者决定。
- 使用中的总纲不可删除；孤立总纲级联按规范 `parentId`，可能波及其他方案挂载的条目（预览提示受影响方案）；`associate-total` 可关联孤立总纲（t01 取舍）。
- Agent 下发的大纲提取只能写入新方案且不修正章节，字数模式每卷块数固定为 5；排在长时间“重新汇总”之后的取消会等它结束（重新汇总只在项目关闭时中止）；`.compiled` 未改，本 Work 没有 Profile 源变化（t08 阶段 A）。
- “打开提取方案”只能打开大纲工作台，不能按 `planId` 预选方案（`OutlineWorkbenchDialog` 的 `focus` 要求 `entryId、planId、token`）；为接此事件在 `pages/index.vue` 仅追加了一处 `@open-outline-plan` 监听，该文件另有他人未提交改动，未触碰其余部分（t08 阶段 B）。
- 章节修正只能撤销最后一项或全部还原，不能撤销中间某一项（t08 阶段 B）。
- “素材不涉及剧情”规则只存在于 Inspiration Profile 提示词文本，没有代码校验；t06 只提供 `allowsPlotDevelopment` 数据开关，未改 Profile。

已由开发者确认（2026-10-02），无需再决定：t06 的读法成立，“不涉及剧情”只约束基础角色人设，经历与人际关系子节点不受约束；t07 的 Agent 覆盖权限保持现状（可覆盖 `origin: extract`，不可覆盖用户设计条目），无需收紧；t05 提取的章节大纲 `references` 指向原作，保持现状。

### B. 其他模块的既有失败与警告（未处理，未验证是否与本 Work 无关以外的原因）

- `server/agent/tools/file-tools.test.ts` 的“retrieval 的 index.md 清单命令可在真实 bash 中执行”在 Windows 上失败（ripgreprc 配置路径），与本 Work 无关，未验证是否既有（t09 全量复跑仍失败）。
- `server/outline/host.test.ts` 在 Windows 上打印 libsql `ConnectionFailed`（规划索引刷新失败）警告，用例仍通过；一次 `bun run test server/inspiration server/outline` 全量运行中曾出现与该文件相关的偶发失败（libsql 连接并发），复跑通过，未定位（t05）。

### C. 类型检查与测试基础设施

- `bun run typecheck`（`nuxt typecheck --logLevel silent`）在本机即使有故意引入的类型错误也返回 0，不能作为判据（t05）。可靠方式：服务端 `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit -p .nuxt/tsconfig.server.json` 并按文件过滤，该命令有大量既有错误（t08 阶段 A 记 388 条，涉及 `host.test.ts`、`service.test.ts` 等，含 `server/inspiration/service.test.ts` 的 `item` 隐式 `any` 与 `Mock` 类型不匹配）；app 侧 `.vue` 用 `NODE_OPTIONS=--max-old-space-size=8192 bunx vue-tsc --noEmit -p .nuxt/tsconfig.app.json`，仅 3 条既有错误，均在 `server/agent/tools/web-tools.ts`（`jsdom`、`turndown`、`turndown-plugin-gfm` 缺类型声明）。
- 测试文件的既有类型错误：`host.test.ts`、`operations.cascade-delete.test.ts`、`line-planning.test.ts`（旧 schema 字面量、`readonly` 数组 `.sort()`），`fork.test.ts`（旧 schema 字面量 `nbook.outline-entry/v1` 与 `contentHash` 类型），`nuxt typecheck` 未覆盖。
- 前端 vitest 配置（`app/components/**/*.test.ts`）没有 Nuxt 自动导入插件，使用 `ref`／`computed`／`useI18n` 等自动导入的组件测试要用 `vi.stubGlobal` 注入（`WorkspaceLorebookDetailPanel.test.ts` 即如此）；更多组件需要测试时可考虑统一的测试夹具（t08 阶段 A）。

### D. 本 Work 的实现限制

- 骨架创建每个条目一个领域事务，章节很多时 `prepare` 较慢；每个单元读取完整快照，大库上较重。t09 冒烟中 4 章的一次完整大纲提取在 Windows 上约 10 秒（模型为内存脚本，耗时来自大纲库写入与读取，从代码推断，未剖析）。
- 其余限制见各 Task 的“取舍与已知限制”。

### E. 工作区

- 工作区其他未提交改动（writing 工具、editor-workbench、outline 界面等）不属于本 Work，t08 阶段 A 起没有触碰。
- 旧“作品分析提取”入口仍在设计页（见 A）。
- t08 阶段 B 未做人工走查（未启动应用），`390×844` 无横向滚动与主题表现未实测；t09 同样未做（见 [t09](tasks/t09-acceptance-spec-revision/README.md)）。

### F. 因阻碍或授权而处理的项（已解决）

- `WorkspaceLorebookDetailPanel.vue` 的 `renderDraft` 按固定字段重建 frontmatter，保存会丢弃 `origin`、`extraction` 与 `ext`（t06 发现）；已按 t08 授权修复为保存时原样写回，带测试。
- t05 只改了 `server/outline/host.ts`，补充 `applyReadySourceExtractionDetail` 与 `readReadyPlanningSnapshot` 两个 ready Project 宿主入口（已有领域能力的入口，未改语义）。
- t07 复查：`material-consolidate.ts`（`personas` 隐式 `any[]`）与 `material.fixture.ts`（`JsonRecord`）的类型错误属本 Work 自身代码，已修复；`tsc` 复查 `inspiration/extraction`、`shared/dto/inspiration*`、`content-node-schema` 零错误，t01 至 t03 触及的 `server/outline` 非测试文件无错误。

## 当前状态

- 2026-10-02：Proposal 已 accepted；Spec 已写入（两个新能力，修订 `outline.planning-library`、`outline.writer-handoff`）；Work 已登记，[t01](tasks/t01-per-plan-total/README.md) 与 [t02](tasks/t02-source-extraction-basis/README.md) 可以开始，开发者已确认在主工作区实现，以及卷纲／总纲汇总、整合、手动合并同样关闭思考（Spec 已写入）。2026-10-02 开始 t01；同日 t01、t02 实现与验证完成（未提交）；下一步按需登记切片 3（章节识别与划卷）与切片 6（素材提取基础）。2026-10-02 t03（章节识别与划卷）实现与验证完成（未提交）。2026-10-02 t06（素材提取基础）实现与验证完成（未提交），`lorebook/character/<名称>/` 子文件夹节点已核实可用。2026-10-02 t04（后台提取任务框架）实现与验证完成（未提交），实现记录与流水线接口见 [t04](tasks/t04-extraction-task-framework/README.md)。 2026-10-02 t07（素材提取流水线）实现与验证完成（未提交），实现记录与切片 8 所需接口见 [t07](tasks/t07-material-extraction-pipeline/README.md)。 2026-10-02 t05（大纲提取流水线）实现与验证完成（未提交），实现记录与切片 8 所需接口见 [t05](tasks/t05-outline-extraction-pipeline/README.md)。 2026-10-02 t08（界面接入）实现完成，见 [t08](tasks/t08-extraction-ui-integration/README.md)。2026-10-02 t09（验收与 Spec 修订）完成 Mock 冒烟（6 个用例）、写作交接核实、Spec 与 Proposal 修订和验证（见 [t09](tasks/t09-acceptance-spec-revision/README.md)）；真实模型验收与人工界面走查未做，等待开发者授权，两个提取 Spec 保持 `planned`；“待报告问题”已按类别整理，待向开发者集中报告。
- 2026-10-03：按开发者验收反馈优化角色素材提取：新增按块角色发现与按角色逐块的独立提取单元，发现候选与正式实体索引分离，支持空结果、单元重试和成功片段归类详情投影；Mock 流水线与端到端冒烟已回归通过。真实模型验收仍未执行。
- 2026-10-08：按开发者确认完成 t10 角色分组提取与缓存观测优化：角色按覆盖率分为 A/B/C 级并只在同块组队，分组输出按角色校验和写入，失败可拆分单角色回退；角色请求改为稳定模板在动态目标之前，修复信息只追加；提取日志新增任务／单元／角色组／前缀哈希及缓存 token 字段。见 [t10](tasks/t10-material-cache-and-character-batching/README.md) 与 [提案](../../../docs/proposals/material-extraction-cache-and-character-batching.md)。真实模型缓存命中率待后续验收。
