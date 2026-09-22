---
capabilities:
  - state:local
  - state:inject
  - state:shared-read
  - state:shared-write
  - io:read
  - io:mutate
  - env:global
  - env:portal
---

# 工作区工具抽屉

## 布局与交互

圆角工具面板包含作品切换、当前分类工具栏、可滚动的文件/角色/剧情区域。桌面宽度受控，允许拖拽至280–560px。窄屏由页面将面板放入覆盖抽屉，内部宽度不超出宿主；关闭按钮始终可达，名称明确。关闭发出 close，显示与动画由页面负责。无活动标签不渲染内容。

## 数据与状态

必填 props 为 activeTab、width、workspaceTitle、workspaceItems；userAssetsMode 默认为假。width 仅通过 update:width 回传；openHome、switchWorkspace、openWorldEngine 交由页面执行。用户资产模式显示资产同步入口，隐藏作品专属内容。没有 slots。

上传、下载、资产同步使用各自忙状态禁用重复操作；下载前显示确认弹窗，资产冲突支持明细和差异查看；失败使用统一通知。作品内容为空时由相应领域面板展示空态。上传与同步不提供额外的只读模式。

## 隐藏通道与边界

这是现有工作区传输及资产同步宿主，通过 novel-ide store 执行保存后下载、上传文件/目录/zip、同步系统资产、读取同步冲突；相应请求仍由 store 所有，不新增 API。为保留既有传输与冲突生命周期，本次外观调整未搬迁宿主职责。语言和通知来自应用注入。拖动监听随组件释放；确认/差异弹窗沿用公共 Dialog 的应用浮层目标和主题继承。

组件不负责项目 ready 事务、文件保存冲突的最终决策或 Agent 会话创建。
