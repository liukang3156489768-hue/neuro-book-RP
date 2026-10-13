---
标签: [state:local, state:inject]
---

# TavernPresetEditorFixture

酒馆原生编辑器的独立确定性舞台。草稿由 Lab 的 modelValue 输入控制，所有更新与预览、导出记录为 Lab 事件。预览返回固定消息结构，导出只记录内容，不调用真实 API 或模型。舞台填满可用宽高并独立滚动；手机尺寸由 Lab 视口决定。
