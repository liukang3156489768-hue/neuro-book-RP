---
标签: ["state:local", "state:shared-read", "state:shared-write", "state:inject", "io:read", "io:mutate", "io:stream", "env:timer"]
---

# AgentChatSurface

主 Agent 聊天宿主，管理会话选择、历史恢复、实时消息、审批、输入草稿与附件；由受控侧栏视图展示消息和操作。它在项目切换时隔离旧请求与实时流，支持抽屉或工作台两种承载布局。

## 布局与交互

会话头部、流式消息、审批与输入区构成可伸缩纵向区域。工具面板与会话弹窗通过侧栏视图装配，窄栏中的指标自然换行。发送、停止、会话选择、历史分支、附件与审批沿用各受控子组件的键盘合同。

上下文压缩状态单独显示在侧栏上方：运行时显示旋转指示、真实阶段、已完成批次与耗时；结束后显示前后 token 和独立摘要输入、输出、缓存及费用，不混入主请求累计指标。停止仍通过既有停止操作执行。

## 数据

```ts
type Props = {
    active: boolean;
    layout: "drawer" | "workbench";
    novelId: string;
    projectReadyRevision?: number | null;
    historyInboxRefreshKey?: string | number;
    selectedFilePath?: string;
    openReference?: (target: string) => void;
};
type Emits = {
    (event: "close"): void;
    (event: "open-reference", target: string): void;
    (event: "open-history-inbox"): void;
};
```

无 slots；未声明 attrs 按单根组件默认规则透传。既有 expose 接口供工作台转发聊天与 Inline AI 操作。

## 状态与边界

实时流丢包或换代时通过 recovery 恢复；压缩进行中状态只对其所属活动运行有效，旧运行的事件不得替换新运行状态。运行终止时清除尚未结束的压缩动画，切换项目或会话时恢复各自状态。API 失败通过既有错误与通知入口展示，不修改用户原始消息。

## 隐藏通道理由

本宿主持有 IDE store、会话 API、SSE 与恢复计时器，负责把产品数据投影为受控视图 props；持久化草稿和会话记忆沿用既有存储适配入口。
