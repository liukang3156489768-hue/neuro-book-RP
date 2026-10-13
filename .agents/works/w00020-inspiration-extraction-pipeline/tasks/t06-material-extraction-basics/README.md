---
schema: nbook.task/v2
taskId: t06-material-extraction-basics
---

# 素材提取基础

## 目标与范围

按 [material-extraction.md](../../../../../docs/specs/inspiration/material-extraction.md) 完成素材提取流水线的数据与规则基础，供切片 7 使用。本 Task 不含流水线、任务框架、界面，不调用模型。

要交付：

1. **来源标记**：`lorebook/` 内容节点元数据增加 `origin: design | extract`，缺失视为 `design`，旧素材无需迁移；提取素材另带来源文件、内容哈希与 P 段落引用。解析、序列化与既有读取路径兼容。
2. **四个新模板**：写作手法、素材特点、角色经历、角色人际关系；字段按 Spec“模板”表，均非必填；含校验（字段归属、引用格式），“参考片段”用 P 编号引用并可由程序还原为原文片段。写作手法与素材特点同在 `lorebook/note/`，元数据中的类型区分二者。
3. **例外规则**：写作手法与素材特点允许涉及剧情发展，其余类别仍遵守“不涉及剧情”规则（核实现有规则落点并只对这两类放开）。
4. **核实 `lorebook/` 子文件夹节点**：核实 `lorebook/character/<名称>/` 下能否放子文件夹（经历、人际关系）作为内容节点并被正常索引。无法时按 Spec“失败与恢复”的原则确定替代形态（主文件只含基本人设、经历与关系分开存放），并在本 Task 的“当前状态”中报告取舍，不改变 Spec 行为。

## 非目标

- 不实现素材提取任务、调度、归类、整合、审阅与写入。
- 不改变原创设计八类专业方向的模板与保存行为。
- **开发范围纪律**：只做本 Task 规定的内容。发现其他模块的问题不处理，记入 [Work 的“待报告问题”](../../README.md)，完成后集中报告；仅当问题阻碍本 Task 开发时才做最小处理并标注原因。

## 现状与改动落点（从代码推断）

- 现有模板、校验与保存：`packages/neuro-book/server/inspiration/`、`assets/workspace/.nbook/agent/profiles/builtin/inspiration.*.profile.tsx`、`shared/dto/inspiration.dto.ts`；
- `lorebook/` 目录约定：`packages/neuro-book/assets/reference/content/lorebook.md`；内容节点解析与元数据落点以实施时检索为准；
- 不手改 `.compiled` Profile 产物。

## 验证

- 聚焦测试覆盖 Spec 验收条目：新模板字段校验与 P 引用还原；`origin` 缺失视为 `design` 且旧文件读取不变；提取素材元数据往返；两类例外模板允许剧情；子文件夹节点核实结论有测试或可复现命令支撑。
- 相关既有测试通过；应用 `typecheck` 通过（`NODE_OPTIONS=--max-old-space-size=8192`）。
- 完成后更新 Spec“实现合同”事实，运行 `bun run docs:check` 不新增失败。

## 当前状态

2026-10-02 登记；同日实现与验证完成（未提交）。

实现记录：

- 新增 `packages/neuro-book/shared/dto/inspiration-material.dto.ts`：`origin`、`extraction` 来源信息、九类素材表（含 `allowsPlotDevelopment` 例外开关）与四个新模板定义。
- 修改 `server/workspace-files/content-node-schema.ts`：frontmatter schema 增加可选 `origin` 与 `extraction`（`origin: extract` 必须带 `extraction`，反之亦然）；新增 `readWorkspaceContentOrigin`，缺失读作 `design`。默认值生成器未改，旧文件序列化结果不变。
- 新增 `server/inspiration/material-template.ts`：字段归属／类型取值／P 引用校验、P 引用还原为原文、正文渲染、提取素材 frontmatter 构建。
- 新增 `server/inspiration/material-template.test.ts`（16 个用例）。八类原创设计模板与保存行为未改。
- 例外规则落点：现有“不涉及剧情”规则只存在于 Inspiration Profile 提示词文本，没有代码校验，所以此处用数据开关表达例外，只有写作手法与素材特点为 `true`；提示词与校验由切片 7 按它取舍。未改 Profile 与 `.compiled`。

子文件夹核实结论：`lorebook/character/<名称>/experience/` 与 `relationship/` 可作为内容节点，被 `scanWorkspaceTree` 正常索引，`type: character` 校验通过，无 `invalid-type`、同名冲突或 schema 问题（`validateWorkspaceTree` 返回空）。依据是代码阅读（内容节点为含 `index.md` 的目录，递归扫描，项目文件索引共用同一路径）与用例“lorebook/character/<名称>/ 子文件夹内容节点”。无需替代形态，没有取舍要报告。

验证：

- `bun run test server/inspiration/material-template.test.ts`：16 通过。
- 相关既有测试 `workspace-files.test.ts`、`project-file-index.test.ts`、`novel-workspace.test.ts`、`inspiration/service.test.ts`、`storage.test.ts`、`source.test.ts`：6 个文件 103 个用例全部通过。
- `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck`：通过，无错误（含并行 t03 的文件）。
- `bun run docs:check`：仍失败，均为既有的“新 Task 必须链接具体 Spec”类条目，无与 w00020 或本 Task 相关的新增失败。

已知限制：

- 经历与人际关系两个子节点按各自模板定义内容，不受类别级“不涉及剧情”约束；这是本 Task 的读法，需开发者确认。
- 工作区 UI 的 lorebook 详情面板保存时会丢弃 `origin`、`extraction`、`ext`（已记入 Work 待报告问题），在 UI 修复前，在面板中编辑并保存提取素材会丢失来源标记。
- 校验只检查 P 引用的格式、存在性与范围，不判断“剧情”与否；模型调用、调度与写入属于切片 7。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交、不做远端写入；不做数据库迁移；不使用真实模型。
