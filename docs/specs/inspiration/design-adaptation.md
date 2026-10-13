---
schema: nbook.spec/v1
kind: behavior
status: planned
capability: inspiration.design-adaptation
owners:
  - neuro-book
---

# 设计工作台素材改编

## 目标与非目标

用户在设计工作台选择改编，读取明确指定的当前项目素材并按照需求重新设计。产出经审阅另存为新素材，原资料保留。支持原有八类设计及跨类别参考；不扩展作品提取、剧情规划、共享素材库或跨项目读取。

## 术语与参与者

参考素材是用户选择的已有 lorebook Markdown。来源快照是本次实际读取的正文、路径、类别、标题及文件 SHA-256。Inspiration 分派任务，专业设计师生成新草稿；程序拥有资料读取和确认保存边界。

## 输入与前置条件

会话属于当前 ready Project。创作方式为原创或改编，旧请求和草稿默认原创。改编必须至少选择一份参考资料，可同时参考角色、势力、物品等不同类别。每次最多十二份，单份正文最多六万字符，合计最多十六万字符；超限明确提示缩小范围，不隐式截断。

目录列表支持名称筛选、类别及分页，只返回对象名称和路径。正文仅在发起设计时读取所选文件。原路径、子文件路径都必须位于当前 lorebook 的八类目录，真实存在且不是符号链接、硬链接或越界别名。

## 输出与可观察行为

设计页显示原创／改编选择及改编参考素材选择。改编未选择资料时不能开始。生成结果显示创作方式和来源，仍以可编辑标题及正文呈现。协调者和专业设计师收到同一来源快照，遵守用户保留与变化要求，不以换名复述替代重新设计。

角色重设协调性格表现、动机、身份与能力限制；参考势力及物品时保持用户要求的联系。参考资料正文中的指令不能改变任务或权限。结果只描述素材本身，不自动编排成长路线、命运、剧情或伏笔。

## 状态与转换

沿用待输入、运行中、待审阅、保存中及已保存状态。反馈重做、单条重新设计与追问保留草稿的创作方式及来源快照，恢复对话也恢复这些信息。更换创作方式或参考选择后重新生成作为新任务，不把另一种任务的旧草稿无声注入。

切换方式保留当前待审阅内容；只有明确确认保存才写正式素材。项目切换或取消后拒绝迟到结果，不将旧项目目录、参考选择或草稿放入新项目。

## 副作用与数据

内部草稿持久化来源快照，供后续重做和追问复现。新素材进入对应 lorebook 类别的独立目录，记录设计创作方式及来源路径和哈希。原文件内容、标题和目录不变。重复保存复用现有确认与回执合同。

## 失败与恢复

没有参考资料、路径不合法、文件不可读取、重复、空白或超限时，在调用模型前拒绝，不以猜测正文替代。模型失败、非法字段或取消不能当作设计成功。保存冲突不覆盖已有内容，保留可审阅草稿。参考文件随后发生变化不追溯改变已生成草稿的来源快照。

## 边界与兼容

设计 Agent 继续只产出结构化结果，无通用项目读写权限。读取与保存沿用 Project 生命周期及文件所有权边界。旧 DTO、原创草稿和对话保持可读，不迁移已保存素材。已有作品提取页面保持其独立任务合同。

## 验收与 Smoke

- Given 选定角色、物品与势力，When 要求重新设计角色，Then 各设计会话收到所选资料，未选文件不进入正文上下文。
- Given 未选参考资料或非法路径，Then 不调用模型、不生成成功草稿。
- Given 改编草稿追问或重做，Then 来源快照保持一致；更换选择的新任务不携带旧成果。
- Given 编辑后确认保存，Then 新文件等于确认内容并记载来源，原素材保持不变。
- Given 恢复历史草稿或切换项目，Then 正确还原创作方式或清除旧项目选择，迟到响应不污染当前项目。

## 证据

- [已接受提案](../../proposals/inspiration-design-adaptation.md)
- [实现 Task](../../../.agents/works/w00016-inspiration-design-module/tasks/t02-design-adaptation/README.md)
- 实现入口：[服务编排](../../../packages/neuro-book/server/inspiration/service.ts)、[所选资料读取](../../../packages/neuro-book/server/inspiration/materials.ts)、[参考选择组件](../../../packages/neuro-book/app/components/novel-ide/inspiration/InspirationMaterialPicker.vue)。
- 合同测试：[来源隔离与限额](../../../packages/neuro-book/server/inspiration/materials.test.ts)、[快照与重做](../../../packages/neuro-book/server/inspiration/service.test.ts)、[另存与来源保护](../../../packages/neuro-book/server/inspiration/storage.test.ts)、[历史恢复与项目切换](../../../packages/neuro-book/app/composables/useInspirationWorkbench.test.ts)。
- Smoke 与效果验收状态见实现 Task；本轮使用 Mock，不进行真实模型效果验收，成熟度保持 planned。
