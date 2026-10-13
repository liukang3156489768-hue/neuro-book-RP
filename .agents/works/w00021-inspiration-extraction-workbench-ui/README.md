---
schema: nbook.work/v1
workId: w00021-inspiration-extraction-workbench-ui
issueId: null
---

# Inspiration 作品提取工作台优化

## 目标与授权

承接已接受的 [作品提取界面优化提案](../../../docs/proposals/inspiration-extraction-workbench-ui.md)，落实 A 到 E：沿用旧入口的分块预览与选块形式、统一分块边界、素材选块、大纲切分方式、下线旧入口与旧提取资产、修复 nb-ui 级联菜单定位。

开发者已授权本地源码修改、聚焦测试和浏览器走查；真实模型验收、数据库迁移、提交、推送、PR、发布与远端写入不在本 Work 授权内。其余已记录问题另开批次。

## 执行位置

当前主工作区已有 w00020 与其他 Work 的未提交实现，沿用主工作区继续实现，不清理、不覆盖其他文件改动。当前 Work 只修改本方案涉及的文件。

## 合同与任务

- Proposal：`docs/proposals/inspiration-extraction-workbench-ui.md`
- UI：`docs/specs/ui/inspiration-workbench.md`
- 大纲：`docs/specs/inspiration/outline-extraction.md`
- 素材：`docs/specs/inspiration/material-extraction.md`
- Task：`tasks/t01-implementation/README.md`
- 2026-10-04 追加：[t02 大纲任务管理与文档修复](tasks/t02-outline-task-management/README.md)。
- 2026-10-05 追加：[t03 大纲提取模板合同与截断重试](tasks/t03-outline-extraction-contract-fix/README.md)。

## 当前状态

2026-10-02：已完成 A 到 E 的本地实现。作品提取页使用共用块预览；素材任务支持 `blocks` 并在服务端按选块生成单元；大纲预览支持显式章节／字数模式；旧入口、旧 Profile 与旧 DTO 路径已清理；旧会话与草稿在首次列出会话时幂等清理；nb-ui 级联菜单子面板已 Teleport 到 body。已保存 lorebook 条目不参与清理。真实模型验收另行安排，浏览器走查尚未取得本轮自动化证据。

2026-10-03：根据素材提取验收反馈补充归类详情投影与 UI 行内详情展开；复选框选择状态按实体结构保持，详情按钮与复选框事件隔离。角色提取流程改为先粗读发现、再按角色逐块提取，相关 Mock 回归和组件测试通过。

2026-10-04：[t02](tasks/t02-outline-task-management/README.md) 完成大纲任务列表、新建/切换/删除与迟到结果隔离，管理控件位于模型旁，与素材同位置。已写入的大纲成果保留。40 项聚焦回归、全应用类型检查、真实组件的隔离浏览器交互及 390px 布局验证通过；模板规范元数据已修复，两份废弃标注文档归档，docs:check 无阻断失败。真实模型与完整项目宿主由开发者后续验收。
