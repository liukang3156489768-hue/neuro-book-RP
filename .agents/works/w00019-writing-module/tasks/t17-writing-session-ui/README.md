---
schema: nbook.task/v2
taskId: t17-writing-session-ui
---

# 写作右栏控件与写手输出

开发者 2026-10-04 在浏览器验收中授权：模型设置移到输入区下方左侧；对话区域支持查看写手返回的思考内容和正文，默认折叠。

## 范围与执行位置

沿用 Work 的主工作区开发授权。调整右栏布局，补齐运行尝试与写手会话的关联，按需只读展示场景、重试和局部改写的写手输出。提示词、模型参数、写作及审阅规则不在本次范围内。

## 当前状态与验证

已实现，等待开发者真实模型验收。模型设置在底部左侧向上展开，顶部下拉采用可收缩网格列，长标题不会挤掉新建与删除。写手条目按场景、尝试和局部改写区分，默认折叠；展开后读取完整已保存内容，生成中使用已有 Agent SSE，收起或卸载时关闭连接。进度轮询替换对象不会重建同一连接，来源切换有 generation 隔离。

写手 ID 从既有运行的创建记录投影，无需重做提取或迁移运行。只读接口先验证当前项目运行包含该写手，再读取其 active path，归档后仍可查看，不读取任务模板或其他分支。常规运行轮询不携带思考全文。

验证：

- `server/writing/run-host.test.ts`、`run-service.test.ts`、`server/api/projects/writing/route.test.ts` 与既有 `WritingRunCard.test.ts`：41 项通过，包含创建即关联、重试不同 ID、改写关联、完整内容与越界读取拒绝。
- `WritingWriterOutput.test.ts`：4 项通过，覆盖默认不请求、生成订阅与完整回读、轮询不重连、收起释放、来源切换丢弃旧结果、读取失败重试和历史降级；`writing-workspace.test.ts`：8 项通过；`writing-api.test.ts`：2 项通过。API 测试原先误把 `startChapterSession` 当作写作运行入口，已按明确的运行入口检查修正。
- 应用 `typecheck` 通过（进程内存上限 8 GiB）。
- 正式 3001 页面使用浏览器拦截的 Mock 写作接口验收：9 项通过，覆盖底部模型设置、长会话标题、默认折叠、长输出滚动、两次尝试隔离、无思考说明、390px 和刷新恢复；无页面异常，写作请求全为 GET。390px 使用工作台既有控件隐藏主侧栏和底部面板后验证。
- `docs:check` 已运行，失败为仓库已有三份 outline Spec 缺失 frontmatter：`detail-writing-guide-annotation.md`、`outline-entry-templates.md`、`performance-optimization-notes.md`；本次文档无新增失败。

浏览器脚本、JSON 和截图保存在 `C:/Users/liu/.codex/visualizations/2026/10/02/01a0fb34-f114-7360-9059-8b38a269f64c/`，入口 `writing-session-ui-check.mjs` 与 `writing-session-ui-check.json`。未执行真实模型或真实作品的写作／改写验收，未提交或远端写入。

合同：[writing.workspace-ui](../../../../../docs/specs/writing/workspace-ui.md)。下一步由开发者刷新 3001 页面验收本轮 UI，并继续讨论提示词处理优化。
