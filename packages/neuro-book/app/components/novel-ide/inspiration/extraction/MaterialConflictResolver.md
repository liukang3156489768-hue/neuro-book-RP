---
标签: ["state:local"]
---

# 同名冲突处理

确认写入前发现 lorebook 里已有同名文件时，逐个条目对照新旧内容，由你选择“覆盖”“另存为”或“跳过”。没有表态的条目默认跳过，写入前不会动任何文件。

## 布局

每个有冲突的条目一张卡：标题、节点类型和目标文件路径；卡内左右两栏（窄屏上下两栏）分别是“现有文件”（标注来自你的设计还是以往提取）和“即将写入”；底部是三选一的分段控件，选“另存为”时出现新名称输入框。顶部有说明，底部是“按所选处理并写入”“返回清单”。

## 交互

- 默认选择“跳过”；选择“另存为”必须填新名称，否则“按所选处理并写入”不可用，并提示缺少哪一项。
- 现有文件是你设计的、而当前不允许覆盖时（`overwriteAllowed` 为 false），“覆盖”选项不出现，并说明原因。
- 同一条目有多个节点冲突时，一个条目只做一次决定，对该条目所有冲突节点生效。
- “返回清单”放弃本轮处理，不写入任何文件。

## 数据

```ts
type ConflictDecision = {itemId: string; action: "overwrite" | "save-as" | "skip"; saveAsName?: string};
type Props = {
    conflicts: ConflictComparison[];
    busy?: boolean;
};
type Emits = {
    (event: "confirm", decisions: ConflictDecision[]): void;
    (event: "cancel"): void;
};
```

没有 slots 和 expose。决定里不带确认者，服务端按调用来源固定为用户。

## 状态

- `busy`：确认按钮转圈，控件不可用。
- 冲突列表为空：不渲染任何内容（宿主不会在无冲突时挂载它）。

## 不支持

不支持逐字对比和合并两份内容；需要合并请先“另存为”，再到 lorebook 里手工整理。
