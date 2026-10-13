---
标签: ["state:local"]
---

# 划卷编辑

大纲提取的第二步：把章节划分成若干卷。识别出章节的来源按“章序号范围”划卷，没有章节的来源按“每卷包含几块”划卷。组件只编辑草稿；是否合法由服务端判定，宿主把校验结果通过 `error`、`checking`、`valid` 传回来实时显示。

## 布局

章节模式：一行一卷，包含卷名、起始章、结束章和删除按钮，下方是“添加一卷”和“恢复默认划分”。字数模式：一个“每卷块数”输入，旁边说明共有多少块、预计分成多少卷。底部是校验状态行：校验中、通过（绿色）或服务端给出的错误原因（红色）。`390×844` 下每卷的三个输入换行，仍然一卷一块，不出现横向滚动。

## 交互

- 修改任何输入立刻上报新的草稿，由宿主延迟向服务端校验；组件不做区间合法性判断，错误文案原样展示服务端说明。
- “添加一卷”以上一卷结束章的下一章作为新卷的起点，终点留空待填。
- 最后一卷不可删除到零卷：只剩一卷时删除按钮不可用。
- “恢复默认划分”上报 `restore`，由宿主换回系统建议的划分。

## 数据

```ts
type VolumeDraft = {title: string; first: string; last: string};
type Props = {
    mode: "chapters" | "chunks";
    /** 章节模式的章数，用于提示可填范围 */
    chapterCount: number;
    /** 字数模式的块数 */
    chunkCount: number;
    volumes: VolumeDraft[];
    chunksPerVolume: string;
    /** 服务端（或本地必填检查）给出的说明，空串表示没有问题 */
    error?: string;
    checking?: boolean;
    /** 草稿已通过服务端校验 */
    valid?: boolean;
};
type Emits = {
    (event: "update:volumes", volumes: VolumeDraft[]): void;
    (event: "update:chunksPerVolume", value: string): void;
    (event: "restore"): void;
};
```

没有 slots 和 expose。草稿用字符串保存序号，是为了让输入框中间状态（清空、半截数字）不被强行改写。

## 状态

- 校验中：状态行显示“正在校验划分…”。
- 通过：状态行显示“划分有效，共 N 卷”。
- 没有草稿：章节模式显示“尚无划分”，鼓励点“恢复默认划分”。

## 不支持

不在这里设置卷的概要，也不预览每卷的章节标题；卷纲由提取任务生成。
