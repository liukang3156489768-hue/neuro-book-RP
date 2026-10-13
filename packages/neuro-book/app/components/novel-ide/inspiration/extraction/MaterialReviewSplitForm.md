---
标签: ["state:local"]
---

# 条目拆分

把一个角色条目里被错误合并进来的经历或人际关系记录拆成一个新角色条目。只有角色类别有可移动的记录；其他类别的条目只有一份主文件记录，不会出现“拆分”入口。

## 布局

自上而下：新条目标题、别称输入；“要移到新条目的记录”列表，每条记录一个复选框，前面标明是经历还是人际关系，后面摘出前 60 字作为辨认；底部“拆分”“取消”按钮和服务端错误提示条。

## 交互

- 标题必填，且至少勾选一条记录，“拆分”才可用。
- 勾选的记录会从原条目移走，原条目始终保留主文件；新条目带上标题、别称和被移动的记录。
- “取消”丢弃输入。服务端拒绝拆分时通过 `error` 展示原因，输入保留。

## 数据

```ts
type SplitInput = {
    title: string;
    aliases?: string[];
    move: Array<{role: "experience" | "relationship"; entryIndexes: number[]}>;
};
type Props = {
    item: ReviewItem;
    busy?: boolean;
    error?: string;
};
type Emits = {
    (event: "split", input: SplitInput): void;
    (event: "cancel"): void;
};
```

没有 slots 和 expose。`entryIndexes` 是记录在所属节点内的序号，与服务端约定一致。

## 状态

- 条目没有经历或人际关系记录：显示“没有可以移动的记录”，“拆分”不可用。
- `busy`：按钮转圈，输入不可用。

## 不支持

不支持拆分基本设定，也不支持为新条目手工填写基本设定字段（服务端只填入名称与别称）；需要补充请拆分后再编辑。
