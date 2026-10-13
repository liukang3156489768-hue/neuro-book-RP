---
标签: [state:local, state:inject]
---

# ProfileRuntimeSettingsFields

受控的 Agent 运行策略编辑器，统一编辑自动摘要与上下文压缩设置。它只通过 props 接收草稿、继承基线和错误状态，通过 `update:modelValue` 回传字段变更；文件变更通知字段可由宿主隐藏，以便摘要设置页只呈现与摘要相关的配置。

## 数据

```ts
type Props = {
    modelValue: ProfileRuntimeSettingsDraft;
    inherited: ProfileRuntimeSettingsDto;
    sources: ProfileRuntimeSettingsSources;
    errors?: ProfileRuntimeSettingsErrors;
    disabled?: boolean;
    showFileChangeNotice?: boolean;
};

type Emits = {
    (event: "update:modelValue", value: ProfileRuntimeSettingsDraft): void;
};
```

`modelValue` 是受控草稿；空字段表示继承 `inherited`。组件没有 slots、expose 或外部请求，不读写 store 和浏览器存储。`showFileChangeNotice` 默认为 `true`，设为 `false` 时隐藏文件变更通知分组。

## 交互与状态

摘要、压缩和文件通知分组按表单字段排列。下拉选择支持继承、启用/停用和阈值类型，数值与文本错误显示在对应字段。`disabled` 时所有字段不可修改；输入变化立即通过事件回传，由宿主决定何时保存。
