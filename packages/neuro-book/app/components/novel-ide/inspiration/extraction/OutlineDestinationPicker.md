---
标签: ["state:local"]
---

# 大纲数据去向选择

对同一来源再次提取大纲时，选择结果放到哪里：新建提取方案、补充已有方案或覆盖已有方案。组件只展示服务端给出的可选项并上报选择，不判断某个选项是否真的可用。

## 布局

一列卡片。第一张永远是“新建提取方案”。其后每个已有方案一张卡：标题是方案名，下面是“补充”“覆盖”两个切换按钮，说明文字分别解释它们的效果；不可用的选项按钮置灰，卡内用提示条给出原因（例如来源文件已变化，只能新建）。`390×844` 下按钮在卡内换行。

## 交互

点击按钮即上报新的选择；当前选中的按钮高亮并带 `aria-pressed`。选择“覆盖”不会立刻改动任何内容：提取完成后会先展示新旧对比，经确认才覆盖。

## 数据

```ts
type DestinationChoice = {kind: "new"} | {kind: "supplement" | "overwrite"; planId: string};
type Props = {
    options: Array<{
        planId: string;
        planTitle: string;
        canSupplement: boolean;
        canOverwrite: boolean;
        /** 不可用的原因 */
        reason: string | null;
    }>;
    modelValue: DestinationChoice;
    disabled?: boolean;
};
type Emits = {
    (event: "update:modelValue", choice: DestinationChoice): void;
};
```

没有 slots 和 expose。

## 状态

- 没有已有方案：只显示“新建提取方案”一张卡。
- `disabled`（任务运行中）：所有按钮不可用。

## 不支持

不提供合并两个方案，也不允许选择不是由同一来源提取出的方案。
