---
标签: []
---

# CharacterWorkspace

角色管理的可移植领域视图，使用批准 Demo 的三栏布局。数据与保存、头像选择、文件打开和离开请求全部由 WorkspaceBindings props 提供，无 store 或网络依赖。

输入合同见 shared/dto/character-workspace.dto.ts。默认只读，基础资料和当前方案可编辑，原作资料只读。保存失败保留草稿；切角色、方案、刷新和退出时守卫未保存内容。关系仅允许选择既有正式角色。宿主可通过 requestLeave(action) 请求离开，hasUnsaved/saving 为只读状态投影。关闭页面与切作品不得绕过此入口。桌面布局使用更宽的角色列表与详情栏，正文和辅助标签保持可读字号；较窄工作区用三个区域导航。
