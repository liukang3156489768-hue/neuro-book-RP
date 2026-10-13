---
标签: [state:local, state:inject]
---

# SummarizerSettingsView

全局配置中的摘要模型与运行策略区段。视图编辑 `modelValue` 以及可选的全局运行策略草稿；候选来自配置快照里的已启用模型，空值表示沿用摘要 Profile 或全局默认模型。运行策略复用 Agent Profile 的摘要与上下文压缩合同，空字段表示继承系统默认值。Provider、API 地址和密钥由 Provider 区段统一管理，本组件不创建连接。

```ts
type Props = {
    modelValue: string | null;
    enabledModels: EnabledModelOptionDto[];
    runtimeDefaults?: ProfileRuntimeSettingsDraft | null;
    runtimeEffective?: ProfileRuntimeSettingsDto | null;
    runtimeSources?: ProfileRuntimeSettingsSources | null;
    runtimeErrors?: ProfileRuntimeSettingsErrors;
    disabled?: boolean;
};

type Emits = {
    (event: "update:modelValue", value: string | null): void;
    (event: "update:runtimeDefaults", value: ProfileRuntimeSettingsDraft): void;
};
```
