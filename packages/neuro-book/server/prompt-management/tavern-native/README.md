# SillyTavern 原生宏编译器

来源为 [SillyTavern](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/macros)，固定版本、源文件 SHA-256 见 `UPSTREAM.json`；上游及本项目采用 AGPL-3.0-or-later，完整许可证见仓库根 `LICENSE`。

lexer/parser/walker/registry/engine/flags 保留上游实现。修改仅包括 `.mjs` 导入路径、正式 Chevrotain 包入口、`SillyTavern.getContext` 替换为编译作用域变量接口；core 的输入框、chat 的首条显示消息 DOM 查询由显式元数据代替。浏览器诊断替换为不输出提示词内容的收集器。

相邻的 `tavern-legacy.mjs` 使用同一固定版本的旧宏 evaluator/helpers 和变量宏表，切片来源见 `UPSTREAM.json`。旧引擎保留类别 pass 与非递归语义；两个引擎仅共享宿主数据与变量操作，不互相模拟语法。

`host.mjs` 是宿主边界：人物、变量和历史来自写手绑定；无浏览器全局或插件执行。一次编译捕获时间、时区、locale 和随机种子；无时区日期按冻结 offset 解析，duration 采用同一 locale，不修改进程全局设置。pick 使用原生哈希及 seedrandom；random 与 droll 使用编译作用域 RNG，冻结后重试不重新抽取。droll 使用安装版本的解析器及相同骰子算法，拒绝超过十万颗骰子的调用。原生语法/参数警告仍按上游保留字面文本；宿主缺失能力明确失败。adapter 支持逐宏 postProcess，以实现查找正则的原生转义模式。

人物示例使用固定版本 `public/script.js` 的 OpenAI 分支格式化，相关宿主函数指纹同样登记在 `UPSTREAM.json`。world-info outlet、Text Completion instruct、插件宏不属于当前宿主；首条显示消息 ID 需要显式绑定。不能提供的数据不伪造为已兼容。
