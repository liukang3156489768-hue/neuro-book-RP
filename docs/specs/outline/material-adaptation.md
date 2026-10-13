---
schema: nbook.spec/v1
kind: behavior
status: planned
capability: outline.material-adaptation
owners:
  - outline-planning
  - agent-runtime
---

# 规划素材运用与改编

## 目标与非目标

规划助手与专家按需运用提取角色、物品、地点和笔记，支持剧情改编和结构改编，并维护方案独立的改编记录。不创建角色、物品、地点，不修改基础资料，不实现共享素材库、向量检索或正文写作。

## 术语与参与者

原作资料为只读参考；改编记录为当前方案计划。角色基础人设用于行为边界，原作经历用于动机和成长原因，原作关系用于关系机制。用户确定创作目标；规划助手负责定位、筛选和委派；专家在既有授权范围内产出规划与关联记录。

## 输入与前置条件

创作方式是会话初始合同：新建会话时选择原创或改编，首条消息后锁定。原创先检查 lorebook 类别是否存在；改编先从带 `source-extraction` 依据的方案中选择来源，再检查素材类别。改编起点由领域入口一次创建新方案、总纲、第一卷和第一章，避免连续写入留下半成品。

会话绑定 ready Project。原创/改编创作方式与讨论/自动授权方式独立。每次任务明确当前目标方案；改编章节明确来源方案，以及一个来源章节或两个有序来源章节之间的区间。原作章号、改编章号和稳定条目 ID 不混用。定位含糊时提问，已明确的信息不重复询问。

关联素材为当前项目真实存在的角色、物品、地点主文件；缺失对象先提示设计工作台创建。来源章节必须属于来源方案，改编目标属于不同方案。保留项与变化项由用户目标确定，不以固定比例替代。

## 输出与可观察行为

素材概览只提供对象名称、主文件与相关文件路径、两类笔记的索引入口，支持分页，不预读正文。所选文件的标题与来源随正文读取返回。角色依任务读基础、相关经历与关系；写作手法和素材先读对应索引，再读相关正文。长文件分页并明确未读部分，不能声称已完整读取。

规划前按需读取原作和当前改编、相邻章节及依赖条目，检查人物动机、知识、关系、资源和地点状态，以及事件因果和伏笔顺序。委派传递素材路径、目标方案、来源定位与变更约束。

规划条目保存稳定来源锚点，当前顺序使用既有方案关系，不依据数字推断。关联新信息在以下目录按方案保存，每份记录关联其规划条目：

- `lorebook/character/<对象>/改编中的新经历/<planId>/`
- `lorebook/character/<对象>/改编中的新人际关系/<planId>/`
- `lorebook/item/<对象>/改编中的内容/<planId>/`
- `lorebook/location/<对象>/改编中的内容/<planId>/`

不写对象主文件或原作经历、关系；改编信息不能冒充基础设定修改。受影响的范围外章节先报告，不静默修改。

## 状态与转换

讨论仅产生建议。经既有授权保存相关规划时同步创建或修订其记录；再次编辑替换同条目记录，移除关联信息时撤下相应记录，避免矛盾旧版本。已有非空关联计划的条目修改或分叉正文时，必须显式提交核对后的关联计划，或明确清除；省略则拒绝，不能只刷新旧记录版本冒充同步。仅改标题或采用状态可以保留记录。记录是计划，不因采用大纲而转为已发生。方案间数据隔离，改名不改变稳定定位。

## 副作用与数据

规划与同步改编文件由规划领域统一管理，版本校验、备份恢复、历史和撤销涵盖整批文件。记录关联方案和规划条目，保留方案名称及来源信息供阅读。普通编辑未传新字段保持原值；涉及正文修改时遵守上述关联计划同步前提。不迁移历史文件。

同一提案的预览与确认提交使用相同的新增对象身份、文件路径和内容；预览包含上游修改导致的细纲与线路失效，以及对应改编记录的同步变更。版本过期时重新读取并预览，不以旧预览覆盖新状态。

## 失败与恢复

未知方案、非法来源、缺失对象、基础路径写入、越界路径和过期版本均拒绝且不落盘。相关规划与记录提交失败时回滚，发生外部冲突时明确报告，不覆盖新版本。取消和迟到响应遵守既有 Project 生命周期。嵌入服务与真实模型不参与本能力的存储验证。

## 边界与兼容

限制覆盖规划助手及三个专家，并由服务端执行，旧会话不能继续通过通用 lorebook 写入口修改基础文件。现有其他 Profile 的素材设计权限不受影响。大纲读取继续走规划工具，lorebook 读取走受控素材工具；新增字段可选，旧数据保持可读。

## 验收与 Smoke

- Given 新对象或已有基础资料写入请求，Then 拒绝并提示设计工作台，源文件保持原样。
- Given 两方案复用同一角色，Then 新经历与关系分别保存，读取当前方案不混入另一方案。
- Given 保存或修改带关联新信息的规划，Then 记录随规划创建或替换，撤销恢复两者。
- Given 原作第 3、4 章间插入原创章节，Then 原作第 4 章仍按稳定 ID 定位，与新方案显示第 4 章不同。
- Given 模糊改编位置，Then Agent 询问来源章或区间；明确位置后按需读取原作和已有改编。
- Given 两类 note 素材很多，Then 先读索引筛选，再读所选正文，不自动加载全部内容。
- Given 文件提交中断或版本变化，Then 不留下成功规划与不一致记录，不覆盖外部修改。

## 证据

- [已接受提案](../../proposals/outline-material-use-and-adaptation.md)
- [实现 Task](../../../.agents/works/w00018-outline-planning-module/tasks/t12-material-use-and-adaptation/README.md)

实现入口：[受控素材工具](../../../packages/neuro-book/server/agent/tools/planning-material-tools.ts)、[改编记录领域](../../../packages/neuro-book/server/outline/adaptation.ts)、[规划操作工具](../../../packages/neuro-book/server/agent/tools/planning-tools.ts)、[工作台](../../../packages/neuro-book/app/components/novel-ide/outline/OutlineWorkbenchDialog.vue)。

合同测试：[事务与来源位置](../../../packages/neuro-book/server/outline/adaptation.test.ts)、[真实预览／保存／撤销](../../../packages/neuro-book/server/agent/tools/planning-adaptation-tools.test.ts)、[真实 HTTP 同步维护](../../../packages/neuro-book/server/api/projects/outline/material-adaptation-http.contract.test.ts)、[素材分页与方案隔离](../../../packages/neuro-book/server/agent/tools/planning-material-tools.test.ts)、[Profile 接入](../../../packages/neuro-book/server/agent/profiles/outline-specialist-profiles.test.ts)、[关联信息表单](../../../packages/neuro-book/app/components/novel-ide/outline/OutlineLibraryPanel.test.ts)。

已实现受控读取、来源锚点、权限收窄、事务关联记录、当前方案创作方式与人工同步核对。聚焦测试覆盖这些程序合同；真实模型对素材的选择质量、改编质量和语义冲突发现能力尚未验收，本 Spec 保持 `planned`，不把规则载入和 Mock 通过等同于实际模型效果。
