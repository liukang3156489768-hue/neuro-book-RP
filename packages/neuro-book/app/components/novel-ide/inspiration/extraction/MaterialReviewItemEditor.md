---
标签: ["state:local"]
---

# 待写入条目编辑

编辑待写入清单里的一个条目：标题、别称，以及每个节点（基本设定、经历、人际关系）里每条记录的字段内容。组件只维护草稿并在保存时上报改动；字段是否符合模板、是否保留了来源引用由服务端判定，错误原样展示。

## 布局

自上而下：标题输入、别称输入（逗号或顿号分隔）；每个节点一个小节，小节标题是节点类型（基本设定、经历、人际关系），其内每条记录一组字段，每个字段是“字段名 + 多行输入”；底部是“保存修改”“取消”，以及服务端返回的错误提示条。`390×844` 下输入框占满宽度。

## 交互

- 任何输入只改本地草稿；“保存修改”把标题、别称与节点上报，条目 ID 由宿主在上报时带上。
- 没有任何改动时“保存修改”不可用。
- “取消”丢弃草稿并上报 `cancel`。
- 服务端拒绝保存（字段不符合模板、缺少 P 引用等）时，宿主通过 `error` 传回原因，草稿保留。

## 数据

```ts
type ReviewNode = {role: "main" | "experience" | "relationship"; entries: Array<{fields: Record<string, string>; block: number | null}>; citations: Array<{firstParagraphId: string; lastParagraphId: string}>};
type ItemPatch = {title?: string; aliases?: string[]; nodes?: ReviewNode[]};
type Props = {
    item: ReviewItem;
    busy?: boolean;
    /** 服务端对上一次保存的拒绝原因 */
    error?: string;
};
type Emits = {
    (event: "save", patch: ItemPatch): void;
    (event: "cancel"): void;
};
```

没有 slots 和 expose。只上报相对原条目有变化的部分。

## 状态

- `busy`：保存按钮转圈，输入不可用。
- `error` 非空：显示红色提示条。

## 不支持

不支持新增或删除节点与记录，也不支持修改原文引用本身；引用来自“参考片段”字段，需要改它时直接编辑该字段。
