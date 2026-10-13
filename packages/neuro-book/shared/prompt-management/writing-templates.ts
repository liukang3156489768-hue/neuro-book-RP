import type {PromptEntry} from "nbook/shared/dto/prompt-management.dto";

/**
 * 写手默认提示词按酒馆预设的颗粒度拆成逐条 entry：每个小节独立、可在提示词管理里单独排序/停用/改角色。
 * 这里是唯一真相源，writing-catalog.ts 的内置默认条目和 structures.ts 没有绑定会话时的兜底渲染都消费同一份数组，
 * 避免两条路径各自维护、逐渐漂移。
 */
export const WRITER_SYSTEM_SECTIONS: readonly PromptEntry[] = [
    {id: "role", name: "写手职责", role: "system", content: [
        "你是小说写手，只负责把给定的场景写成正文。",
        "只使用下面提供的信息：不补写提示之外的剧情、人物或设定，不改变细纲中的事件和结果。",
        "伏笔处只按给出的原文和动作呈现，不解释、不提前揭示。",
        "补充资料是创作依据，不等于角色已知事实；根据人设表现既定行动，不改变关键决定。服饰与位置沿用细纲和前文，不凭空补造缺失设定。",
    ].join("\n")},
    {id: "style-requirements", name: "文风要求", role: "system", content: "## 文风要求\n\n{{requirements}}"},
    {id: "style-forbidden", name: "禁用写法", role: "system", content: "## 禁用写法\n\n{{forbidden}}"},
    {id: "style-sample", name: "样文", role: "system", content: "## 样文\n\n{{sample}}"},
];

/** 「上一章结尾」与「上次重写问题」改为统一占位：不适用时渲染占位文案，而不是整段消失，和其余小节一致可排序/停用。 */
export const SCENE_WRITER_SECTIONS: readonly PromptEntry[] = [
    {id: "previous-ending", name: "上一章结尾", role: "user", content: "## 上一章结尾\n\n{{previousEnding}}"},
    {id: "overview", name: "章节总览", role: "user", content: "## 章节总览\n\n{{overview}}"},
    {id: "roster", name: "场景一览", role: "user", content: "## 场景一览\n\n{{roster}}"},
    {id: "accepted-prose", name: "已通过正文", role: "user", content: "## 已通过正文\n\n{{acceptedProse}}"},
    {id: "chapter-guidance", name: "本章写作指导", role: "user", content: "## 本章写作指导\n\n{{chapterGuidance}}"},
    {id: "chapter-foreshadowing", name: "本章伏笔标记原文", role: "user", content: "## 本章伏笔标记原文\n\n{{chapterForeshadowing}}"},
    {id: "scene-description", name: "本场景", role: "user", content: "## 本场景（{{sceneLabel}}）\n\n{{sceneDescription}}"},
    {id: "characters", name: "参与角色", role: "user", content: "## 参与角色\n\n{{characters}}"},
    {id: "location", name: "场景地点", role: "user", content: "## 场景地点\n\n{{location}}"},
    {id: "attire", name: "角色服饰与外观状态", role: "user", content: "## 角色服饰与外观状态\n\n{{attire}}"},
    {id: "plot", name: "具体情节", role: "user", content: "## 具体情节\n\n{{plot}}"},
    {id: "description", name: "描写", role: "user", content: "## 描写\n\n{{description}}"},
    {id: "guidance", name: "写作指导", role: "user", content: "## 写作指导\n\n{{guidance}}"},
    {id: "scene-foreshadowing", name: "本场景伏笔", role: "user", content: "## 本场景伏笔\n\n{{sceneForeshadowing}}"},
    {id: "techniques", name: "写作手法补充", role: "user", content: "## 写作手法补充\n\n{{techniques}}"},
    {id: "background", name: "背景知识", role: "user", content: "## 背景知识\n\n{{background}}"},
    {id: "supplements", name: "依据细纲补充的资料", role: "user", content: "{{supplements}}"},
    {id: "must-include", name: "必须写到的要素", role: "user", content: "## 必须写到的要素\n\n{{mustInclude}}"},
    {id: "forbidden", name: "不能出现的情节", role: "user", content: "## 不能出现的情节\n\n{{sceneForbidden}}"},
    {id: "retry", name: "上次重写问题", role: "user", content: "## 上次产出未通过的问题（本次必须改正）\n\n{{retryProblemsText}}"},
    {id: "output", name: "输出要求", role: "user", content: "## 输出要求\n\n只输出本场景正文，与已通过正文直接衔接；不加标题、分隔符或任何说明。\n目标字数为下限要求（不少于指定字数），允许超出；但不得写得过短。\n严格遵守场景边界：只写到本场景的结尾落点，严禁提前展开下一场景的剧情。允许在场景结尾铺垫下一场景以确保衔接流畅，但不得写出下一场景的具体事件和冲突。\n执行伏笔时只写到标记原文的程度，不提前揭示。"},
];

export const REWRITE_WRITER_SECTIONS: readonly PromptEntry[] = [
    {id: "before", name: "上文", role: "user", content: "## 上文\n\n{{before}}"},
    {id: "target", name: "目标段落", role: "user", content: "## 目标段落\n\n{{target}}"},
    {id: "after", name: "下文", role: "user", content: "## 下文\n\n{{after}}"},
    {id: "requirement", name: "修改要求", role: "user", content: "## 修改要求\n\n{{requirement}}"},
    {id: "perspective", name: "人称", role: "user", content: "## 人称\n\n{{perspective}}"},
    {id: "techniques", name: "写作手法", role: "user", content: "## 写作手法\n\n{{techniques}}"},
    {id: "background", name: "背景知识", role: "user", content: "## 背景知识\n\n{{background}}"},
    {id: "supplements", name: "依据细纲补充的资料", role: "user", content: "{{supplements}}"},
    {id: "retry", name: "上次重写问题", role: "user", content: "## 上次产出未通过的问题（本次必须改正）\n\n{{retryProblemsText}}"},
    {id: "output", name: "输出要求", role: "user", content: "## 输出要求\n\n只输出替换目标段落的新正文，与上下文直接衔接；不加标题、分隔符或任何说明。"},
];
