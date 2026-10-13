---
schema: nbook.spec/v1
kind: behavior
status: implemented
capability: ui.character-management
owners:
  - novel-ide
  - workspace-files
---

# 角色管理工作区

## 目标与非目标

按已批准 Demo 提供嵌入式三栏角色管理页面。角色资料读取与提取统一使用 `lorebook/character/`；本次重构前的旧角色产物不兼容、不迁移。

## 术语与参与者

角色 ID 和大纲方案 ID 是稳定目录身份，名称仅用于显示。基础人设共用；原作与各方案是独立资料侧面。

## 输入与前置条件

须打开一个作品。入口位于左侧固定活动栏的主入口组，默认排列在文件入口与大纲入口之间，不能被收进“更多”菜单。读取当前作品 `lorebook/character/<id>/index.md`，有效入口须包含对应 id、type: character、title；空目录不创建样例角色。

## 输出与可观察行为

角色工作台打开后暂时隐藏工作台左右侧栏，仅保留全局活动栏，三栏界面占满主要工作区；桌面左侧为搜索、标签、排序及列表/卡片，中间为基础人设、图片、正文状态，右侧为经历、关系、知识。较窄工作区使用三区域切换，每栏独立滚动。原作经历、关系、知识及状态只读；基础资料可人工编辑；各大纲方案分别维护新内容。关系只能选已有角色。

## 状态与转换

默认只读，编辑后保存或取消。离开脏草稿有保存并继续、放弃、继续编辑。保存失败保留草稿。切换作品由路由守卫处理，旧请求不得显示到新作品。

## 副作用与数据

Markdown 为唯一可信来源，数据库不是角色 owner。index.md 的 title/aliases/tags/summary/ext.character.profile/ext.character.meta.avatar 提供基础信息；编辑保留其他元数据和正文。侧面文件 original/{experience,relationships,state}.md、original/knowledge/index.md，方案为 plans/<plan-id>/ 相同文件。记录以 YAML records 表示，状态以 state 表示。读取器兼容早期提取器把记录写在正文中的文件，并可通过 `normalize-character-facets` 维护脚本在不调用模型的情况下补齐 records；新写入始终生成 records。一次保存仅修改所编辑类别，避免覆盖其他类别。图片保存至角色目录，入口只保存相对路径；选图未保存不落盘。

## 失败与恢复

无 `lorebook/character/` 显示空状态；缺入口、非法 YAML 或侧面格式错误的目录独立展示资料异常，不使整页失败。外部修改通过内容版本冲突拒绝覆盖，草稿保留，用户可放弃后刷新。文件保存失败给出局部错误；头像在基础资料保存时才写入，校验失败不会改变已有入口引用。

## 边界与兼容

仅当前作品容器内 `lorebook/character/`，不兼容旧角色产物，不删除旧数据。路径须验证稳定目录身份及真实路径 containment；原作写入在管理接口拒绝。方案必须来自当前大纲库，引用目标须为当前作品已有正式角色。

## 验收与 Smoke

已有新格式角色可搜索筛选、切换卡片；基础资料编辑保存后刷新恢复。方案 A 的知识或状态修改不改变原作与方案 B。外部改写入口后旧草稿保存失败；异常角色不影响有效角色。桌面、深浅主题、390px 无横向溢出。底层文件入口打开真实文件编辑器。

## 证据

开发者于 2026-10-07 明确批准 [角色页面提案](../../proposals/character-management-workspace.md) 的 Demo 实装。

## 实现合同

- 页面入口由 `NovelIdeActivityBar` 提供，`CharacterWorkspaceHost` 负责项目快照、请求代次、保存、头像和离开守卫；`CharacterWorkspace` 只负责三栏视图与草稿状态。
- `GET /api/projects/characters`、`PUT /api/projects/characters/profile`、`PUT /api/projects/characters/facet` 和头像 `GET` 是当前项目角色文件的唯一管理入口。头像随 profile 保存请求提交；所有写入经过工作区存储边界、项目历史记账和 mtime 条件检查。
- 服务端拒绝 `planId: original` 的侧面写入，并要求 profile 的 `id` 与目录身份一致；头像读取只接受 `character/<id>/avatar.(png|jpg|webp)`。
- `server/character/character-files.test.ts` 覆盖正式角色识别、异常目录隔离、原作/方案读取、旧 `lorebook/character/` 不读取、序列化保留未知元数据及路径安全。
- 2026-10-07 已执行 `bun run --cwd packages/neuro-book nuxt:prepare`；使用 8GB Node 堆运行 Nuxt 类型检查通过；角色定向测试 3/3 通过。

## 证据

- 实现入口：[`CharacterWorkspaceHost.vue`](../../../packages/neuro-book/app/components/novel-ide/character/CharacterWorkspaceHost.vue)、[`character-files.ts`](../../../packages/neuro-book/server/character/character-files.ts)、[`characters.get.ts`](../../../packages/neuro-book/server/api/projects/characters.get.ts)
- 合同测试：[`character-files.test.ts`](../../../packages/neuro-book/server/character/character-files.test.ts)
- Smoke：不适用——角色工作区需要项目文件与浏览器宿主，已完成 Nuxt 类型检查和文件解析器 focused test；浏览器验收由用户在正式应用中执行。
