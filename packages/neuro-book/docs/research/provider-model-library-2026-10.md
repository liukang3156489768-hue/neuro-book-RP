# Claude、GPT 与 Gemini 模型资料补充记录

日期：2026-10-10。状态：六个指定型号已加入本地模型资料快照；完成导入配置回归，未进行真实模型连接验证。

## 资料与验证边界

本次按用户指定范围补充六个型号。当前 `@earendil-works/pi-ai` 0.80.6 的内置目录中均不存在这些精确 ID，导致仅返回 ID 的发现结果缺少能力参数，需要用户逐项填写。

参数来源为当日读取的 [models.dev 公开目录](https://models.dev/api.json) 中 `anthropic`、`openai`、`google` 的模型记录。这是第三方汇总，不能视为官方参数核验或服务商可用性证明。

尝试访问 OpenAI 模型文档时返回 403；Anthropic 文档重定向至地区不可用页；Google 文档请求超时。因此本次未核实官方的最新价格、思考档位、账号开放范围及各网关限制。

| 模型 ID | 显示名称 | 上下文 tokens | 最大输出 tokens | 目录发布日期 |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | Claude Opus 5 | 1,000,000 | 128,000 | 2026-07-24 |
| `claude-opus-5-5` | Claude Opus 5.5 | 1,000,000 | 128,000 | 2026-09-22 |
| `gpt-6.1-sol` | GPT-6.1 Sol | 1,050,000 | 128,000 | 2026-09-29 |
| `gpt-6-astra` | GPT-6 Astra | 1,050,000 | 128,000 | 2026-09-04 |
| `gemini-3.7-flash` | Gemini 3.7 Flash | 1,048,576 | 65,536 | 2026-08-13 |
| `gemini-3.8-flash` | Gemini 3.8 Flash | 1,048,576 | 65,536 | 2026-09-02 |

六个记录均标记支持推理和文本、图片输入。第三方目录还列出了 PDF，Gemini 还列出了音视频；本项目当前通用模型配置仅登记文本和图片，不因此声明其他输入已接通。用户所称的“GPT 6.0 Astra”采用目录中的精确 ID `gpt-6-astra`，不额外创造 `gpt-6.0-astra` 别名。

## 采用方式与维护

实现位于 [模型资料补充快照](../../server/models/model-library-supplement.ts)，由 [模型库](../../server/models/model-library.ts) 合并。快照只补 SDK 缺失的精确 ID；以后升级 SDK 时，同 ID 的 SDK 资料优先。应用运行期间不为此访问外网，现有其他型号资料保持 SDK 原值。

可在配置中心的 Provider 管理中通过“从 Model Library 添加”搜索并导入。若“发现/添加模型”的返回结果仅包含精确 ID，现有候选补全流程也会使用这份资料补齐能力。网关提供的明确参数优先；接口协议沿用当前 Provider 或远端声明，不能因为模型名称而覆盖网关协议。模型库支持某个 ID 不代表当前 Provider 支持该型号或所有协议。

思考档位不从第三方目录推断。快照采用 `off: null`，避免向尚未核实支持关闭思考的新型号主动发送关闭参数；其他档位使用现有 SDK 协议适配器。该取舍不承诺可完全关闭推理，也不承诺任何新增档位已可用。Claude Opus 5 系列沿用现有 Anthropic adaptive thinking 适配。价格、鉴权、请求头和网关兼容项继续由用户 Provider 配置拥有。

已保存模型不会被此更新自动改写。需要应用新参数时，用户可显式从模型库补全或重新添加模型并保存；运行期仍只读取保存后的配置。网关返回非标准别名时不能模糊匹配，应使用其实际 ID 并核实参数。

验证入口：[模型库测试](../../server/models/model-library.test.ts)、[候选补全与导入测试](../../app/components/novel-ide/settings/sections/providers/provider-model-draft-factory.test.ts)、[Provider 模板测试](../../server/models/provider-template-library.test.ts)、[运行期元数据测试](../../server/agent/harness/pi-model-metadata.test.ts)。覆盖资料完整性、精确 ID 唯一性、不同 Provider 协议保留及远端参数优先；不替代真实服务商连通性验证。
