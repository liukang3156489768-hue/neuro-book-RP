---
schema: nbook.task/v2
taskId: t16-detail-template-v3
---

# 细纲模板第三版

## 目标与范围

切片 14。开发者 2026-10-01 验收后认为细纲的场景字段卡片混乱、阅读体验差，给出新模板，讨论后确认：

- 细纲正文是唯一格式，界面只显示正文：
  - `# 章节总览`：章节标题、剧情概括、核心冲突、情绪基调、目标字数（必填，整章正文目标）。
  - `# 章节细纲`：下设 `## 场景N` 或 `## 场景N：名称`，编号从 1 连续。场景字段行：场景简述、字数要求、人称要求（三者必填）、情绪基调、剧情节奏；小节：`### 参与角色`（`- 角色：目的`）、`### 具体情节`（至少一条，最后一条是结尾落点）、`### 描写`、`### 写作指导`、`### 参考资料`（链接）、`### 伏笔`。
  - `### 伏笔` 每项：名称，子项标记（章节大纲伏笔标记）、状态（埋设、强化、回收）、作用、效果。标记不存在或状态与章节大纲动作不一致时阻断。写手只看到原文、状态、效果；作用只给助手审阅。
  - `# 禁止事项`：只限制情节走向（本章不能出现的情节结果），不放文风或写法限制；每个场景都带上，审阅逐条检查。
- 细纲 frontmatter 去掉 `scenes`、`perspective`、`guides`；段落标注（写作指导、段落参考）整体去掉。
- 写作一章只用一份细纲；各场景字数之和与总览目标字数、整章正文与总览目标字数都按上下 50%。
- 旧细纲不兼容，需要重新生成。

合同：[outline-entry-templates](../../../../../docs/specs/outline/outline-entry-templates.md)、[writer-handoff](../../../../../docs/specs/outline/writer-handoff.md)、[writing.collaboration](../../../../../docs/specs/writing/collaboration.md)。

## 当前状态

- 2026-10-01：完成。
  - 解析：`shared/outline-detail-structure.ts` 重写，从正文读出总览、场景字段与小节、伏笔、禁止事项，并给出阻断与提示；导出模板生成函数。`format.ts` 去掉 `OutlineGuide`、`DetailScene`、段落锚点校验与参考的 `marker`；细纲解析和写入都不再带 `writingGuidance`、`references`、`targetWords`，旧字段读取时忽略。细纲参考资料由正文派生（没有链接的项为待补）。
  - 界面：删除 `OutlineDetailScenes`、`OutlineDetailAnnotations` 及其表单工具；`OutlineEntryForm` 的细纲只留正文、“插入细纲模板”“插入场景”、结构问题列表与章节伏笔标记清单；细纲不再提供段落标注入口；交接资料表单只用于章节大纲。
  - 写作：一章多份细纲阻断；场景素材按新字段整理，具体情节逐条锁定为要素、最后一条为结尾落点；写手提示按新小节渲染，下一场景只给名称与简述，伏笔作用不进写手提示、只随审阅输入交给助手；审阅字段 `avoid` 改为 `forbidden`；整章目标取细纲总览；规划一致性容差改为 50%；工作流升为 `writing.chapter@3`，旧运行记录不可重放。
  - Agent：写作助手提示与审阅外壳更新；规划工具与 API 去掉 `guides`、`perspective`、`scenes`；`outline-templates.md` 细纲一节按新模板重写，删除 `detail-annotations.md`，四个规划 Profile 不再载入它；SKILL.md 与细纲专家职责同步。
  - Spec：outline-entry-templates、writer-handoff、planning-library、agent-assistance、outline README、collaboration、issue-feedback、workspace-ui 已更新；标注设计与性能笔记标为已废弃。
  - 验证：typecheck 通过；写作、大纲、共享、规划工具、Profile、路由与相关组件测试 1100 个通过。`server/agent/tools/file-tools.test.ts` 的 retrieval bash 用例失败，报 ripgreprc 配置路径，本次未改动相关文件。前端与真实模型未验证。
- 2026-10-01 验收追加：开发者用规划 Agent 重新生成第 1 章细纲时，Agent 无法给没有任何标记的章节大纲加第一个埋设标记。原因是 `suggest_foreshadowing_marker` 的 action 只有 strengthen、resolve、repair：strengthen 要求候选正文含 reinforce 标记，repair 要求章节已有损坏诊断，没有一条路径能新增 plant。已补 `plant` 动作（候选正文须含该伏笔的 plant 标记），同步工具说明、SKILL.md、建议合同类型与两份内部说明，补单元测试。
  - 顺带处理：交接只带已确认伏笔的标记，场景认领了草稿伏笔的标记时原先被静默丢弃；现在登记 `UNASSIGNED_FORESHADOW` 提示并定位到场景。SKILL.md 写明伏笔须先确认，标记才计入状态和写作。
  - 验证：typecheck 通过；outline、writing、规划工具、伏笔工具合同、Profile 与大纲路由测试 580 个通过。真实模型未验证。
