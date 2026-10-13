---
标签: ["state:local"]
---

# 写作大纲树

写作界面左栏的章节树：按写作方案的层级列出卷、章节大纲、细纲与正文，末尾是“未关联正文”分组。每章标出服务端给出的写作状态、不可写原因和问题徽标，点徽标就地展开问题列表。与文件树不同，这里的节点对应大纲条目与章节正文的归属，大纲条目只读，不能新建、删除、改名或拖动；关联、解除关联和忽略问题都只发出意图，由宿主执行。

## 布局

- 卷行：展开箭头与卷名，右侧是章节数。
- 章节行：展开箭头、章节标题、状态徽标、问题徽标；运行中的章节多一个“写作中”标记。不可写的章节整行灰显，原因写在标题下方。
- 展开后的章节：细纲（一份或多份），然后是正文节点。没有正文时是“正文（未写）”；归属冲突时列出每一份正文并各带“解除关联”。
- 问题列表：展开在章节行下方，每条问题有级别、状态、说明和操作。
- 未关联正文：每个文件一行，下方是原因、关联目标选择与“关联”“解除关联”。

标题都允许换行，操作按钮在窄屏下换行，`390×844` 下不产生横向滚动。

## 交互

- 点卷行或章节的展开箭头：展开或收起。
- 点章节标题、细纲、正文或未关联正文：发出 `select`；点章节标题同时展开这一章。
- 点问题徽标：展开或收起这一章的问题列表。
- 问题的“在大纲工作台中打开”发出 `open-outline`，目标是问题所在的细纲或章节大纲；未处理或待复核的提示、阻断问题均有“忽略”。
- 未关联正文选好目标章节后点“关联”；目标只列尚无正文的章节。

## 数据

```ts
type Props = {
    /** null：还没有可用的写作方案，只显示未关联正文 */
    groups: readonly WritingVolumeGroup[] | null;
    unlinked: readonly WritingUnlinkedProseDto[];
    /** 可关联的目标：尚无正文的章节 */
    linkTargets: readonly {value: string; label: string}[];
    issues: ReadonlyMap<string, WritingChapterIssuesDto>;
    /** 当前选中项的键，见 selectionKey */
    selectedKey: string | null;
    /** 收起的卷；未关联正文分组的键为 "unlinked" */
    collapsedVolumes: ReadonlySet<string>;
    expandedChapters: ReadonlySet<string>;
    /** 正在写作或等待确认的章节 */
    runningChapters: ReadonlySet<string>;
    /** 宿主正在执行写入，写入类按钮禁用。默认 false */
    pending?: boolean;
};

type Emits = {
    select: [selection: WritingSelection];
    "toggle-volume": [key: string];
    "toggle-chapter": [entryId: string];
    link: [path: string, chapterEntryId: string];
    unlink: [path: string];
    "ignore-issue": [chapterEntryId: string, issueId: string];
    "open-outline": [entryId: string];
};
```

以上全部受控。没有 slots，没有 expose，attrs 透传到根元素。

## 状态

- 空数据：方案里没有章节时显示一句说明；`groups` 为 null 时不显示这句，方案状态由宿主提示；未关联正文为空时不显示该分组。
- 写入中：关联、解除关联和忽略禁用，选择与展开照常。

## 不支持

- 不显示已解决和已忽略的问题。
- 不推断章节状态，只显示传入的结果。
- 不支持拖动排序和键盘方向键导航；各节点是普通按钮，用 Tab 移动。
