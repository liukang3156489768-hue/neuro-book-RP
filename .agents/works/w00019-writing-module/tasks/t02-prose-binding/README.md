---
schema: nbook.task/v2
taskId: t02-prose-binding
---

# 正文绑定与章节状态

## 目标与范围

按 [writing.prose-binding](../../../../../docs/specs/writing/prose-binding.md) 建立正文与写作方案章节的对应关系。后续的写作工作流、问题回流和写作界面都通过它判断章节能不能写、写没写、依据是否过期。

要交付：

1. **作品写作设置**：`nbook.writing-settings/v1`，含写作方案与文风文件，支持读取和修改。
2. **正文文件头 `writing` 字段**：`nbook.writing-source/v1` 的解析与写入。写入只改这个字段，保留文件头其余内容与正文。
3. **章节状态派生**：按方案层级顺序列出各章状态，另列未关联正文。
4. **手动关联与解除**：两者都幂等。
5. **正文文件创建**：卷目录按需创建，同名追加序号，不覆盖已有文件，失败时不留半成品。
6. **依据写入**：供写作工作流调用。
7. **HTTP 接口**：只读概览、切换写作方案、设置文风、关联、解除关联。

## 非目标

- 写作工作流、正文追加、改写，属于切片 5 和 6。
- 文风文件正文解析，属于切片 3；本片只校验文风文件的类型与子类型。
- 写作界面，属于切片 7。
- 迁移旧 `manuscript/` 数据，以及读取或修改旧 Plot 的 `chapter:` 字段。

## 现状与落点（从代码推断）

- `manuscript/` 下的正文章节是内容节点目录，正文在其中的 `index.md`，类型由 frontmatter `type` 或路径推断（`server/workspace-files/workspace-files.ts`）。
- 带历史的写入包装在 `server/workspace-history/tracked-workspace-files.ts`。`.nbook/` 不进入历史，所以写作数据放在项目根的 `writing/` 下，与 `outline/` 一样可在历史中撤销。
- 章节可写性与当前依据复用 `readWriterChapterDirectory` 与 `WriterChapterBasis`（t01）。
- 新模块放在 `server/writing/`，HTTP 走 `server/api/projects/writing/[...segments].ts`，对外 DTO 放在 `shared/dto/writing.dto.ts`。

## 验证

- 聚焦测试覆盖 Spec 验收条目中不依赖写作工作流的部分：卷目录创建、`source` 一致性、依据过期、大纲回到草稿后灰显、不在线路上也可写、归属冲突、改标题不移动文件、切换方案后进入未关联。
- 另测：非法 `writing` 字段、方案不存在、同名追加序号、关联与解除的幂等、写入保留文件头其他字段，以及 HTTP 请求校验与错误映射。
- 应用 `typecheck` 通过。
- 完成后在 Spec 中补“实现合同”。

## 当前状态

- 2026-09-29：登记，开始实现。
- 2026-09-29：完成。Spec 已补“实现合同”，含卷目录标记 `nbook.writing-volume/v1` 这一格式扩展。
  - 验证：`bunx vitest run server/writing server/api/projects/writing server/outline` 共 22 个文件、179 个测试通过；应用 `typecheck` 通过。
  - 未验证：Nuxt 真实请求与浏览器行为。

## 授权与限制

见 [Work](../../README.md)：在主工作区实现，不提交，不做远端写入；不写入规划、线路、伏笔或 `lorebook/`。
