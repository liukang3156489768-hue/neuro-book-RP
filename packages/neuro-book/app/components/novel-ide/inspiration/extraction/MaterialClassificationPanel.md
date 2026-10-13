---
标签: ["state:local"]
---

# 实体归类

素材提取的所有分块完成后暂停在这里：同一个人物、势力等实体可能被不同分块用不同名字记成了多个“文件夹”。你可以勾选其中同类别的几个把它们归为一个，系统会把疑似同一实体的候选标出来供参考，但绝不自动合并，因为同名异人、通用称呼都会造成误合并。

## 布局

自上而下：说明文字；疑似同一实体的候选（每条是原因加“选中这几项”）；各类别的实体列表，每个文件夹一行复选框，附别称、出现的分块号和独立的“查看详情”按钮；详情在行内展开，按分块展示已提取的字段、P 来源，以及角色经历和关系片段；已建立的分组列表（每组有“拆开”）；底部是“合并所选”“确认归类并继续”“跳过归类”。`390×844` 下各区块纵向堆叠，列表自身可滚动。

## 交互

- 勾选同一类别的至少两个文件夹后，“合并所选”才可用；跨类别的勾选不能合并，按钮旁提示原因。
- 已并入分组的文件夹不能再勾选；“拆开”会让它们重新变成独立实体。
- “选中这几项”只勾选候选里还没有分组的文件夹，之后仍需点“合并所选”确认，不会自动合并。
- “确认归类并继续”上报当前所有分组；没有分组时等同于“全部保持独立”。“跳过归类”上报跳过，所有实体保持独立。
- “查看详情”只展开当前文件夹的详情，不改变复选框或归类分组；父组件轮询刷新同一份实体清单时，已勾选状态保持不变。
- 鼠标点击复选框不主动移动滚动位置；键盘导航仍可正常获焦和切换，避免多层滚动容器把列表跳到末尾。

## 数据

```ts
type ClassificationGroup = {category: string; folders: string[]};
type ClassificationFolder = {key: string; name: string; aliases: string[]; blocks: number[]; preview?: {
    fragments: {block: number; role: "main" | "experience" | "relationship"; fields: Record<string, string>; citations: {firstParagraphId: string; lastParagraphId: string}[]}[];
}};
type Props = {
    classification: ClassificationView;
    busy?: boolean;
};
type Emits = {
    (event: "submit", groups: ClassificationGroup[]): void;
    (event: "skip"): void;
};
```

没有 slots 和 expose。文件夹以服务端给出的 `key` 标识，显示名取 `name`。

## 状态

- 没有任何实体：显示空状态，只保留“确认并继续”。
- `busy`：仅归类提交正在进行时按钮转圈并锁定复选框；分类数据加载完成后的任务启动收尾不再阻止勾选。
- `preview` 缺失或没有片段时，详情区域显示“暂无可展示的提取详情”。

## 不支持

不支持把一个文件夹拆成多个，也不能跨类别合并；拆分请在后面的待写入清单里做。
