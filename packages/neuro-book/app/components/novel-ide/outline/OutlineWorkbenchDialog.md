---
标签: ["state:local", "io:read", "io:mutate", "env:global"]
---

# OutlineWorkbenchDialog

全屏大纲规划工作台宿主，连接项目工作台偏好、规划快照和当前方案选择。左侧规划会话与右侧大纲库、伏笔库、线路规划共同使用当前项目，向规划会话明确传递当前目标方案和原创／改编方式。

## 布局

左侧 Agent 栏可拖动调整宽度，默认随视口比例求值且不超过中线；右侧规划视图伸缩，列表和详情各自控制滚动。工作台占满窗口，不增加外层滚动。窄屏沿用现有全屏分栏；本组件暂不承诺移动端折叠导航，见已知偏差。

## 交互

切换视图、方案或刷新更新右侧内容。Agent 设置保存到当前项目的工作台记录，旧记录没有创作方式时显示原创且不自动回写。打开时的 focus 请求先刷新快照再定位条目及方案；关闭发出 `update:modelValue`。对话框的焦点与关闭行为由既有 Dialog 承载。

## 数据

```ts
type Props = {
    modelValue: boolean; // 受控打开状态
    projectRoot: string | null;
    projectTitle?: string;
    surface: WorkbenchLayoutSurface; // 已签发的项目存储上下文
    focus?: Readonly<{entryId: string; planId: string | null; token: number}> | null;
};
type Emits = {(event: "update:modelValue", value: boolean): void};
```

无 slots 或 expose。未声明 attrs 按 Vue 默认规则透传到 Dialog；不直接参与命令注册。

## 状态与边界

加载由工作台统一忙状态呈现，偏好保存失败和规划读取失败提供诊断与重试。快照中没有所选方案时回落到首个方案，没有方案时向 Agent 传 null。项目切换重新选择有效方案。这里只传当前目标，不推断来源章、改编冲突或领域状态；服务端必须核验 ID。

## 隐藏通道理由

本宿主通过工作台数据 composable 获取领域快照，通过可注入 adapter 的工作台 session 读取和写入 Project/local 偏好；配置读取用于列出可用模型。视口 resize 与拖拽监听属于分栏尺寸所有权，卸载时解除。

## 已知偏差

现有全屏分栏保留左栏 220px 最小宽度，390px 视口中右栏空间受限；本轮仅添加左栏内的固定尺寸创作方式控件，不改整套窄屏导航。
