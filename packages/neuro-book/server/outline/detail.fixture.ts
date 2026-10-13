/** 测试用细纲场景；未给的字段取最小可用值。 */
export type FixtureScene = Readonly<{
    name?: string;
    summary?: string;
    words?: number;
    perspective?: string;
    mood?: string;
    pacing?: string;
    characters?: readonly string[];
    plot: readonly string[];
    description?: string;
    guidance?: string;
    references?: readonly string[];
    /** 每项写成“名称|标记|状态|作用|效果”。 */
    foreshadowing?: readonly string[];
}>;

/** 按细纲模板拼出正文；目标字数缺省为各场景字数之和。 */
export function detailBody(input: Readonly<{scenes: readonly FixtureScene[]; targetWords?: number; forbidden?: readonly string[]; title?: string}>): string {
    const target = input.targetWords ?? input.scenes.reduce((sum, scene) => sum + (scene.words ?? 1000), 0);
    const scenes = input.scenes.map((scene, position) => {
        const index = position + 1;
        const part = (title: string, text: string | undefined) => text === undefined || text === "" ? [] : [`### ${title}`, "", text, ""];
        return [
            `## 场景${index}${scene.name === undefined ? "" : `：${scene.name}`}`,
            "",
            `- 场景简述：${scene.summary ?? `${scene.name ?? `场景${index}`}的经过`}`,
            `- 字数要求：${scene.words ?? 1000}`,
            `- 人称要求：${scene.perspective ?? "第三人称限知"}`,
            ...(scene.mood === undefined ? [] : [`- 情绪基调：${scene.mood}`]),
            ...(scene.pacing === undefined ? [] : [`- 剧情节奏：${scene.pacing}`]),
            "",
            ...part("参与角色", scene.characters?.map((item) => `- ${item}`).join("\n")),
            "### 具体情节",
            "",
            ...scene.plot.map((item, number) => `${number + 1}. ${item}`),
            "",
            ...part("描写", scene.description),
            ...part("写作指导", scene.guidance),
            ...part("参考资料", scene.references?.map((item) => `- ${item}`).join("\n")),
            ...part("伏笔", scene.foreshadowing?.map((item) => {
                const [name, marker, status, purpose, effect] = item.split("|");
                return [`- ${name}`, `  - 标记：${marker ?? ""}`, `  - 状态：${status ?? ""}`, `  - 作用：${purpose ?? ""}`, `  - 效果：${effect ?? ""}`].join("\n");
            }).join("\n")),
        ].join("\n");
    });
    return [
        "# 章节总览",
        "",
        `- 章节标题：${input.title ?? "本章"}`,
        "- 剧情概括：本章的经过",
        "- 核心冲突：主角与阻力",
        "- 情绪基调：先压后放",
        `- 目标字数：${target}`,
        "",
        "# 章节细纲",
        "",
        ...scenes,
        ...(input.forbidden === undefined || input.forbidden.length === 0 ? [] : ["# 禁止事项", "", ...input.forbidden.map((item) => `- ${item}`), ""]),
    ].join("\n");
}

/**
 * 通过结构检查的最小细纲：一个场景，一条具体情节，字数与人称齐全。
 * 细纲分析、采用与写作都拒绝结构不完整的细纲，需要走这些流程的测试用它代替随手写的正文。
 */
export function sceneDetail(beat: string, name = "场景"): Readonly<{body: string}> {
    return {body: detailBody({scenes: [{name, plot: [beat]}]})};
}
