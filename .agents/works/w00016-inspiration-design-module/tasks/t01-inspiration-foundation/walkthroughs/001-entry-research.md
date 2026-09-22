# 2026-09-20 接入调研

## 当前交付状态

已读取需求与仓库合同，登记本地 Work/Task，并创建 `docs/proposals/inspiration-design-module.md`。尚未编写产品代码、创建实现 worktree 或执行提交。开发者尚未答复本次先本地开发的流程例外和首版范围问题；不得把等待时间当作授权。

主工作区 master 基线为 `45906272`，存在用户的窗口、导航、设置、页面与文档改动；保持这些改动原样。首次登记时仅有一个 worktree、一个本地 master 分支，Work 编号到 w00015。

## 已核实入口（从代码推断）

- 左侧入口：`packages/neuro-book/app/utils/workbench-chrome.ts` 与 `app/components/novel-ide/NovelIdeActivityBar.vue`；`app/pages/index.vue` 是窗口宿主。
- 非模态窗口：`app/components/common/DialogWindow.vue`；主工作区已有未提交的 workbench 尺寸改动。
- Agent：`server/agent/harness/neuro-agent-harness.ts` 中 `createAgent` 支持 profileKey、currentProjectRoot、parentSessionId；`invokeAgent` 支持 AbortSignal 和阻塞等待结果。
- 结构化结果：消费内部 `reportResult.data` 并验证。`finalMessage` 是截断预览，公开 invocation HTTP 省略 reportResult.data，不能解析聊天预览作为完整成果。
- Profile 输出参考：`assets/workspace/.nbook/agent/profile-templates/report-agent.profile-template.tsx` 的 OutputSchema 与 builtin.result.main。原创专业 Agent 不应得到正式素材写工具。
- 读取/写入：`server/workspace-files/novel-workspace.ts` 的 resolveWorkspaceFileTarget；`project-open-guard.ts` 的 withProjectTargetOperation / withProjectTargetMutation；`server/workspace-history/tracked-workspace-files.ts` 的 createWorkspaceFileTracked / writeWorkspaceTextFileTracked。
- 路径同时受 lexical 与 realpath containment 保护，不绕过 junction/symlink 校验。保存冲突可参照 `server/api/workspace-files/write.put.ts`。
- 标准素材节点：`lorebook/<category>/<id>/index.md`，通过 `content-node-schema.ts` 的 createWorkspaceContentFrontmatterDefaults 与 `workspace-files.ts` 的 renderMarkdownDocument 生成。
- readWorkspaceTextFile 当前限制 5 MiB；长篇支持需明示限制或实现受控读取，不能无声截断。
- 当前只有通用 volume/chapter 内容节点，没有计划中的专用大纲库 DTO/API/Prisma 模型。

## 下一次恢复

先读取开发者对两项异步问题的实际答复，更新 Work 与提案的批准依据。确认本地流程例外后才创建独立 worktree；不得顺手把主工作区用户改动包含进登记提交。按获批范围补齐 Spec，委派 Tasker 实现；对模型、保存与项目生命周期边界安排独立审查。

## 验证

- `bun run docs:check`：退出码 0，5455 个文件，failures 为空。
- `bun run governance:check`：退出码 1，既存 `.agents/works/w00003-neurobook-ui-foundation-migration/tasks/t14-agent-profile-nav-lab-migration/README.md` 缺失；无本 Work 报错。不在本次范围修复旧 Work。
- 未运行产品测试、类型检查、真实模型调用或浏览器人工验收；当前仅调研与文档准备，不宣称模块已实现。
