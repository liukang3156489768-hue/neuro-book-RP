---
schema: nbook.task/v2
taskId: t12-material-use-and-adaptation
---

# 规划 Agent 素材运用与改编

## 目标与授权

2026-10-03 开发者要求先保存讨论文档，再实施已确认的优化。合同见 [outline.material-adaptation](../../../../../docs/specs/outline/material-adaptation.md)；产品决策见 [Proposal](../../../../../docs/proposals/outline-material-use-and-adaptation.md)。

复用本 Work；继续当前主工作区已授权开发链路，依赖 w00020 的未提交提取与规划实现，不复制第二份执行树。保护既有修改，不提交、不做远端写入、真实模型或真实用户作品写入。

## 范围与验证

交付受控素材概览/分页读取、运行期素材运用规则、独立创作方式与当前方案上下文、稳定来源章节锚点、对象基础资料只读、按方案改编记录与规划同步维护。聚焦临时项目测试覆盖路径与对象权限、方案隔离、来源位置、同步编辑/回滚/撤销、Profile 和工具接入；UI验证新增创作方式控件与上下文。

共享库、向量检索、正文模块、历史文件搬迁和此前延后的类型声明修复不在本轮范围。

## 当前状态

文档先于实现保存。已完成受控素材工具、四个运行期 Profile 及共享指南、当前方案创作方式、稳定来源锚点、按方案关联记录、同事务维护与人工编辑核对。独立复核发现并修正预览随机身份漂移、预览漏掉依赖失效、正文修改保留旧关联信息三项缺口。伏笔建议和修复兼容显式关联信息维护。未提交或远端写入。

## 验证证据

- 领域定向回归覆盖 format、library、fork、host、storage、publish-policy、source-extraction、adaptation；新增 creation-seed 合同覆盖所有规划创建操作，正文同步守卫覆盖编辑与分叉。相关测试均通过。
- `planning-material-tools.test.ts`：3 项通过，实际临时 ready Project 验证目录发现、索引入口、长行分页和方案读取隔离。
- `material-adaptation-http.contract.test.ts`：5 项通过，真实 H3/TCP 验证四类记录创建、修改、显式清除、未知对象与遗漏同步维护拒绝。
- `outline-specialist-profiles.test.ts` + `planning-specialist-tool.test.ts`：24 项通过，Profile 权限与实际指南渲染、最新委派上下文兼容。
- `planning-tools.test.ts` + `specialist-write-tools.test.ts`：16 项通过，审批合同和旧直接写入拒绝。
- `outline-planner.black-box.test.ts`、伏笔工具合同及伏笔修复 HTTP 回归通过；`planning-adaptation-tools.test.ts` 4 项通过，验证预览与落盘哈希相同、预览不写盘、撤销涵盖关联记录、细纲依赖失效及伏笔建议同步维护。
- UI 偏好／会话／消息投影等 6 文件 32 项通过；关联信息表单和 LibraryPanel 2 文件 33 项通过，含真实 Vue 组件交互、自动保存与分叉维护。
- `bun run --cwd packages/neuro-book system-assets:prepare` 成功：30 个 Profile 中重新编译 4 个变更 Profile，未强制同步用户安装资产。
- App 类型检查本轮诊断已修正，仅剩已延后处理的 `web-tools.ts` 三个第三方模块类型声明错误。Server 类型检查仍有仓库原有测试 fixture/schema、隐式类型等诊断；本轮新增生产入口无诊断，不声称全量检查通过。
- `bun run docs:check` 保持已有 6 个失败：三个 outline 笔记缺 Spec frontmatter，inspiration-workbench Spec 三个证据标签／链接问题。本轮文档未增加失败。

## 验证边界

测试使用隔离临时项目，不调用真实模型，不修改用户小说。真实模型的素材筛选、角色运用、改编及冲突判断质量尚未验收，Spec 保持 planned。

浏览器验收未完成。当前用户应用 3000 端口未监听；隔离 Vite + 独立 headless Edge fixture 的入口、主模块和 Vue 转译返回 HTTP 200，导航 commit 成功，但模块未执行，页面保持空 app，30 秒内未出现控件；关闭自动依赖发现后现象相同。未取得真实交互、几何或计算样式证据，不能以组件测试代替。已关闭本次创建的 Edge/Vite 并清理本次系统临时根，未连接用户浏览器。待应用重新启动后补普通 UI 代表状态走查。

遗留单文件角色 `.md` 可以作为参考读取；新关联记录要求对象目录已有 `index.md`，不自动改造旧数据。基础资料不变，计划记录明确为尚未发生。外部手改记录会触发 CAS，拒绝静默覆盖，正常维护通过规划条目的关联信息完成。
