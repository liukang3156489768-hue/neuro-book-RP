---
capabilities:
  - state:local
  - state:shared-read
  - state:inject
  - io:read
  - io:mutate
  - env:timer
---

# Agent Profile 模型设置

## 布局

面板在设置宿主提供的内容区内显示标题、反馈、Profile 导航和参数表单。大屏由宿主分配可用高度，标题固定，导航列表和参数表单独立滚动；面板不定位到宿主内容区之外。390×844 时导航与表单纵向排列，由设置内容区整体滚动，标题、作用域和保存操作仍归设置弹窗管理。

## 交互

搜索并选择 Profile，或返回默认设置；编辑模型、运行参数和 Profile 专属配置。默认 Profile、继承来源、覆盖数量及未保存标记随草稿更新。重置参数改变本地草稿，重置 Profile home 经确认后请求服务端。按钮和输入控件使用原有键盘交互，面板不抢占初始焦点。

## 数据

可选 scope 默认为 global，project 表示当前作品覆盖；可选 targetQuery 指定工作区，targetLabel 用于说明当前目标。无外部 slots 或 emits。向设置宿主公开 dirty、loading、saving、saveSettings 和 restoreSettings，由宿主显示保存/恢复入口。

## 状态

加载时显示进度提示；失败显示局部错误；保存成功显示反馈并更新草稿基线。没有 Profile 时保留默认设置和空列表提示。保存和 home 重置期间禁用相应重复动作。切换作用域或工作区重新加载；卸载时停止编译状态轮询。

## 不支持

不拥有弹窗尺寸、一级分类或作用域切换，不在切换 Profile 时自动保存，不测试真实模型连接。

## 隐藏通道理由

这是现有 Profile 配置宿主，直接经 useConfigApi 读取配置快照、Profile 设置与编译状态，保存全局/项目配置并请求 home 重置；请求与草稿基线目前共同位于此组件。novel-ide store 的 workspaceKind 决定全局默认 Profile 的 novel/userAssets 分支。语言与确认框由应用注入。编译期间定时刷新状态，卸载时释放定时器。
