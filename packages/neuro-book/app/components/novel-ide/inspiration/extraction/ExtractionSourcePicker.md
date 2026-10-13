---
标签: ["state:local"]
---

# 提取来源选择

“作品提取”页顶部的来源选择条：从项目 `reference/` 的作品文件里选一个，作为大纲提取与素材提取共同的来源。组件只负责展示列表和上报选择，读取列表、准备来源都由宿主完成。

## 布局

一行：来源下拉框、刷新按钮。下方是来源体积说明；来源有切分警告或读取出错时，各用一条提示条显示在说明下方。`390×844` 下下拉框独占一行，刷新按钮跟在它后面换行。

## 交互

选择一项即上报 `update:modelValue`；选择空项表示取消选择。点击刷新上报 `refresh`，读取中刷新按钮显示加载并禁用。

## 数据

```ts
type Props = {
    sources: Array<{path: string; name: string; bytes: number}>;
    /** 当前选中来源的路径，空串表示未选 */
    modelValue: string;
    loading?: boolean;
    /** 读取列表或来源失败的说明 */
    error?: string;
    /** 来源切分时给出的提醒 */
    warnings?: string[];
};
type Emits = {
    (event: "update:modelValue", path: string): void;
    (event: "refresh"): void;
};
```

没有 slots 和 expose。

## 状态

- 没有来源文件：下拉框占位文字提示把作品放进 `reference/` 目录。
- 读取中：刷新按钮转圈。

## 不支持

不上传文件，不浏览 `reference/` 之外的路径，也不在这里预览来源正文。
