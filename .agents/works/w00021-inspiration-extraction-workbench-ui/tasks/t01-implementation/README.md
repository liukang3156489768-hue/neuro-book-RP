---
schema: nbook.task/v2
taskId: t01-implementation
---

# A 到 E 实现

## 目标与范围

完成作品提取工作台布局与分块预览迁移、素材选块、大纲切分模式、旧入口与旧 Profile 清理，以及级联菜单错位修复。历史旧提取数据按提案清理，已保存 lorebook 条目保留；混合会话保留原创消息。

## 非目标

不处理原创设计既有问题、写作助手原作读取、真实模型验收、数据库迁移、发布和工程基础设施。

## 当前状态

实现已完成（2026-10-02）。主要验证：

- `bun run --cwd packages/neuro-book test server/inspiration/service.test.ts server/inspiration/storage.test.ts server/inspiration/extraction/structure-service.test.ts server/inspiration/outline-structure.test.ts server/inspiration/extraction/material-pipeline.test.ts server/api/inspiration/extraction/routes.test.ts app/components/novel-ide/inspiration/InspirationWorkbenchDialog.contract.test.ts app/components/novel-ide/inspiration/extraction/extraction-views.test.ts app/composables/useInspirationExtraction.test.ts`：8 个文件、84 个测试通过。
- `bun run typecheck`（`packages/nb-ui`）：通过；级联菜单全量组件测试 119 个通过。
- `bunx vue-tsc --noEmit -p .nuxt/tsconfig.app.json`：本次文件无错误；仓库既有 `web-tools.ts` 的 `jsdom`、`turndown`、`turndown-plugin-gfm` 缺类型声明仍存在。
- server `tsc` 按本 Work 路径过滤无错误；未过滤输出仍有仓库既有错误。

未完成的证据：本轮没有真实模型验收，也没有取得桌面宽屏、390×844 和主题切换的浏览器走查记录；这两项按提案另行安排或补充人工验收。
