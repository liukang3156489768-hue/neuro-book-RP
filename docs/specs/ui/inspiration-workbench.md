---
schema: nbook.spec/v1
kind: behavior
status: implemented
capability: inspiration.workbench
owners:
  - neuro-book
---

# Inspiration 设计工作台首版

## 目标与非目标

用户从项目左侧模块栏打开设计工作台，完成八类素材的设计、审阅和确认保存，可在项目内管理设计聊天记录。素材设计页支持原创与改编，改编行为见 [inspiration.design-adaptation](../inspiration/design-adaptation.md)。作品提取由同一窗口的独立“作品提取”页负责，合同见两个提取 Spec。

本 Spec 不重复定义作品提取的自动跨块实体整合、用户指定实体合并或大纲库写入；这些能力由工作台内独立的“作品提取”页签提供，合同见 [inspiration.outline-extraction](../inspiration/outline-extraction.md) 与 [inspiration.material-extraction](../inspiration/material-extraction.md)。

## 术语与参与者

Inspiration 负责理解设计需求、分派专业方向和汇总成果。八类专业方向为角色、势力、风格基调、特殊物品、地点、写作指导与参考资料、特殊规则、世界观。草稿是供用户审阅的设计结果；正式素材是用户对具体内容确认后保存的项目文件。

作品来源指当前项目 reference 目录中用户选择的作品文件；切分块是尽量接近五万字、保持章节完整的连续文本，不代表原作中的一卷。

## 输入与前置条件

项目已打开且可用时，“设计模块”入口可操作；未打开项目或处于用户资产工作区时禁用。用户提供原创需求，可以查看和调整设计结果。作品准备流程需用户选择当前项目 reference 内的来源文件。

模型使用现有配置与运行能力。配置缺失或不可用时明确报错，不以固定示例或本地拼接内容冒充模型生成。

## 输出与可观察行为

入口打开标题含 Inspiration 的可拖动非模态窗口，底层编辑工作区保持可见和可交互。桌面提供需求输入、任务状态与成果审阅空间；窄屏下核心操作可滚动访问，输入和保存按钮不被裁掉。

原创需求由 Inspiration 分派到对应专业方向，设计成果按类别呈现。素材模板字段均非必填；内容描述设定与表达特征，不编排人物命运、剧情推进或伏笔。参考文献必须有实际来源，不能为填满模板虚构。聊天记录显示用户需求、处理结果、关联草稿及其分析来源，可新建、打开和归档。

模型内部必须返回模板字段对象；服务端校验字段归属并按模板顺序渲染为候选正文，界面只展示可编辑的标题和正文，不展示原始 JSON 或字段对象。输入区提供模型选择、思考开关和温度数值/滑块调节。

用户可以审阅、编辑、提出修改意见，并明确确认待保存的具体内容。确认前不得写入正式素材目录。成功后显示保存位置；失败时保留可重试的审阅内容。

设计工作台顶部有“素材设计”与“作品提取”两个页签。“素材设计”页提供原创／改编创作方式；“作品提取”页是程序化的大纲提取与素材提取入口（章节识别与划卷、统一分块预览、素材选块、后台进度与重试、数据去向、归类与审阅写入），两条流水线的进度面板分开，可同时运行，互不阻塞。首次切入时才加载，之后切换页签保留状态。

## 状态与转换

原创流程为待输入、运行中、待审阅、保存中和已保存；生成或保存失败显示错误并允许用户恢复。运行中提供取消，取消后不得继续保存成果。

关闭浮窗不等于确认保存。切换或关闭项目后，旧项目的异步结果不得显示为新项目的结果，旧草稿也不得保存到新项目。重新打开窗口时不得重复触发模型调用或重复保存。

模型生成的待审阅草稿立即持久化到当前项目的 `.nbook/inspiration/<draftId>/draft.json`。聊天消息记录关联草稿编号；切换聊天记录或重新打开工作台时，程序加载该对话最近一次关联草稿，恢复其待审阅条目。关闭窗口、切换对话或切换模式不会自动丢弃待审阅草稿。

作品准备仅在有效文件被选中后执行，成功显示结果；选择新文件后不沿用旧文件编号。准备失败应说明原因，不展示不完整结果为成功。

## 副作用与数据

模型生成会产生正常运行会话与任务结果；聊天记录存入当前项目 `.nbook/inspiration/conversations/`，归档不删除记录。正式项目素材写入只由确认保存触发。八类素材分别进入 lorebook 的 character、faction、instruction、item、location、note、system、world 分类，沿用项目已有内容节点结构和历史记录；提取来源哈希、块和段落引用一并写入素材元数据。

同名已有文件不得被未经确认的覆盖。重复点击保存不能制造重复成果。来源作品只读；切分编号不修改来源或正式素材。

## 失败与恢复

模型失败、非法结构化结果、取消和配置错误必须与成功结果区分。保存失败保留草稿并显示错误；项目关闭或身份失效时拒绝写入。不可读取、越界或超限的来源明确拒绝，不用模型猜测缺失正文。

## 边界与兼容

沿用项目文件所有权、路径包含校验和变更历史，不建立绕过工作区保护的文件写入通道。模型负责产出草稿，不能越过用户审阅直接写正式素材。共享窗口和导航只增加本模块接入，不覆盖主工作区已有界面改动。

旧版“作品分析与提取”入口已下线，`inspiration.extract` Profile、旧提取 API 与旧提取草稿路径一并移除。首次列出 Inspiration 会话时执行幂等清理：混合会话只保留原创设计消息，纯旧提取会话删除；关联旧提取草稿删除，已保存到 `lorebook/` 的正式条目保留。清理失败必须返回错误并允许下次重试，不得删除正式条目。

不修改 writer.pro 的六项输入，不自动将八类素材全量注入下游上下文，不引入本次范围以外的数据库迁移或大纲库合同。

## 验收与 Smoke

- 打开作品后，从左侧入口打开悬浮窗口；窗口可拖动，底层编辑器仍可操作；没有作品时入口禁用。
- 提交角色与世界观需求，按专业方向得到草稿；审阅前正式素材目录无新增设计成果。
- 修改草稿后确认保存，文件内容与实际确认版本一致，出现在对应分类并显示保存位置。
- 保存失败仍能恢复草稿；重复保存不创建重复条目；已有素材不被无声覆盖。
- 生成中切换项目或取消，迟到结果不污染新项目，也不产生正式素材写入。
- 选择有多个完整章节的作品，块内容可按顺序还原完整来源，段落编号与来源一致，末块不丢失，来源文件内容不变。
- 桌面与 390×844 窄屏下均能输入、审阅与保存，键盘可访问入口、窗口操作和表单。
- 切到“作品提取”页签：能选择来源、看到统一的块预览并确认划卷后开始整部大纲提取；素材提取可选择块后单独开始；两个任务同时运行时进度面板各自更新，互不阻塞；切回“素材设计”页再切换回来，进度与选择仍在。具体的提取行为按两个提取 Spec 验收。

## 实现合同

实现 owner 为 `packages/neuro-book`。前端由 `NovelIdeActivityBar` 发出入口事件，`InspirationWorkbenchDialog` 使用 `DialogWindow` 和 `useInspirationWorkbench`；服务端由 `server/inspiration` 编排现有 Agent Harness、来源切分和 tracked workspace writes。`shared/dto/inspiration*.dto.ts` 是 HTTP 输入、输出和结构化模型结果的运行期校验边界。

原创生成先创建绑定项目的不可变草稿，再由用户编辑并显式保存。服务端只根据草稿 artifact id 映射分类和确定性素材路径，不信任客户端分类或路径；确认记录和保存回执保证失败重试不覆盖不同内容。模型 invocation 绑定请求断连、主动取消、项目 ready 生命周期和十五分钟总超时。

“作品提取”页签由 `InspirationWorkbenchDialog` 内的 `SegmentedControl` 切换，宿主为 `app/components/novel-ide/inspiration/extraction/InspirationExtractionPanel.vue`（组件分层、请求与轮询状态见该目录同名 `.md`、`app/utils/inspiration/extraction-api.ts` 与 `app/composables/useInspirationExtraction.ts`）；请求打到 `/api/inspiration/extraction/*`，服务端装配只有 `server/inspiration/extraction/host.ts` 一处。该页签不复用首版 `useInspirationWorkbench` 的分析提取状态。

来源准备只读 `reference/` 内的 UTF-8 `.txt` / `.md` 文件，限制 5 MiB，并拒绝符号链接、目录联接和越界路径。切分器保留章节边界或完整段落，使用 P 编号、UTF-16 范围和 SHA-256 来源摘要。

## 证据

- [首版提案及批准记录](../../proposals/inspiration-design-module.md)。
- [.agents Work](../../../.agents/works/w00016-inspiration-design-module/README.md) 记录实现与验证过程。
- “作品提取”页签的实现与验证记录见 [Work w00020](../../../.agents/works/w00020-inspiration-extraction-pipeline/README.md)（t08 界面接入、t09 验收）。
- 实现入口：[工作台组件](../../../packages/neuro-book/app/components/novel-ide/inspiration/InspirationWorkbenchDialog.vue)、[服务编排](../../../packages/neuro-book/server/inspiration/service.ts)。
- 合同测试：[草稿与版本](../../../packages/neuro-book/server/inspiration/service.test.ts)、[确认保存](../../../packages/neuro-book/server/inspiration/storage.test.ts)、[工作台入口](../../../packages/neuro-book/app/components/novel-ide/inspiration/InspirationWorkbenchDialog.contract.test.ts)。
- Smoke：[工作台恢复与取消测试](../../../packages/neuro-book/app/composables/useInspirationWorkbench.test.ts) 提供无需模型的状态 smoke；[当前素材改编 Task](../../../.agents/works/w00016-inspiration-design-module/tasks/t02-design-adaptation/README.md) 记录 Mock 回归和隔离浏览器验证边界。
- 验证命令：`bun x vitest run --config vitest.inspiration.config.ts --configLoader runner`（临时聚焦配置，37 tests）；`bun run --cwd packages/neuro-book typecheck`；`bun run --cwd packages/neuro-book system-assets:prepare`；`bun run docs:check`。
