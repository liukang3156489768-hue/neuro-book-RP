---
schema: nbook.task/v2
taskId: t18-detail-material-review
---

# 细纲资料补充与独立审核

## 范围与授权

2026-10-04 开发者要求先保存设计文档，再实施：提取与规划新细纲模板、共享解析、写作助手按细纲读取资料、独立审核通过后交写手。沿用 Work 已批准的主工作区执行位置，保护已有改动；不提交、不修改真实作品、不调用真实模型。

合同：[设计与模板](../../../../../docs/proposals/writing-detail-material-review.md)、[写作协作](../../../../../docs/specs/writing/collaboration.md)、[细纲模板](../../../../../docs/specs/outline/outline-entry-templates.md)。

## 当前快照

2026-10-04 实施完成，真实模型效果由后续验收确认。

- 提取、规划、共享正文解析与写手模板同步新增可选地点、角色资料引用/状态/外貌、服饰字段；旧第三版细纲仍可解析。
- 助手按细纲补充带来源的角色及情节所需资料；程序校验角色覆盖、来源定位与摘录上限。独立 `writing.material-review` 使用新的会话核验，退回后由助手修订，审核通过才交主创核对和写手；局部改写同步接入。
- 资料来源内容哈希在写手调用和正文写入前复核，变更时阻止过期产物写入。旧 workflow 记录保留，续写进入新版本并在缺新版资料时重新补充审核；旧自定义写手模板仍接收新增事实任务数据。
- 审核提示词接入全局提示词管理；模型、思考与温度默认沿用助手配置。保留原有主创核对、讨论模式确认、正文审阅与改写替换确认。

## 验证证据

- 受影响的 22 个测试文件共 199 项通过：`bun run --cwd packages/neuro-book test server/writing shared/outline-detail-structure.test.ts server/inspiration/extraction/outline-validation.test.ts server/agent/profiles/writing-profiles.test.ts server/agent/profiles/outline-specialist-profiles.test.ts server/agent/harness/model-resolver.test.ts server/prompt-management server/agent/tools/writing-tools.test.ts server/agent/tools/planning-tools.test.ts`。
- 随后增加来源在审核后/生成期间变化及局部改写资料审核连续退回的回归，重新运行 `server/writing/run-service.test.ts`，23 项全部通过；这些新增用例没有重新运行其余已通过文件。
- 最终全应用 `bun run --cwd packages/neuro-book typecheck` 通过。正式 `system-assets:prepare` 编译通过，Seed manifest 有 31 个 Profile，新审核 Profile 状态 loaded。
- 标准 `dev` 启动流程已更新本机内置运行资产，服务恢复于 `http://127.0.0.1:3001/`；只读 HTTP 验证四个写作 Profile 均 loaded，提示词目录包含 `writing.material-review`，已安装审核源码与 canonical 源一致。
- `docs:check` 仍报告既有三份 outline Spec 缺 YAML frontmatter：`detail-writing-guide-annotation.md`、`outline-entry-templates.md`、`performance-optimization-notes.md`，无本次新增失败。范围内 diff whitespace 检查还显示 `outline-entry-templates.md` 第 3 行已有 Markdown 换行空格；本轮没有改动该行。
- 本轮没有修改 UI，没有执行浏览器交互验收、真实模型调用或真实小说内容写入。Mock 验证覆盖结构、拒绝、恢复与写入门禁，不能替代真实资料选择/生成质量验收。
