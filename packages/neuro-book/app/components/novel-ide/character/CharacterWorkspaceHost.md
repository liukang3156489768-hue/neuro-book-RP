---
标签: [io:read, io:mutate]
---

# CharacterWorkspaceHost

角色管理的产品宿主，projectRoot 指定当前作品身份；只读取当前项目 `lorebook/character/`，用角色管理 API 保存真实文件，使用内容版本检测外部修改。宿主挂在主工作区 editor 叶中；角色工作台打开时由页面暂时隐藏左右侧栏，让三栏角色界面占满主要工作区，关闭后恢复原布局。头像在编辑期间只保留浏览器预览，基础资料点击保存时随 profile 请求校验并写入角色目录，再把目录内相对路径写回 index.md。

Props: projectRoot: string。Emits: open-file(path: string)。Expose: requestLeave(action: () => void): void，hasUnsaved: boolean，saving: boolean，reload(): Promise<void>。请求失败保留当前数据或草稿并提供刷新；项目切换必须经宿主 requestLeave，组件以项目身份重建防止迟到结果跨项目。原作无写入能力。
