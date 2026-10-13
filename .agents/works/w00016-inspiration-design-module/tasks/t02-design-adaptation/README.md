---
schema: nbook.task/v2
taskId: t02-design-adaptation
---

# 素材设计改编模式

## 目标与授权

2026-10-03 开发者要求优化设计工作台并新增改编模式，已确认结果另存新素材、原素材保留。合同见 [inspiration.design-adaptation](../../../../../docs/specs/inspiration/design-adaptation.md)，取舍见 [Proposal](../../../../../docs/proposals/inspiration-design-adaptation.md)。

复用当前 Work 及既有开发链路的主工作区例外，依赖未提交的设计与提取实现，保护其他修改。不做提交、远端写入、真实模型调用或用户作品写入。

## 当前状态

本轮实现完成。设计页提供原创／改编切换、跨八类参考选择与搜索分页；目录仅发现名称，生成时读取明确所选正文并固定快照。反馈、单条重新设计、追问和历史恢复沿用来源，变更方式或参考作为新任务。正式保存另建素材目录，仅记录来源身份，保留原文件。

主 Agent 完成来源读取、HTTP 边界、编排、存储、UI 集成和最终验证；Profile 切片完成九个运行入口并独立只读复核来源隔离与保存生命周期。读取拒绝链接、重复、非法路径、非 UTF-8、空正文和超限；打开及读取后比较文件身份，来源变化明确失败。修正成果按钮误把嵌套 Ref 对象当作运行状态的问题。

## 验证结果

- 七个直接相关测试文件共 32 项通过：`server/inspiration/{materials,service,storage}.test.ts`、`server/api/inspiration/{materials-routes,source-routes}.test.ts`、`app/composables/useInspirationWorkbench.test.ts`、工作台既有入口测试。最后改动影响的 service／composable／组件入口三文件重新验证，17 项通过。
- Profile 权限与 schema 18 项、实际安装升级编译 2 项，共 20 项通过。共计 52 项不同的定向回归，不代表全库验收。
- `bun run --cwd packages/neuro-book system-assets:prepare` 成功，编译九个变更 Profile；没有覆盖用户安装侧资源。
- 隔离 Chromium 夹具使用真实工作台、参考选择组件、composable 和 nb-ui，Config／提取页面与请求使用 Mock。真实点击验证改编、双选参考、移除、草稿显示、反馈可重做、原创切换后新任务提示和空闲成果操作按钮；1604×1247 与 390×844 均完成。窄屏 picker 左右边界 31／344px，页面 scrollWidth 375px，小于视口390px，无水平溢出、无浏览器错误。夹具及浏览器进程清理完成。
- App 和 Server 类型检查已执行：本轮诊断修复；App 仍有已知 `web-tools.ts` 的 `jsdom`、`turndown`、`turndown-plugin-gfm` 三个声明缺失；Server 仍有全仓原有测试类型等诊断，不声明全量通过。
- 文档检查已执行，本轮相关文档无错误；仍有三份原有大纲笔记缺少 Spec frontmatter。设计改编 Spec 保持 planned，真实模型输出质量未验收。

浏览器脚本、截图、输出与类型／文档日志保存在本会话显式证据目录 `C:/Users/liu/.codex/visualizations/2026/10/02/01a0fb34-f114-7360-9059-8b38a269f64c/`，文件名前缀 `design-adaptation-`。最初 Edge 访问夹具超时，最终使用本机已安装 Chromium 通过；未安装新浏览器。

本轮没有真实模型调用、用户作品写入、数据库迁移、Git 提交或远端写入。

## 2026-10-04 长追问结果布局回归

开发者验收发现，右侧连续追问返回长正文后，左侧聊天历史和右侧审阅卡一起撑高，输入区与保存操作不可达。已在隔离的真实 Vue 工作台中通过两次追问复现：可用网格高 1115px，但默认内容最小行高被撑到 16141px；两侧面板同高，`overflow:auto` 因容器随内容增长而没有产生独立滚动。

修复限定工作台网格行高，聊天与审阅面板允许缩小；消息历史、参考输入与审阅区各自滚动，消息和成果卡保持自然正文高度。窄屏上下两行在窗口内分配高度，页签和聊天标题不被压缩。只修改工作台 Vue 与伴生文档，行为合同未变，没有改动 Agent、来源、草稿或保存逻辑。

验证：1604×1247 下两侧面板保持1115px，消息历史478px、正文滚动高度15504px，审阅区正文滚动高度7476px；鼠标滚轮实际使聊天 `scrollTop` 增至2500，右侧可滚到保存按钮，设计需求仍可输入。390×844 下聊天与审阅两行约427／285px，各自滚动，输入、发送和保存均可到达，无水平溢出、无浏览器错误。原有工作台与 composable 两文件5项测试通过。证据仍在上述显式目录，前缀 `design-long-reply-`；隔离夹具与浏览器进程清理完成，未进行用户作品写入或真实模型调用。CSS 修改不改变类型表面，未重跑全仓类型检查。
