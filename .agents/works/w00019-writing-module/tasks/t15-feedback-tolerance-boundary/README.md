# t15：字数容差与场景边界收紧

## 背景

用户进行真实调用测试后反馈三个问题与两个优化建议：

**问题**：
1. 写作进度卡片在包含大量文字时占满整个页面，需要折叠功能。
2. 写手产出越界（写入下一场景）和写作指导重复。
3. 大纲规划 Agent 找不到模板文件（`outline-templates.md`、`detail-annotations.md`）。

**优化建议**：
1. 助手的两个模式（场景规划、审阅）改为按需加载，并增加整章编写模式的预留。
2. 增加整章编写能力（暂不实现，预留接口）。

## 用户决策

- 问题 1：增加折叠功能。
- 问题 2：放宽字数限制到 ±70%（下限 70%，不限上限）；收紧场景边界，严禁提前展开下一场景剧情，但允许结尾铺垫以确保衔接。
- 问题 3：确保大纲规划 Agent 能正确读取模板。
- 优化 1：按任务类型分片加载助手提示，包括整章模式预留。
- 优化 2：整章模式暂不实现，在工作流中预留位置。

## 实施方案

### 1. 字数容差调整（70% 下限）

- `server/writing/materials.ts`：`WORD_TOLERANCE` 改为 `0.7`，增加 `WORD_LOWER_BOUND = 0.7`；`withinWordTolerance` 改为下限检查。
- `server/writing/structures.ts`：`judgeScene` 的字数问题改为"字数 X，目标约 Y 字，未达到 70% 下限"。
- 测试：`materials.test.ts`（500/1500 true，499 false）、`structures.test.ts` 消息更新。
- Spec：`collaboration.md`"字数口径"改为"场景只要达到目标字数的 70% 即通过，不限上限；整章字数不足细纲总览目标字数的 70% 时登记提示"。

### 2. 场景边界收紧

- `server/writing/structures.ts`：`SCENE_OUTPUT_REQUIREMENT` 第二条改为"严格遵守场景边界：只写到本场景的结尾落点，严禁提前展开下一场景的剧情。允许在场景结尾铺垫下一场景以确保衔接流畅，但不得写出下一场景的具体事件和冲突。"
- `assets/workspace/.nbook/agent/profiles/builtin/writing.assistant.profile.tsx`：
  - `renderSceneReviewMode` 增加："严格检查场景边界：产出必须只写到本场景的结尾落点，严禁提前展开下一场景的剧情。如果产出写出了下一场景的具体事件、冲突或推进了下一场景的情节，判定为不通过。场景结尾的铺垫和过渡是允许的，但不能包含下一场景的实质内容。"
  - `renderScenePlanningMode` 写作手法补充增加去重说明："细纲指定的写作手法（techniques）已由程序摘录并会直接传给写手，你不要重复提及或摘录这些内容；只在确有需要时从写作指导文件中补充"怎么写"，且补充内容不得与细纲指定的手法重复。"
- Spec：`collaboration.md` 结构 B 第 9 项、结构 C 通过判定更新。

### 3. 助手模式分片

- `assets/workspace/.nbook/agent/profiles/builtin/writing.assistant.profile.tsx`：
  - 拆分 `context(ctx)` 为基础提示 + 模式片段 + 尾部，从 `ctx.payload.kind` 选择模式：
    - `renderBasePrompt`：能力边界与资料工具。
    - `renderScenePlanningMode`（plan-scenes）：场景规划字段。
    - `renderSceneReviewMode`（review-scene）：审阅判定规则。
    - `renderRewritePlanningMode`（plan-rewrite）：改写字段。
    - `renderRewriteReviewMode`（review-rewrite）：改写审阅。
    - `renderChapterPlanningMode`（plan-chapter，预留）："预留接口，暂未启用"。
    - `renderChapterReviewMode`（review-chapter，预留）。
    - `renderFooter`：问题登记与退回规则。
  - `PayloadSchema` 增加 plan-chapter、review-chapter 预留（`additionalProperties: true`）。
- Spec：`collaboration.md` 增加"### 助手模式"一节，说明四种模式与预留。

### 4. 整章模式预留

- `server/writing/writing-workflow.ts`：已有 `WritingGranularity = "scene" | "chapter"` 类型与注释，`execute` 中已拒绝 chapter 模式（"整章编写模式尚未启用，请按场景写作"）。
- Spec：`collaboration.md` 增加"### 整章写作模式（预留）"一节。

### 5. 大纲规划 Agent 模板引用修复

当前问题：
- `assets/workspace/.nbook/agent/profiles/builtin/outline.planner.profile.tsx` 的 `HistorySet` 只导入 `SKILL.md`。
- `outline.detailed.profile.tsx` 导入 `SKILL.md` + `outline-templates.md` + `detail-annotations.md`。
- `SKILL.md` 中链接这两个模板时，Agent 尝试 `read` 文件路径，解析到项目根下，找不到文件。

修复方案：
- 在需要模板的 Profile（`outline.planner`、`outline.detailed`，检查 `outline.outline`、`outline.foreshadowing`）的 `HistorySet` 中用 `<Message><Import path="assets/workspace/.nbook/agent/skills/novel-outline-planning/references/outline-templates.md" /></Message>` 显式导入模板文件。
- 更新 `SKILL.md`，说明模板已加载在上下文中，不要用文件路径 `read`。
- 检查 llmlint/profile 投影测试。

### 6. 写作进度卡片折叠（问题 1，待实现）

暂未实施，留待用户确认具体交互后再实现。

## 当前状态

2026-10-01 进行中：
- 已完成：字数容差 70%、场景边界文本、助手模式分片（包括 plan-chapter/review-chapter 预留）、`collaboration.md` 更新（字数口径、结构 B/C、助手模式、整章预留）。
- 验证：materials.test 通过，writing 模块全部测试通过。
- 待完成：大纲规划 Agent 模板引用修复、Work README 更新、最终报告。
