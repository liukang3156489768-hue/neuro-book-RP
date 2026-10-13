---
标签: ["state:local"]
---

# 写作中间页

写作界面里点左栏大纲条目或尚无正文的“正文”节点时，盖在编辑区上的中间页。它对条目只读，按大纲工作台的样式显示正文，并给出“在大纲工作台中打开”入口；对尚无正文的章节显示“这一章未写”，可写时提供“开始写作”。与大纲工作台里的条目表单不同，这里没有任何编辑能力：修改规划只能回到大纲工作台。

## 布局

顶部一行是层级标签、条目标题和操作（“在大纲工作台中打开”、关闭）；下面是可滚动的只读表单。尚无正文时只有居中的空状态。`390×844` 下顶部操作换到标题下方，表单沿用条目表单自己的窄屏规则。

## 数据

```ts
type Props = {
    /** 受控；entry 为条目只读页，empty-prose 为尚无正文的章节 */
    view:
        | {kind: "entry"; entryId: string; entry: WritingEntryDto | null; loading: boolean; error: string | null}
        | {kind: "empty-prose"; chapter: WritingChapterDto};
};

type Emits = {
    /** 在大纲工作台中打开这个条目或这一章的章节大纲 */
    "open-outline": [entryId: string];
    /** 尚无正文且可写时点“开始写作” */
    "start-writing": [chapterEntryId: string];
    /** 条目读取失败后点“重试” */
    retry: [entryId: string];
    close: [];
};
```

没有 slots，没有 expose，attrs 透传到根元素。

## 状态

- 载入中：还没有旧内容时显示 `role="status"` 的载入提示；刷新同一条目时保留旧内容。
- 出错：`role="alert"` 显示原因和“重试”。
- 章节不可写：空状态说明原因，不给“开始写作”。

## 不支持

- 不编辑条目，不新建、删除或移动条目。
- 不显示伏笔标记的状态；伏笔属于大纲工作台。
