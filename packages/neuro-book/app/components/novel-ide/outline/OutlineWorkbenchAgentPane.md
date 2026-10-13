---
标签: ["state:local", "io:read", "io:mutate", "io:stream", "env:timer"]
---

# OutlineWorkbenchAgentPane

大纲工作台的规划会话宿主。展示消息、会话历史、审批与输入，允许分别选择原创／改编创作方式和讨论／自动执行方式。每条规划消息携带发送时的目标方案 ID 与创作方式，恢复旧会话后也以当前工作台选择为准。聊天气泡仅显示用户原话，模型与会话历史保留任务上下文；乐观消息和恢复历史使用相同的局部展示投影。

## 布局

头部固定显示会话状态和历史入口，中部消息或历史列表伸缩并滚动，底部输入与审批固定。创作方式占输入卡片内的独立行，两种方式保持相同尺寸；模型、思考、温度和执行方式保留在下方可换行工具条。窄栏中工具条换行，正文在自身可用宽度内收敛。

## 交互

发送按钮或 Enter 提交，Shift+Enter 换行。运行时发送按钮改为停止；等待审批时由确认面板替换输入卡片。创作方式控件复用键盘可操作的互斥选择组件，运行或等待确认时禁止切换。改编空状态提供结构改编、剧情改编和插入原创章节的起始提示；来源和章节位置由 Agent 在不明确时询问。

## 数据

```ts
type Props = {
    projectRoot: string | null;
    planId: string | null; // 当前目标方案的稳定 ID；无方案时为 null
    creationMode: "original" | "adaptation"; // 受控，由宿主持久化
    mode: "discuss" | "auto";
    modelKey?: string;
    temperature: number;
    thinkingEnabled: boolean;
    modelOptions: readonly {value: string; label: string}[];
    workbenchSession?: Pick<OutlineWorkbenchSession, "state" | "loading" | "commit">;
};
type Emits = {
    (event: "update:error", value: string | null): void;
    (event: "update:settings", patch: OutlineWorkbenchPatch): void;
};
```

无 slots 或 expose。未声明 attrs 按 Vue 默认规则透传到单根容器；不直接参与命令注册。

## 状态与边界

无消息时显示与创作方式对应的起始提示。项目偏好加载或会话创建期间禁止发送。请求失败显示可恢复的错误，提交审批失败保留回答。项目切换停止旧流并清除内存会话绑定，项目各自保存的会话不被删除。素材读取与改编保存由 Agent 工具执行，组件不创建素材，不根据章节序号猜测来源或绕过服务端权限。

上下文压缩时在头部下方显示旋转指示、整理资料／摘要阶段、真实批次和耗时，沿用输入区停止入口。完成后显示压缩前后 token 及单独的摘要用量和缓存指标。重连恢复同一运行的状态，结束或切换会话后不会保留进行中动画。

## 隐藏通道理由

本组件拥有规划会话生命周期，通过专用 composable 调用会话 API、恢复消息、订阅 SSE 并管理重连计时器。请求入口在 composable 的 API adapter 处可替换；设置持久化由父宿主通过 `update:settings` 执行，会话历史由传入的工作台会话接口保存。暂不把流式会话迁移到工作台外壳。
