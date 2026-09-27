---
capabilities:
  - state:local
  - env:global
  - env:portal
---

# DialogWindow

非模态可拖动窗口，modelValue 控制显示。size=workbench 与设置弹窗共用约82%视口宽高，首次居中，小屏留出边距；默认content尺寸用于按内容调整的小工具。可显式传入width（像素）、height和maxHeight。页面型窗口在缩放和拖动时约束到视口内，保证右侧关闭按钮可达；自定义高度时沿用标题栏可再次抓取的垂直边界。

标题栏固定，bodyClass 决定内容滚动，存在footer插槽时显示固定底部操作。header可替换标题内容，default承载主体。title/closable控制标题与关闭按钮；busy阻止关闭，closeOnEsc控制Escape。request-close携带close-button或esc，存在监听者时等待宿主处理，否则更新modelValue。保留用户拖动后的位置，不在数据刷新时复位。不提供遮罩、模态焦点陷阱或业务保存。

窗口尺寸和拖动由宿主浏览器监听驱动，Escape监听在隐藏或卸载时释放。Teleport默认进入主题宿主以继承配色，可指定其他现有目标；不存在时不创建备用容器。业务加载、禁用表单和错误内容由调用方传入。
