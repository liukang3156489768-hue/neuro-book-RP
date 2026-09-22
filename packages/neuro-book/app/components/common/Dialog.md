---
capabilities:
  - state:local
  - state:inject
  - env:global
  - env:portal
---

# Dialog

模态弹窗提供标题、内容和底部三个插槽，通过 modelValue 受控显示。xl 和 full 页面型窗口与设置共用尺寸：桌面宽高约为视口的82%，窄屏宽度留出24px边距，最大高度留出24px边距；内容区域可收缩并滚动，标题和底部操作保持可见。sm/default/md/lg 为按内容高度的短表单和确认框。显式 width/height/maxHeight 可覆盖预设。

title、closable、showHeader/showFooter、showCancel 控制默认外观，headerClass/bodyClass 允许领域宿主管理内部布局。busy 阻止关闭与确认；closeOnOverlay/closeOnEsc 控制遮罩和键盘关闭。点击遮罩需按下和抬起均发生在遮罩自身。

关闭先发 request-close（overlay/cancel/close-button/esc）；存在监听者时由宿主决定后续，否则更新 modelValue 并发 cancel。确认存在监听者时仅发 confirm，否则默认关闭。无业务数据、加载或错误请求；异步和脏草稿由宿主处理。未提供完整焦点陷阱。

header/default/footer 插槽承载业务内容，footer 暴露 confirm/cancel 操作。语言来自应用注入。默认 Teleport 到主题宿主以继承主题变量，可指定其他目标或关闭 Teleport；目标不存在时不承诺备用主题容器。可见时注册 Escape 监听，隐藏/卸载时释放。组件不读取或写入业务配置。
