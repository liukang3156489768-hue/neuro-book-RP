# SPreset Editor 能力与写手兼容价值分析

日期：2026-10-11。状态：一手源码研究，未实施，非当前产品合同。

## 结论

本次确认的插件是 [starowo/SPreset](https://github.com/starowo/SPreset)，界面按钮及在线页面标题为 **SPreset Editor**。它包含预设编辑工作区和运行时增强两部分。对 NeuroBook 最有价值的是：用资源库组织可复用片段，分开展示顺序链与深度注入，并把宏、消息合并和预设绑定正则作为随预设携带的行为配置。

但本次发现重要版本边界：公开 Git 注入层与它动态加载的在线编辑器不完全匹配。在线界面已经配置条件脚本、工具绑定、结构化消息及输出预处理，固定 Git 注入层没有对应的新接口。必须区分“界面可以配置”“固定源码实现执行”“实际运行验证通过”三个结论。

## 来源与证据身份

| 对象 | 本次身份 | 验证边界 |
| --- | --- | --- |
| 公开插件仓库 | main，`7c4d91f548bc310d97e761becdc4026a11dc5cd7`，提交时间 2025-12-22 | 固定源码可复查 |
| manifest | display_name SPreset，author SoliUmbra，version 1.0.0 | 仅插件清单版本，不标识动态编辑器 |
| 在线编辑器 | [bundled.html](https://jnai2d9kgnbs6xzx5c.com/regex_bind/bundled.html)，2026-10-11 读取，标题 SPreset Editor | 动态资源，没有固定 Git 身份 |
| 在线文本指纹 | UTF-8 解码文本重新编码后的 SHA-256：`7bc18d2bd8c5849d366b566bff247801d736d014442413216a6428f56c53eac2`，957272 字符 | 标识本次读取内容，不是 HTTP 压缩传输字节摘要 |

仓库只有 `.gitattributes`、`index.js`、`inject.js`、`manifest.json`，没有 README。入口在 APP_READY 后加载 inject.js；inject.js 再 fetch 在线 HTML，以 iframe.srcdoc 装入编辑器。该 iframe 可执行脚本并具有同源能力，所以它依赖父页面酒馆上下文，并非独立的纯 JSON 编辑器。[清单](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/manifest.json)、[入口](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/index.js)、[编辑器加载](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L106)。

本次只读源码与在线 HTML，没有安装插件、运行远端脚本、打开酒馆交互页面或调用模型。以下 UI 能力是从打包代码和文案核实，不是浏览器实测。

## 编辑工作区能力

以下来自本次 [在线编辑器](https://jnai2d9kgnbs6xzx5c.com/regex_bind/bundled.html) 快照。由于代码已打包压缩，列出可检索字段、函数或文案作为定位依据，不伪造稳定源码行号。

| 能力 | 核实到的内容 | 价值与限制 |
| --- | --- | --- |
| 资源库 | unused 与 favorites；模板支持文件夹，搜索标题、正文或 ID，按角色筛选 | 复用片段与当前运行链分离；模板文件夹不是已证实的互斥或条件组 |
| 提示词链 | active 条目分 sequential 和 injected；显示启用数/总数，可新建、复制、移动与拖动组织 | 把顺序与深度两种位置语义分开，避免误以为 UI 上下顺序就是最终深度位置 |
| 内容编辑 | 名称、角色、正文、启用、锁定；marker/readOnly 的限制；内置条目保存保留未知字段 | 角色可视为 model，保存映射回 assistant；UI 命名不应被当成新增 API role |
| 注入编辑 | Depth、Order、injection_trigger、forbid_overrides；注入项仍在 prompt_order 中 | 比平面文本条目更贴近酒馆原始结构 |
| 条件启用 | spreset_condition_enabled 与 spreset_condition_script | 界面说明每次生成前运行，可 async，可用 model/source/provider/type/entry/chat，返回布尔值覆盖本次启用，出错禁用；对应执行不在本次固定 Git 注入层中 |
| 编辑历史 | 撤销、重做及 Ctrl+Z/Ctrl+Y；修改状态与保存状态 | 降低大量调整预设的成本，不等同模型会话分支或写作运行历史 |
| 草稿恢复 | localStorage 的 spresetEditorDraftV2，保存基线指纹，匹配条件下询问恢复 | 防止将任意旧草稿直接覆盖当前酒馆数据；未证明这是跨窗口并发锁 |
| 工作区交换 | 导出 version:7、workspace、toolBindings、messageInjections、features；导入并替换，可撤销 | 这是编辑器工作区格式，不是原生酒馆预设导出格式 |
| 保存回酒馆 | 读取/更新 prompts 和 character_id 100001 的 prompt_order；校验重复标识与绑定，保留原有未知字段 | 新绑定依赖 Bridge，缺少接口会明确拒绝；保存前后有本地回滚代码，未验证服务器持久化事务 |
| 主题与布局 | 三栏资源库/链/Inspector，明暗主题；嵌入式退出 | 适合作为交互组织参考，不影响编译等价性 |

定位点：`function Va()` 读取酒馆；`function Ua()` 转回条目；`async function Ja()` 保存；`workspace.active/unused/favorites`、`spresetEditorDraftV2`、`spreset_condition_script`、`Depth / Order 决定最终注入位置`。

界面把条件脚本、注入、工具和结构化内容放在条目 Inspector 中，这有助于让条目成为完整的配置单元。不过这些配置是否实际生效，仍取决于运行时版本。

## 固定 Git 注入层已实现的运行能力

### MacroNest：替换嵌套宏求值路径

开启 MacroNest 后，插件改写 `promptManager.preparePrompt`。它从左到右扫描花括号，以栈解析最内层宏，再调用酒馆的 `ctx.substituteParams`，用临时标记保护返回内容中的花括号，限制 MAX_STEPS 为 1000000。关闭或无正文时调用原有方法。[方法替换](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L402)、[递归解析](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L461)。

这改变宏嵌套及求值顺序，但仍借酒馆解释宏本身。没有发现它自建一个通用初始化变量表或重新定义 user/char 身份。不能把“宏嵌套”直接等同 EJS、变量管理器或完整的酒馆宏引擎替代品。

还有一个从代码推断的兼容细节：首次取得 PromptClass 时，先对同一提示调用原 preparePrompt，随后再走递归解析。对于有副作用的宏，首次执行可能多发生一次求值；本次未运行验证。兼容时需要用变量前后状态对照，不能仅抄递归函数的理想行为。

### ChatSquash：实际重写发送消息结构

插件在 CHAT_COMPLETION_PROMPT_READY 阶段保存数据，随后原地修改 `data.chat`。可合并全部消息，或从 Prompt Manager 内部集合重建并仅合并 chatHistory。[事件处理](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L942)。

已核实的配置包含：合并到 system/user/assistant 或 follow；用户、角色、系统消息的前后缀；system 到 user 的选项；停止字符串；通过字符串或正则决定不压缩部分；clewd 标记解析；自定义后处理函数。[合并选项](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L687)、[合并算法](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1025)。

这里的“合并/压缩”主要是串接文本并改变消息角色和边界，不是语义摘要。前后缀会做宏替换；合并输出主要为 role/content，原 name/tool 字段不能假定完整保留。后处理还可处理嵌入 regex 标记，并通过 eval 调用自定义函数；错误时恢复备份。[标记后处理](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1138)、[脚本后处理](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1199)。

注意这段“后处理”发生在发送提示词上，不是模型返回正文之后。插件还检查部分其他扩展监听器的函数源码，在启用 ChatSquash 时跳过匹配监听器，说明执行环境与扩展组合也会影响行为。[监听器协调](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L907)。

### RegexBinding：预设携带正则和执行顺序

功能包括新建、导入、编辑、测试、启用/禁用、导出、与全局规则互相移动、拖动排序，以及上移/下移、批量移动、反转顺序、按名称重置。批量删除按钮在本次代码中明确提示不支持，不能因界面有按钮就声明支持。[管理事件](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1322)、[批量操作](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1382)、[排序面板](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2249)。

规则保留 disabled、markdownOnly、promptOnly、runOnEdit、substituteRegex、minDepth/maxDepth 等配置，实际处理阶段借用酒馆正则机制。因此预设正则可以影响 prompt 或显示，不能统一当作输出美化。[规则保存字段](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2233)。

ST>=1.13.5 时写入预设 `extensions.regex_scripts` 并登记 `preset_allowed_regex.openai`；旧版则转成带 preset_ 前缀的全局运行规则，排在原全局规则之前。代码还迁移旧 xiaobai_ext 绑定格式；全文 reproxy 实现已注释，不能声称当前通过 Proxy 执行。[新版同步](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1575)、[迁移与同步](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1640)。

“锁定正则”存于全局扩展设置。切预设时同 ID 在原位替换，不存在的规则放到头部；保存到预设时过滤掉仅由全局锁定引入的规则。这是运行态与导出态的重要差异，单读预设 JSON 不一定得到作者实际使用的正则列表。[加载与锁定合并](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L1510)、[锁定保存](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2748)、[预设保存过滤](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2765)。

## 数据格式与新旧版本差异

固定 Git 配置主体为 `extensions.SPreset` 下的 RegexBinding、ChatSquash、MacroNest。另在 prompts 中以 identifier `SPresetSettings`、name `SPreset配置` 的 JSON 正文保留兼容副本。getPrompt 直接读取 prompts，不要求条目在启用 order 中；新增配置项默认不启用，也不自动追加 order。[配置读取](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L545)、[配置保存](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2771)、[提示项辅助方法](https://github.com/starowo/SPreset/blob/7c4d91f548bc310d97e761becdc4026a11dc5cd7/inject.js#L2800)。这种条目是配置容器，不能当普通正文发送。

在线编辑器进一步出现以下配置及接口：

| 在线配置 | 用途及证据 | 本次运行核实结果 |
| --- | --- | --- |
| 条件脚本 | 每次生成前决定条目启用，字段 spreset_condition_enabled/script | 固定 Git 缺对应执行实现 |
| toolBindings | 工具表单/代码编辑、参数 schema、同名冲突校验；SPresetToolBinding | 固定 Git 没有该接口；不证明工具已注册或可调用 |
| messageInjections | reasoning、signature、toolCalls、toolResults；SPresetMessageInjection | 固定 Git 没有该接口；不证明已发送有效工具历史 |
| forcedPostProcessing | 发送前指定酒馆后处理模式，如 merge、strict、single 及保留工具变体 | 在线界面与配置可见，执行未核实 |
| outputPreprocessing | 脚本、工具调用格式化、consumeToolCalls | 在线界面与配置可见，流式/输出执行未核实 |
| fixedPresetName | 导入原生预设成功时一次性使用目标名，不立即重命名 | 在线界面及文案可见，执行未核实 |
| SPresetEditorBridge.commitBindings | 统一保存绑定与附加功能，缺少接口时报错 | 固定 Git 没有该接口 |

定位字段都可以在本次在线 bundled.html 中检索。在线保存代码明确提示缺少新版注入脚本接口；不能把仓库 manifest 1.0.0、工作区格式 version:7 和这些新增功能统一称为一个已验证产品版本。

## 对写手三个兼容问题的回答

### 初始化变量与注入

SPreset 能帮助编辑、复用和组织含变量宏的片段，MacroNest 还会改变嵌套求值。但它不消除 ST 本体、Tavern-Helper、EJS 的变量作用域差异，也没有在本次固定源码中提供统一初始化状态机。兼容层需要识别预设依赖了哪种引擎，以及 MacroNest 是否开启。

应保存实际求值结果与变量变化；审阅、日志和恢复同一尝试不能重新跑初始化宏。对于配置副本 SPresetSettings，应按元数据读取，不能因它未启用就丢弃配置，或为了读取而把 JSON 注入模型消息。

### user 与助手身份

SPreset 不会自动把资料助手绑定为 user，也没有改变本体 user/char 宏的身份来源。助手作为资料生产者、写手上下文中的 Persona、最终消息 role 应继续分开。

消息合并会改变 API role，这也不等于改变 user 宏身份。是否将 user 绑定“创作委托方”、char 绑定“小说叙述者”，仍是小说适配层的显式决策。相关身份事实和建议见 [写手兼容研究](./sillytavern-writer-preset-compatibility.md)。

### 提示词生效与酒馆一致

如果预设依赖 SPreset，兼容原生酒馆 Prompt Manager 还不够：MacroNest、ChatSquash、绑定正则、锁定规则，以及新版条件脚本都可能改变生效结果。对照端必须带上作者实际使用的 SPreset 注入层和在线编辑器版本、配置及全局规则。

完成标准应包括宏求值前后状态、扩展处理前后消息、最终 API 请求。保存时可配置不代表执行时生效；尤其新版条件脚本，需要取得匹配注入层才能核实。

## 推荐借鉴顺序

1. **先借鉴编辑模型**：资源库、模板、顺序链、深度注入、Inspector、草稿和撤销；保留酒馆 identifier、marker、order 及未知字段，不扁平化导入。
2. **明确运行兼容范围**：按目标预设实际依赖，分别支持 MacroNest、ChatSquash、RegexBinding 与条件脚本；每项与酒馆同版本对照。未支持时报告具体依赖，不能默默忽略。
3. **加入来源与结果解释**：展示条目启用依据、宏状态、插入位置、消息合并和正则前后差异，最终以原生请求为准。这是项目可以在 SPreset 交互基础上补强的能力，不是本次已确认的 SPreset 完整执行追踪功能。
4. **按写手职责评估工具相关功能**：当前写手无工具。工具绑定与结构化工具历史不应因编辑器支持而自动接通；若目标预设依赖这些语义，需要单独定义与写手职责的兼容边界。

本次没有证据证明插件单独解决角色语义或稳定提升文学质量。它的直接价值是更好地组织预设，以及将影响发送的增强配置随预设管理。下一步可用开发者实际安装版本和目标预设建立对照样本，确认新旧接口差异后再确定实施范围。
