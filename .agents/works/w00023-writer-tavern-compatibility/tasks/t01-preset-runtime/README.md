---
schema: nbook.task/v2
taskId: t01-preset-runtime
---

# 真实预设编排与写手接入

目标与批准范围见 [Spec](../../../../../docs/specs/writing/tavern-preset-compatibility.md) 和 [提案](../../../../../docs/proposals/writing-sillytavern-preset-compatibility.md)。2026-10-11 开发者授权本地样本开发并明确仅兼容预设提示词、不要求插件同步；无远端写入、合并或发布授权。本轮源码开发完成，待开发者验收。

样本来源：开发者指定的 Downloads1 JSON，306174 bytes，SHA256 `4ca46dc936a6c63434c556a9ac314c6ae33162ab871c5376699d352c0b82a23f`。原文件只读；第三方样本存本地缓存，不二次发布正文。

当前：120 条源提示、110 条全局序列、57 启用、17 正则、一个启用 TH 回复质检脚本。最新一轮完成预设提示词产品接入，具体证据和兼容边界见本文末节。原生导入、legacy/native 宏和身份、marker、示例、历史、正则、文本后处理、depth/trigger、多历史 continue/prefill、名称模式及显式词表预算已实现。Harness 在请求前持久化最终消息及变量终态，审阅复用同次结果；没有记录时拒绝重新求值。完整插件环境不在本轮范围。

范围：Chat Completion 编排与写手运行边界，包含原生编辑与实际写作接入。完整 SPreset 工作区、任意插件执行及文学质量不冒充结构兼容。

基线：master `4778ba3a` 与主树现有未提交 packages/docs 变化的只读副本。主树已有改动保留；本任务差异单独记录。

证据要求：真实样本测试、原生请求捕获、变量 before/after、聚焦回归与类型检查；酒馆运行和真实模型未执行时明确标为未验证。

## 实际日志与证据

第一份清洗日志 `Request Example/policy.txt` SHA256 `b5c4254378d3d4edc628c06d8fec1fd908ab3e97874c4f4d0a284cf516c73f9a`，缺消息对象头。

补充 `Request Example/新建 文本文档.txt`：59086 bytes，SHA256 `2162d819bdd56585486370087935744103b1219bde21cddde60ed18ff0941ab9`。明确 strict，六条角色 system/user/assistant/user/assistant/user，末条为继续生成指令；清洗 console 日志没有 HTTP 地址、认证头或独立响应体。安全解析字面值和字符串拼接，不执行文本。

模型 `claude-opus-4-6`，temperature=1、top_p=0、max_tokens=50000、presence_penalty=0、frequency_penalty=0、stream=true、reasoning_effort=none。五项采样与原预设相等，但未证明项目已采用。

正常样本绑定得到 37 消息；以日志身份、空槽位和摘出的一条 assistant 选择 strict+continue 得到 6 消息，角色序列一致。25 个非空普通片段中 22 个直接匹配，23 个忽略空行后匹配；剩余涉及结束标签与成文设置格式，exactContent=false。

相同绑定的原函数 oracle 比较 messages/local/global/regexStages 全 true。固定 ST revision `06bde939fb1e9c4c8d8641d810f0a916b5bce127`，7 份源码 SHA 校验；零 token 计数不验证预算。history 前处理使用本实现正则，再与原函数分别对照，不是完整浏览器运行。

元数据报告：`.local/tavern/full-reference-report.json`。应用包 cwd 复现：`smoke:tavern-preset --preset ../../.local/tavern/sample.json --bindings ../../.local/tavern/console-bindings.json --upstream ../../.local/tavern/upstream --reference "../../../../Request Example/新建 文本文档.txt"`。

## 早期编排阶段的验证

- 聚焦 7 文件 29 测试通过；随后 Harness 增加 none/strict 两种真实 SDK 路径，4 测试通过，总计有效覆盖 30 测试。请求捕获曾逐块解码 UTF-8 造成中文跨 chunk 乱码，修为流式 UTF-8 解码后通过。未调用真实模型。
- 先前 ordered-provider-request 三测试通过，本次未改变其行为。
- scripts:typecheck 仅 4 个既有错误：product-agent-state-root-smoke 缺 colorway，三个 seed 缺 agentMode；这些文件未改。本次源码未报告类型错误。
- 最新应用 typecheck 仍仅 MaterialConflictResolver.vue(70,118) 的 state/main 索引既有错误，该文件 SHA 与继承副本一致；本次源码未报告类型错误。
- docs:check 无 failure；既有其他 Task 链接警告保留，本 Task 已补 Spec 链接。无浏览器或完整写作 UI 验收；真实模型样本结果见下节，锁文件无变化。

2026-10-11，开发者指定已配置 cabo 的 Opus 4.6 进行真实测试。只读用户 State Root 的 `.nbook/config.json`，确认 cabo/custom-3、`https://bak.cabo.lol/v1`、openai-completions、`claude-opus-4-6`。首次被服务端 `401 Invalid token` 拒绝；随后开发者更新配置并授权重测。密钥不复制或输出。

## cabo 真实模型重测

已完成两轮、四次真实调用。第一轮使用空资料槽位，两路分别返回 500/432 字符的确认说明，没有正文标签；证明接口可用，不能验收写作效果。其结果保留为 `.local/tavern/real-model-empty-slots.json`。

第二轮填入同一人造成年角色场景：青禾车站雨夜换灯、陈越与林岚的人物资料、Persona、性格与明确时间地点；原始预设不改，历史为一条写作任务。strict、normal；参数与日志相同：temperature=1、top_p=0、max_tokens=50000、两项 penalty=0、reasoning_effort=none、stream=true。

`test:real-model -- scripts/smoke/real-model/tavern-writer.test.ts` 1 测试通过，约 295 秒。兼容/上游两路均 stop，均有 `<content>` 与 `<time>`；正文去 HTML 和空白后的可见字符数分别 1823/1971，达到本测试 1800 的下限；原始输出长度 3802/4646。模型报告的输出 token 分别 4640/5620；本测试成本字段为零元数据，不能用于推断服务商实际费用。

最终 messages SHA256 均为 `91778e8e80ab37df2190ca831c79512eebe48602941382b2ee613b65fa5d8779`，同输入编译和发送一致；随机文本不同，不要求逐字相同。对真实输出再运行固定酒馆原函数，stored/display 两阶段逐字匹配，本地显示长度 3946/4790。

原始、存储和显示输出在 `.local/tavern/real-model-result.json`；仅元数据在 `.local/tavern/real-model-output-comparison.json`。本地 `.local/tavern/check-real-model-output.ts` 可不调用模型复查正则。结果不含密钥，小说场景仅作测试，不写入用户作品。

两路模型都在正文前输出分析说明，未使用可被预设清除的 build 包裹；stored 阶段因此没有删除它。这是同请求下可观察的模型/预设表现，不以额外文本清理掩盖差异。完整产品还需确认正文提取与显示范围。

当时剩余项：产品参数优先级、作品资料/历史绑定、变量跨尝试作用域、输出存储/显示/质检及编辑入口；现已按下节接入。真实两路直接 SDK 样本通过不等于完整写作工作流或酒馆全部插件环境验收。

早期仅单条 assistant 续写且 prefill 关闭的限制，已在多历史及深度对照后解除。此阶段尚不支持新宏引擎与预算裁剪，现状以本文末节为准；fullEnvironmentEquivalent=false。

本次独立文件差异的字节哈希清单与 patch：`.local/tavern/task-changes.json`、`.local/tavern/task.patch`；相对于继承工作树副本或 HEAD，不将主树原有几百项变化当成本次实现。未提交、未推送。

## 2026-10-11 产品接入与统一验收准备

开发者在了解现状后授权继续完善剩余部分，全部完成后统一验收。本轮完成：

- 两写手用途的本地原生/完整配置导入；专用编辑器排序、启停、角色、名称、正文及新建/移出序列，原文件未知字段保留，同 ID 新修订。
- 身份、资料/历史默认绑定、初值与延续、正文模式、质检、生成参数覆盖、预览和双格式导出。预览不推进变量、不调用模型。
- 预设参数覆盖 Profile/Provider 默认，明确生成覆盖优先；CUSTOM effort 原函数映射对照。日志 none 通过显式覆盖复现，不把原样本 max 猜成 none。
- local 写作会话及 global 项目/用途/预设隔离，稳定 owner 穿过归档父链。编译收据独立存储、SHA256 索引、原子状态提交、并发差量冲突和损坏拒绝。
- 写作端口冻结 raw/stored/display/prose/quality，再提交变量，返回正确 durable 游标；同请求/编译/分支恢复同次输出，不重生成。正文标签失败保留证据并交现有重写处理。
- 固定 SHA 的 Turing v3.11 本地规则适配，报告交助手审阅；未知脚本不执行。云端复核/补丁/聊天统计仍报告缺失。
- 正文宏中的 prototype 名称不被 schema/JSON codec 吞掉；变量字典使用 own-key 安全解析，冻结输出校验与写入在会话 mutation 锁中完成。

有效证据：本轮统一 19 文件 112 测试通过，包括固定原函数 oracle、SDK 捕获、资料完整性、原生 UI、变量收据与回复恢复。最终竞态/字典修复后输出、端口与 runtime 共27项再次通过（端口新增2项）；SDK捕获与JSON codec 两文件7项通过（codec3项）。合计20个有效文件117项，未将重跑重复计数。此前真实 cabo 结果未重跑；两路 stored/display 在本轮正则阶段修正后离线复查仍逐字相等。

真实隔离 API：GET 60 用途，样本 strict 预览 6 消息/50 local 变量，导入/同 ID revision2/sourceJson 完整保留/409 并发保护通过；零模型调用，未写用户作品。

浏览器：实际受控视图+Component Lab fixture、应用 UnoCSS/reset/nb-ui 样式，1600×1000 与390×844 无横向溢出，footer 可见，编辑/启停/排序/预览/同ID保存/导出回调/样本导入重开通过；120 prompts/110 order。`.local/tavern/ui-evidence.json`。完整 Nuxt 设置宿主首次客户端资源挂起，改用实际组件隔离验证，不能冒充完整宿主验收。隔离 host 已停止，Temp State Root 清理。

应用 typecheck 最终仍只有继承的 MaterialConflictResolver.vue state/main 索引错误，本次源码无诊断。scripts:typecheck 最新仍仅4个既有失败（deploy缺colorway/userColorways、三个seed缺agentMode），本次脚本无诊断。docs:check 无 failure，既有其他 Task 警告保留。Lab 索引 8/9 通过，40 个其他组件未登记的既有失败未扩修。

开发期间变量状态为 schemaVersion2（收据索引格式）；早期未发布v1状态明确拒绝，无静默迁移。完整生产作品生成、文学效果、所有扩展环境和 token 精确裁剪未验证。使用[操作说明](../../../../../packages/neuro-book/docs/runbooks/writer-tavern-presets.md)，代码仍仅在本 worktree，未合并到主树/安装包、未提交/推送/发布。

## 2026-10-11 预设提示词范围收口

开发者明确无需同步兼容酒馆插件，仅要求预设提示词，入口位于配置中心。本轮完成：

- 两种固定原生宏引擎，legacy 使用原分类 pass，native 使用固定 lexer/parser/walker；支持嵌套/惰性条件、简写和索引变量、存在判断与删除。宿主显式绑定，时钟、时区、语言和随机种子冻结。独立审查发现无时区日期受服务器时区影响、duration 忽略 locale，已在所属 adapter 修复并补跨引擎回归。
- 原生空值、none/merge/semi/strict/single 及 tools 文本后处理，system squash 保留示例和新聊天边界。历史 NONE/DEFAULT/COMPLETION/CONTENT 名称模式、continue_prefill name 清洗，以及正则查找 NONE/RAW/ESCAPED 宏替换；只转义宏结果，不破坏表达式字面语法。
- 显式 claude/cl100k_base/o200k_base 真实词表预算、响应预留、最新历史优先与整组示例选择，含深度注入裁剪及首个拒绝候选的宏副作用。必需作品资料全部丢失时拒发，有保留副本时允许。usedTokens 为后处理前编排占用；Harness 复算最终前缀再检查真实模型窗口。
- 配置中心增加引擎、全部后处理、depth/order/trigger、生成类型、预算与结构化报告。插件数据保留并登记依赖，SPresetSettings 不发模型，条件脚本不执行；本次未触发的条目不阻止生成。输出阶段使用冻结引擎，变量删除参与幂等和并发冲突检查。
- 新增并锁定原生引擎/时间随机依赖、真实词表；bun.lock 本轮有修改，早期无锁修改的记录仅代表当时状态。上游固定版本与 SHA 登记在 tavern-native/UPSTREAM.json 和 tokenizers/README.md。

最终统一命令：设置 NBOOK_TAVERN_SAMPLE=.local/tavern/sample.json、NBOOK_TAVERN_UPSTREAM_DIR=.local/tavern/upstream 为绝对路径后，执行 `bun run --cwd packages/neuro-book test server/prompt-management server/agent/harness/prompt-management.test.ts server/agent/harness/pi-request-options.test.ts server/writing/runtime.test.ts server/writing/tavern-output.test.ts server/writing/tavern-agent-port.test.ts shared/prompt-management/tavern-bindings.test.ts app/components/novel-ide/settings/sections/prompt-management app/composables/usePromptManagementSettings.test.ts scripts/smoke/tavern-preset.test.ts scripts/smoke/tavern-request-reference.test.ts`。

结果：22 文件 161 测试通过，无 skip；包含固定原函数宏、后处理与48组真实词表预算对照。SDK 本地捕获新增 native+merge+Claude预算100000 场景，裁剪一条超长旧历史，实际 messages 等于冻结消息，回复恢复不重新发送。没有再次调用真实模型。

本轮 UI：实际组件及 fixture 在1600×1000、390×844 下检查深度/trigger/native/merge/预算/保存，无溢出和 pageerror；footer 可达。证据 `.local/tavern/ui-injection-evidence.json`，隔离 host 已停止。完整 Nuxt 配置宿主仍沿用先前未验证边界，未冒充完整应用验收。

应用 typecheck 默认4GB曾内存不足；以进程 NODE_OPTIONS=--max-old-space-size=8192 重跑，仅继承的 MaterialConflictResolver.vue(70,118) state/main 索引错误，本次文件无诊断。scripts:typecheck 仍仅4个继承错误（deploy缺colorwayId/userColorways、三个seed缺agentMode），本次脚本无诊断。

docs:check 无 failure，其他 Work/Task 的既有链接与Spec登记警告保留。本任务显式差异名单98个候选文件，dry run无缺失或重复；独立 patch 和逐文件 SHA 清单仍位于 `.local/tavern/task.patch`、`.local/tavern/task-changes.json`，用于区分继承用户变更。仅核对本任务路径，未全量暂存。

剩余边界：完整设置宿主、生产作品写作与模型文学效果由开发者验收；插件执行、EJS、SPreset 条件、世界书自动激活、媒体/工具和原生 Claude/Gemini 转换不在本轮范围。源码仅在 codex/w00023-writer-tavern-compatibility 的既有 worktree；没有更新主树或现有安装包，没有提交、推送、合并或发布。使用步骤见[操作说明](../../../../../packages/neuro-book/docs/runbooks/writer-tavern-presets.md)。

## 2026-10-11 写作条目映射

开发者明确目标同时包含资料占位符和自定义变量，且处理顺序必须先初始化再映射。本轮将该顺序接入保存校验、预览和真实写手编译，行为合同见 [Spec 写作条目映射](../../../../../docs/specs/writing/tavern-preset-compatibility.md#写作条目映射)。

- 新原生导入生成 writerMappings，不改变 sourceJson；职责和输出要求排除，场景23条、改写12条按类别展示原模板与共享下拉。多个条目按原顺序合并到同一目标，局部与全局同名隔离。
- 静态发现资料宏、marker、固定名变量、key/index与native简写；停用/未触发/只定义未读取字段不可选，动态名称只提示。源编辑使目标消失时保留选择，保存预览拒绝无效目标。
- 从初值或持久作用域执行本次变量初始化，再注入映射，最终展开阶段只读变量，避免初始化覆盖和副作用重复。回复阶段仍按冻结终态正常执行变量更新；没有映射字段的旧配置与快照不变。纯自定义变量、无marker预设可运行。
- 必需条目完整渲染内容必须实际出现在消息中，覆盖惰性分支未读取和预算裁剪，不用未使用字段满足资料合同。旧配置显式转换已知原模板内容，手工资料与未应用绑定草稿保留。

有效测试：统一回归23文件172项通过，无skip；随后新增无marker资料宏与旧native人物环境覆盖用例，映射文件9项通过，合计23文件173项有效覆盖。包含两引擎初始化不重复、持久初值覆盖、多条聚合、局部全局、目标缺失/未读取、必需项缺失、条件分支、预算、旧配置、保存重开、预览与运行时一致；图灵样本额外通过native+strict+映射+Claude预算的真实SDK本地捕获及输出恢复。没有真实模型调用。

浏览器：实际受控设置视图与既有fixture，1600×1000、390×844下选择局部/全局/不映射、保存回调、缺失目标保留通过，root/contentOverflow均0、页脚可达、无pageerror；证据`.local/tavern/ui-mapping-evidence.json`。首次Vite预热导致导航超时，资源准备完成后通过，不将超时记为业务通过。完整Nuxt配置宿主仍保留此前未验证边界。

应用typecheck以8GB堆重跑，最终仅继承的MaterialConflictResolver.vue(70,118) state/main索引错误；新增测试中的可空索引诊断已修复，本次文件无诊断。docs:check无failure，其他Work/Task既有警告保留。独立差异清单新增两映射文件，源码仅在原worktree，未提交、推送、合并或更新安装包。操作步骤已更新同一runbook。

收口：scripts:typecheck仍仅4项继承错误（deploy缺colorwayId/userColorways，三个seed缺agentMode），本次文件无诊断。映射9项最终重跑通过；独立差异100候选无缺失或重复、98实际文件，patch reverse check通过。隔离Vite浏览器host已停止。

## 2026-10-11 多选、直接排序和删除

开发者明确要求条目多选和拖动、直接排序/变量映射切换、单条和多选彻底删除。本轮在原worktree完成，行为合同见同一[Spec](../../../../../docs/specs/writing/tavern-preset-compatibility.md#写作条目映射)及[UI合同](../../../../../docs/specs/ui/prompt-management.md)。

- 全部源条目可选，包括未加入序列条目；全选/半选状态、清空选择、单条和批量删除均作用于草稿。彻底删除清除prompts及所有character_id的顺序引用和同名资料绑定；移出序列保留源条目。失效映射保留并由保存明确拒绝。
- 指针手柄捕获到稳定序列容器；支持多选组按原相对顺序拖动，键盘上下移动和原箭头保留。取消、失去捕获及保存期间清理拖动状态。
- 每个小节可选直接排序或变量映射；直接条目引用真实源条目，角色/正文/触发/depth可编辑，与酒馆条目共用序列。模板由写作渲染器展开，资料字面宏不参与初始化或深度消息二次求值。必需变量删除、停用或裁剪继续拒发。
- 模式互斥；切回映射恢复previousMapping，直接模板保存在writerDirectDrafts，休眠草稿不参与编译。切回直接模式以新ID恢复改动并追加到全局序列。彻底删除直接条目同时清理休眠模板；旧配置缺少新增可选字段时原快照不变。

最终统一回归24文件182项通过、无skip，命令沿用前节并增加tavern-editor.test.ts（包含在编辑器目录收集中）。新增覆盖两引擎直接输入、字面宏与深度、组移动、全部角色引用清除、失效目标、切换改动保留/严格schema往返、UI多选/删除和保存。持久化合同验证混合模式revision2、重开/预览/运行时一致及旧快照保留；图灵样本追加native+strict+映射+直接条目+预算的真实SDK本地捕获，发送等于冻结消息，回复恢复不重发。没有真实模型调用。

真实浏览器：实际受控设置视图和既有fixture，1600×1000与390×844下鼠标多选组拖动、键盘移动、模式互斥、未排序/直接条目批量删除、保存回调通过；root/contentOverflow=0，页脚与选框可见，无pageerror。证据`.local/tavern/ui-sequence-evidence.json`。复选框浏览器测试最初直接点击sr-only input被label拦截，改用真实可见label操作后通过；不将测试交互失败记为产品通过。完整Nuxt配置宿主和真实作品仍待开发者验收。

应用typecheck最新仅继承的MaterialConflictResolver.vue(70,118)索引错误，本轮文件无诊断。docs:check无failure、既有其他Task警告保留；脚本未改，沿用前节脚本基线。操作说明和组件伴生文档同步。独立差异名单101候选无缺失重复，本轮新增编辑器合同测试；没有提交、push、合并或更新安装包。

## 2026-10-12 主工作区集成

开发者确认测试完毕，明确授权将 worktree 改动合入主工作区。独立差异清单为99文件：97个产品/规范/测试文件、2个本 Work/Task 快照。集成前逐文件核对 worktree SHA 与开发前基线；主树4个文件仅CRLF/LF不同，无内容冲突。97个产品文件已进入主工作树，65个新增、32个既有文件更新；536个非任务文件逐字节保持，Git暂存区未变，主分支仍为master。治理快照随后同步同一记录。此次为现有未提交工作树之间的本地集成，不创建Git合并提交，不push、不创建PR、不更新安装包。

主树集成验证：沿用前节统一命令、样本与upstream路径显式指向原worktree缓存，24文件182项全部通过，无skip，无真实模型调用。docs:check无failure，保留其他Task既有警告；本任务路径git diff --check通过。除安装同步后的bun.lock外，全部产品文件与已验收worktree逐字节一致。

主树首次测试因缺少新增的web-tokenizers与chevrotain依赖，在收集阶段失败；补齐依赖后统一回归通过。冻结锁安装另发现继承的两个file依赖解析记录缺失，常规bun install --ignore-scripts完成16个包安装，未执行安装脚本。相对于worktree锁文件仅补充neuro-book-contracts和owned-process到本地neuro-book-test-support的两个file解析记录，没有外部依赖版本升级；该锁文件元数据修正保留在主树。

此前只读诊断已证实会话160/161/162正常返回4146/9687/4649字符，但冻结输出策略要求content标签，最终请求与回复均无该标签；离线回放均提取失败，适配层将失败转为空正文，触发首次生成加两次重写。原始输出仍保留。未获单独修复指示，本次按已验收改动集成，不自动修改用户预设或加入解析兜底。
