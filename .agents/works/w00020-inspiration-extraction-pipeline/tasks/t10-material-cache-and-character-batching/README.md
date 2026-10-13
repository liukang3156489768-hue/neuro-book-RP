---
schema: nbook.task/v1
workId: w00020-inspiration-extraction-pipeline
taskId: t10-material-cache-and-character-batching
status: completed
---

# 角色分组提取与缓存观测

## 授权范围

落实 [角色分组与缓存提案](../../../../../docs/proposals/material-extraction-cache-and-character-batching.md)：角色发现后的 A/B/C 分组、分组 JSON 校验与独立写入；重排提取请求使稳定模板位于动态角色名单之前；为素材提取日志补充任务关联和缓存用量字段；补充 Mock 回归。使用现有稳定 ID、角色目录和任务框架，不迁移旧中间产物，不调用真实模型。

## 验收证据

- 角色等级及同块分组的单元测试；
- 分组输出逐角色校验、空角色和失败重试的流水线测试；
- 提示词顺序与前缀哈希测试；
- 模型适配器日志字段和秘密脱敏测试；
- `server/inspiration/extraction` 聚焦测试通过。

## 当前实现记录

- `material-extract.ts` 新增 A/B/C 级计算、同块组队、分组 JSON 校验、按角色写入和分组失败后的单角色回退；单人组保留原有稳定单元 ID，分组单元 ID 含等级、分块和稳定键。
- `material-prompts.ts` 将角色字段模板从动态角色目标中拆出；请求顺序保持原文后先模板、再角色目标与任务要求。`repair.ts` 为请求生成稳定前缀哈希，并将修复内容追加在末尾。
- `types.ts`、`run.ts`、`model-adapter.ts` 为提取请求增加任务、单元、分块、角色组、等级和缓存 token 观测字段；日志不记录原文和密钥，模型错误也会写入带关联字段的事件。
- `extraction-catalog.ts` 登记分组角色用途及其动态变量；`material-extraction.md` 和 [提案](../../../../../docs/proposals/material-extraction-cache-and-character-batching.md) 已同步行为合同。

验证：

- `bun run --cwd packages/neuro-book test server/inspiration/extraction`：17 个测试文件、147 个测试通过；
- 聚焦回归（素材流水线、托管提示词、模型适配器）：3 个测试文件、28 个测试通过；
- `bunx tsc --noEmit -p .nuxt/tsconfig.server.json` 对 `server/inspiration/extraction`、`extraction-catalog` 无新增类型错误。

未验证：真实 DeepSeek Provider 的缓存命中率、Provider 是否返回 cacheRead/cacheWrite 字段，以及真实模型对分组 JSON 的稳定遵循；这些属于后续真实模型验收。

