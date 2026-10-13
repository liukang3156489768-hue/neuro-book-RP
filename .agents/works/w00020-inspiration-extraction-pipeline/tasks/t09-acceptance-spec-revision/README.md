---
schema: nbook.task/v2
taskId: t09-acceptance-spec-revision
---

# 验收与 Spec 修订

## 目标与范围

在 t01 到 t08 全部实现后做 Work 的收口：

1. 用 Mock 模型做服务／路由层的端到端冒烟，覆盖大纲提取、素材提取、两者并行与“思考关闭”；
2. 核实提取方案的章节大纲 `references` 指向原作，以及“来源提取”细纲，在写作交接中的实际行为（只记录结论）；
3. 修订 [inspiration.workbench](../../../../../docs/specs/ui/inspiration-workbench.md) 中首版“作品分析提取”的描述，使其与“作品提取”页签一致，并同步 [Spec 登记](../../../../../docs/specs/README.md)、Proposal 与两个提取 Spec 的“实现合同”；
4. 运行并记录相关测试与类型检查；
5. 写出真实模型验收清单（不执行）；
6. 整理 Work 的“待报告问题”。

合同：[outline-extraction.md](../../../../../docs/specs/inspiration/outline-extraction.md)、[material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md)、[inspiration-workbench.md](../../../../../docs/specs/ui/inspiration-workbench.md)、[writer-handoff.md](../../../../../docs/specs/outline/writer-handoff.md)。

## 非目标

- 不做真实模型调用，不用真实用户作品，不做数据库迁移，不提交或推送。
- 不删除旧“作品分析提取”入口及其代码与数据路径（是否下线是产品决策，待开发者决定）。
- 不修改其他模块；发现的问题记入 [Work 的“待报告问题”](../../README.md)。
- 不改变 t01 到 t08 的服务端语义。

## 验证

- 冒烟：`bun run test server/inspiration/extraction/smoke.integration.test.ts`（packages/neuro-book）。
- 回归：`bun run test server/inspiration server/api/inspiration server/outline server/agent/tools app/components/novel-ide/inspiration app/components/novel-ide/workspace app/composables`。
- 类型：服务端 `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit -p .nuxt/tsconfig.server.json` 按 w00020 触及的文件筛选；app `NODE_OPTIONS=--max-old-space-size=8192 bunx vue-tsc --noEmit -p .nuxt/tsconfig.app.json`（允许既有 `web-tools.ts` 3 条）。
- 文档：`bun run docs:check` 不新增 w00020 相关项（其他 Work 有既有失败）。

## 当前状态

2026-10-02：Mock 验收、Spec 修订与验证完成（未提交）；真实模型验收与人工界面走查未做，等待开发者授权。

**冒烟**（`server/inspiration/extraction/smoke.integration.test.ts`，6 个用例通过，约 94 秒；模型为内存脚本，服务／路由层，不含界面；源文本在系统临时根下生成，仓库不存大文本）：

- 大纲：识别章节、确认划卷后依次产出细纲、章节大纲、卷纲、总纲，经大纲库读回，细纲带“来源提取”依据，章节大纲 `references` 指向原作；重复提取三种去向（新建、补充只填空缺、覆盖先对比再确认）；取消后继续、第 3 章失败后重试，已完成单元不重做。
- 素材：归类、分组与输入暂停、整合、审阅、确认写入；`lorebook/` 条目带 `origin`／`extraction` 并可被工作区扫描索引且无校验问题；与用户设计条目同名时先对比，另存为后原条目不变。
- 大纲任务停在模型调用时素材任务仍可推进，放行后各自完成。
- 思考关闭：真实适配器路径的每次调用 `reasoning` 均为 undefined。

**写作交接核实**（只记录结论，未改其他模块）：

- 章节大纲 `references` 以路径与定位出现在交接上下文，不会自动加载原作；`readSelectedWriterMaterials` 只读用户明确选中的 1 至 8 个文件，总体 64 KiB 上限，超限拒绝而不截断（冒烟用例以超过 64 KiB 的原作验证）。
- 写作助手工具 `read_writing_material` 无体积上限，可读范围含交接列出的参考路径，助手主动调用时会把整本原作带入上下文。这是写作模块既有行为，已记入 [Work 待报告问题](../../README.md)，待开发者决定。
- “来源提取”细纲在交接中被识别：上下文返回该细纲，`buildChapterMaterials` 通过。

**Spec 与文档**：[inspiration-workbench](../../../../../docs/specs/ui/inspiration-workbench.md)（首版“作品分析提取”描述改为与“作品提取”页签并存、链接两个提取 Spec、旧入口保留且是否下线待开发者决定；此文件另有他人未提交改动，仅本任务相关段落为 w00020 内容）、[Spec 登记](../../../../../docs/specs/README.md)、两个提取 Spec 的“实现合同／证据”（去掉“界面尚未实现”，补写作交接与证据）、[outline-planning-module](../../../../../docs/proposals/outline-planning-module.md) 与 [inspiration-outline-extraction](../../../../../docs/proposals/inspiration-outline-extraction.md) 的决策记录。两个提取 Spec 状态保持 `planned`，原因是真实模型验收与人工走查未做。

**验证**：

- 回归 `bun run test`（范围见上）：93 个文件，817 通过、1 失败；失败是 `server/agent/tools/file-tools.test.ts` “retrieval 的 index.md 清单命令可在真实 bash 中执行”（Windows 上找不到 `rg`），与本 Work 无关，已记入待报告问题。
- 服务端 `tsc`：388 条，与基线 388 持平；w00020 触及的非测试文件（`server/inspiration/extraction`、`shared/dto/inspiration*`、`server/api/inspiration/extraction`、`extraction-tools`、`server/outline` 非测试文件、`content-node-schema`）和冒烟测试文件均无错误（冒烟文件最初有 2 条 `OutlineScript` 类型错误，已修）。剩余 `server/inspiration/service.test.ts` 2 条为既有。
- `vue-tsc`：3 条，均为 `server/agent/tools/web-tools.ts` 缺 `jsdom`／`turndown`／`turndown-plugin-gfm` 类型声明（既有，允许）。
- `bun run docs:check`：失败，列出的是其他 Work 与他人未提交 Spec 的既有问题；与 w00020 相关的只有 `docs/specs/ui/inspiration-workbench.md` 三条（`implemented` Spec 的证据缺“实现入口：”“Smoke：”标签行、“合同测试：”链接要求），这三条在 HEAD 版本中同样存在，非本 Work 新增；本 Work 新增的两个提取 Spec 与 t09 README 未出现在报告中。
- 人工 UI 走查：未做（未启动应用）。
- 真实模型验收：未做。

## 真实模型验收清单（待开发者授权，未执行）

在得到明确授权前不调用任何真实模型，也不使用真实用户作品。授权时请开发者确认下列各项，或给出替代值。

| 项 | 建议 | 需开发者确认 |
|---|---|---|
| 模型 | 提取使用 `inspiration` Profile 解析出的模型（真实适配器 `createProjectExtractionModel`，思考关闭）；先用价格低的 `deepseek/deepseek-flash`（`test:real-model` 的默认模型）验证流程，再决定是否用写作实际使用的模型复测质量 | 使用哪个模型、凭据来源（仓库根 `.env` 的 `DEEPSEEK_API_KEY`，缺失则按规范记为“未验证”） |
| 样本 | 大纲提取：一部授权可用的短篇或长篇前 8 至 10 章（约 3 万字），含卷标题与普通章节标题各一例；素材提取：同一或另一部约 12 万字（三个分块），含出场多次、有别称的角色。作品由开发者指定，放在隔离项目的 `reference/` 下，不入库 | 样本文件与是否可进入 Git；是否允许使用真实用户作品 |
| 预算 | 大纲：约 `2 × 章数 + 卷数 + 1` 次调用（10 章 2 卷约 23 次），每次含整章原文；素材：`块数 × 9` 次提取调用（3 块约 27 次）加每个实体与文档类各一次整合调用，另有手动合并时的调用。请开发者给出 token 或费用上限，达到上限即停止并报告 | token／费用上限、是否允许一次重跑 |
| 环境 | 隔离 State Root 与临时项目（沿用 `test:real-model` 的隔离方式，写入只落在本次 run 内），不触碰开发者的真实工作区 | 是否允许启动应用做人工界面走查 |

通过判据（按观察到的行为，不断言措辞）：

1. 大纲：章节识别结果与样本目录一致（含卷标题）；划卷后任务完成，大纲库中出现“提取方案1·<作品名>”，每章有“来源提取”细纲与章节大纲、每卷有卷纲、方案有总纲；所有细纲与章节大纲的 P 引用落在本章范围；写作交接能读出章节目录且各章可写。
2. 大纲重复提取：补充只填空缺；覆盖在确认前不写入、拒绝项不变；来源文件改动后只允许新建。
3. 素材：九类各有产出；实体按别称并入同一文件夹，疑似同一实体被标出；角色主文件只含基本人设，经历与人际关系按块顺序保留引用；写入 `lorebook/` 的条目 `origin: extract` 并带来源文件、哈希与 P 引用，工作区扫描无校验问题；与用户设计条目同名时先对比，另存为后原条目不变。
4. 模型调用：全部请求思考关闭（用调用日志核对 `reasoning` 未设置）；校验失败重试一次，再失败时该单元标记失败而其余继续。
5. 并行与中断：大纲与素材任务同时运行互不阻塞；运行中取消、关闭项目再打开后任务显示已中断并可继续，已完成单元不重做。
6. 质量记录（不作通过判据，供开发者评估）：模型输出的合规率（首次通过比例、修复重试比例、失败单元数）、总调用数与实际花费、各阶段耗时。
7. 界面走查（若授权启动应用）：桌面与 `390×844` 下完成上述流程各一次，无横向滚动，浅深主题各看一个代表状态。

任一项未覆盖时在证据中写“未验证”，不得写成通过。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不使用真实模型。
