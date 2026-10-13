import {MATERIAL_FEATURE_TYPE_FIELD, MATERIAL_FEATURE_TYPES, type MaterialParagraphReference} from "nbook/shared/dto/inspiration-material.dto";
import {
    CHARACTER_SUBNODE_ROLES, referenceLabel, recordTemplateOfSubnode,
    type MaterialCategorySpec, type MaterialDraftItem,
} from "./material-data";

/**
 * 素材提取与整合的提示词文本。
 *
 * 系统提示词对所有素材调用共用同一份：供应商的前缀缓存包含系统消息，
 * 按类别区分系统提示词会让同一块的九次调用无法共享缓存；类别差异只放在提示词末尾的任务目标里。
 */

export const MATERIAL_SYSTEM_PROMPT = [
    "你是小说素材提取助手，从给定的作品原文中提取可供创作参考的素材。",
    "通用规则：",
    "1. 只依据原文提取，不补写、不推测；原文没有的信息，对应字段写空字符串。",
    "2. 原文每段以【P编号】开头。标注信息来源时只写 P 编号（如 P12 或 P12-P15，多个用空格分隔），不要抄写原文。",
    "3. 只输出一个 JSON 对象，不要输出解释文字；可以用代码块包裹。",
    "4. fields 内的字段值都是文本；aliases 是文本数组，entities、entries、candidates、experiences、relationships 按任务格式使用对象数组。不要将这些结构容器混入 fields。",
].join("\n");

const NO_PLOT_RULE = "本类素材不涉及剧情发展：只写设定本身（它是什么、有什么特点），不写事件经过、情节走向和谁对谁做了什么；原文里的事件只作为判断设定的依据，不要复述。";
const PLOT_ALLOWED_RULE = "本类素材可以涉及剧情发展。";
const REUSABLE_ABSTRACTION_RULE = [
    "这是可迁移的创作参考，不是原作剧情梗概。只提炼结构、方法、触发条件、实施步骤、限制和可复用效果。",
    "正文不得出现原作中的人物姓名、外号、学校或组织专名、作品名称，也不得复述连续事件链、具体人物关系或某个角色的专属经历。",
    "将人物改写为功能角色（如主角、目标角色、施压者、旁观者、第三方），将地点和道具改写为功能描述；只保留理解方法所必需的抽象条件。",
    "如果一条内容只有替换人名后才成立，应重新概括其机制；来源只保留 P 编号，不把人物或事件写入字段。",
].join("\n");

function categoryExtractionRule(spec: MaterialCategorySpec): string {
    return ["writing-technique", "material-feature", "system"].includes(spec.key) ? REUSABLE_ABSTRACTION_RULE
        : spec.allowsPlotDevelopment ? PLOT_ALLOWED_RULE : NO_PLOT_RULE;
}

function fieldsExample(fields: readonly string[]): string {
    return `{${fields.map(label => `"${label}": ""`).join(", ")}}`;
}

function rangeText(range: MaterialParagraphReference): string {
    return referenceLabel(range);
}

function referenceRule(range: MaterialParagraphReference): string {
    return `P 编号只能引用本块范围 ${rangeText(range)} 内的段落。`;
}

/** 已知实体名单：只给实体类别的调用，让模型把别称归并到已有名称，而不是新建重复条目。 */
export function renderKnownEntities(spec: MaterialCategorySpec, known: ReadonlyArray<Readonly<{name: string; aliases: readonly string[]}>>): string {
    const lines = known.map(entity => entity.aliases.length ? `${entity.name}｜${entity.aliases.join("、")}` : entity.name);
    return [`【已知${spec.label}】格式为“名称｜别称”，是此前各块已提取到的${spec.label}：`, ...(lines.length ? lines : ["（暂无）"])].join("\n");
}

export function entityExtractionGoal(spec: MaterialCategorySpec, range: MaterialParagraphReference): string {
    const isCharacter = spec.key === "character";
    const subnodeLines = isCharacter
        ? CHARACTER_SUBNODE_ROLES.flatMap(role => {
            const template = recordTemplateOfSubnode(role);
            return [
                `- ${role === "experience" ? "experiences" : "relationships"}：本块中该角色的${template.label}记录列表（本块没有则为空数组），每条是对象，键只能是：${fieldsExample(template.fields)}；其中“${template.referenceField}”写 P 编号。`,
            ];
        })
        : [];
    const example = `{"entities": [{"name": "", "aliases": [], "fields": ${fieldsExample(spec.fields)}, "references": "P1 P3-P4"${isCharacter ? ', "experiences": [], "relationships": []' : ""}}]}`;
    return [
        `【任务】提取本块原文中出现的${spec.label}。每个${spec.label}一条。`,
        `- name：该${spec.label}在原文中最常用的名称。若它与上面【已知${spec.label}】中的某个名称或别称是同一个对象，name 必须写成那个已知名称，不要新建；本块新出现的别称写进 aliases。`,
        `- fields：键只能是模板字段，没有信息的字段写空字符串。`,
        `- references：fields 所依据的原文 P 编号。${referenceRule(range)}`,
        ...subnodeLines,
        isCharacter ? `${NO_PLOT_RULE}此规则只约束 fields（基础人设）；经历与人际关系用来记录角色在作品中的经历，可以写事件，但只写本块内发生的，保持简明。` : categoryExtractionRule(spec),
        "- 本块没有出现的对象不要写；没有任何条目时输出 {\"entities\": []}。",
        `输出格式：${example}`,
    ].join("\n");
}

/** 角色第一阶段只做高召回名单发现，避免一次调用同时生成大量完整人设而被截断。 */
export function characterDiscoveryGoal(range: MaterialParagraphReference): string {
    return [
        `【任务】粗读本块原文，列出其中实际出现的角色与称谓。${referenceRule(range)}`,
        "- 这是角色名单发现阶段，只判断“有哪些角色”，不要写性格、经历、关系或其他设定。",
        "- 有正式姓名的角色必须列出；只有称谓、外号或身份称呼但无法确认姓名的角色也先列出，name 使用原文最稳定的称呼。同名异人或同一通用称谓指代不同人时，用原文明确的身份信息区分名称，不要强行合并。",
        "- aliases 只写本块出现的其他称呼，不要把普通指代词（如“他”“她”“众人”）当作别称。",
        "- references 写支持该角色出现的 P 编号；没有可用引用时仍保留候选，references 写空字符串。",
        '没有角色时输出 {"candidates": []}。',
        '输出格式：{"candidates": [{"name": "", "aliases": [], "references": "P1 P3-P4"}]}',
    ].join("\n");
}

/** 角色第二阶段一次只处理一个角色，输出规模与其他实体解耦。 */
export function characterFocusedExtractionGoal(spec: MaterialCategorySpec, name: string, aliases: readonly string[], range: MaterialParagraphReference): string {
    return [
        `【任务】只提取角色“${name}”在本块中的资料。${referenceRule(range)}`,
        aliases.length ? `- 该角色已知别称：${aliases.join("、")}。命中这些称呼时仍写同一个 name。` : "",
        `- name 固定为 ${JSON.stringify(name)}，aliases 只补充原文明确属于这个角色的称呼。只输出这一个角色；粗读名单有误或本块没有该角色的可提取资料时，输出 {"entity": null}。`,
        `输出格式：{"entity": {"name": ${JSON.stringify(name)}, "aliases": [], "fields": ${fieldsExample(spec.fields)}, "references": "", "experiences": [], "relationships": []}}`,
    ].filter(Boolean).join("\n");
}

/** 角色提取的稳定模板，必须放在动态角色名称之前以保持同块请求的缓存前缀。 */
export function characterExtractionTemplate(spec: MaterialCategorySpec, range: MaterialParagraphReference): string {
    const subnodeLines = CHARACTER_SUBNODE_ROLES.map(role => {
        const template = recordTemplateOfSubnode(role);
        return `- ${role === "experience" ? "experiences" : "relationships"}：本块中该角色的${template.label}列表（没有则为空数组），每条键只能是：${fieldsExample(template.fields)}。`;
    });
    return [
        "【角色字段模板】",
        "- fields：键只能是角色模板字段；没有信息的字段写空字符串。",
        `- 角色模板字段：${fieldsExample(spec.fields)}。`,
        `- references：基本设定依据的 P 编号，必须是字符串（例如 "${range.firstParagraphId}"）。它与 fields 同级，不能放进 fields，也不能写成数组或对象；基础字段有非空内容时必须给出真实来源引用。${referenceRule(range)}`,
        `${NO_PLOT_RULE}此规则只约束 fields（基础人设）；严格使用新的角色页字段：名称、别名、标签、摘要、基本身份、外貌、穿着、家庭情况、经济情况、特殊能力、性格、性格描述。只记录稳定设定，不把本块临时动作、临时衣着或剧情状态写入基础人设；没有明确内容就留空，不要为了填满模板而推测。`,
        ...subnodeLines,
        `- experiences 与 relationships 只记录本块内明确出现的内容；每条记录中的“参考片段”必须是本块 P 编号。`,
        "- 基础字段、经历、关系的引用分别填写，不能用经历或关系中的引用代替基础字段的 references。没有经历或关系时保留对应的空数组。",
        "- 输出必须是一个 JSON 对象；不要输出解释文字。",
    ].join("\n");
}

/** 输出结构由校验器拥有；作为动态任务的尾部约束，也覆盖仍使用旧快照的不完整示例。 */
export const CHARACTER_OUTPUT_CONTRACT = [
    "【角色输出结构约束】",
    '单角色输出 {"entity": {...}}，分组输出 {"entities": [{...}]}；每个角色对象包含 name、aliases、fields、references、experiences、relationships。',
    'references 必须位于角色对象内，与 fields 同级，类型为字符串，如 "P12 P15-P18"。绝不能放入 fields，也不能输出为数组、对象或数字。',
    "fields 仅包含角色基础模板字段；有基础信息必须填写当前块内真实 P 引用，不得编造编号。",
    "experiences 与 relationships 是对象数组，每条记录使用当前模板的精确字段名，并在该条的“参考片段”填写字符串 P 引用；没有记录则为空数组。",
    "单角色无可提取资料时返回 entity: null；分组中的无资料角色仍返回该角色，fields 为空对象、references 为空字符串、两类记录为空数组。",
    "只输出一个合法 JSON 对象，字符串中的换行和引号必须正确转义，不输出解释或第二个 JSON。",
].join("\n");

/** 角色分组提取目标：模板由 characterExtractionTemplate 单独提供，动态名单放在末尾。 */
export function characterGroupedExtractionGoal(spec: MaterialCategorySpec, candidates: ReadonlyArray<Readonly<{name: string; aliases: readonly string[]}>>, range: MaterialParagraphReference): string {
    const targets = candidates.map(candidate => candidate.aliases.length
        ? `${candidate.name}（别名：${candidate.aliases.join("、")}）`
        : candidate.name).join("、");
    const outputEntities = candidates.map(candidate => `{"name": ${JSON.stringify(candidate.name)}, "aliases": [], "fields": {}, "references": "", "experiences": [], "relationships": []}`).join(", ");
    return [
        `【提取目标】本次只处理这些角色：${targets}。${referenceRule(range)}`,
        "每个目标角色必须恰好输出一条，name 使用候选的正式名称；aliases 只补充原文明确属于该角色的称呼。",
        "如果某个角色在本块没有可提取信息，仍输出该角色并将 fields 留空、experiences 和 relationships 设为空数组；不得省略角色。",
        `不得输出名单之外的角色。输出格式：{"entities": [${outputEntities}]}`,
    ].join("\n");
}

export type DocumentRule = Readonly<{maxEntries: number; titleField: string | null}>;

export function documentExtractionGoal(spec: MaterialCategorySpec, range: MaterialParagraphReference, rule: DocumentRule): string {
    const referenceInFields = spec.referenceField !== null;
    const example = `{"entries": [{"fields": ${fieldsExample(spec.fields)}${referenceInFields ? "" : ', "references": "P1 P3-P4"'}}]}`;
    const typeRule = spec.key === "material-feature"
        ? [`- “${MATERIAL_FEATURE_TYPE_FIELD}”只能填写：${MATERIAL_FEATURE_TYPES.join("、")}。`, "- 素材特点指本块里值得借鉴的剧情安排（如伏笔、反转、节奏设计）或表现形式（如视角、叙述手法），每个特点一条。"]
        : [];
    return [
        `【任务】分析本块原文，提取${spec.label}。${rule.maxEntries === 1 ? "整块只写一条。" : `最多 ${rule.maxEntries} 条，每条只写一个。`}`,
        "- fields：键只能是模板字段，没有信息的字段写空字符串。",
        referenceInFields ? `- “${spec.referenceField}”字段只写依据的 P 编号。${referenceRule(range)}` : `- references：fields 所依据的原文 P 编号。${referenceRule(range)}`,
        ...typeRule,
        rule.titleField ? `- “${rule.titleField}”必须填写，作为条目标题。` : "",
        categoryExtractionRule(spec),
        `- 本块没有可提取的内容时输出 {"entries": []}。`,
        `输出格式：${example}`,
    ].filter(Boolean).join("\n");
}

function renderFragmentJson(value: unknown): string {
    return JSON.stringify(value, null, 1);
}

/** 整合提示词的前缀：该文件夹（或文档类别）自己的提取片段，不含其他任何内容。 */
export function renderIntegrationPrefix(title: string, fragments: ReadonlyArray<unknown>): string {
    return [`【${title}】以下是按块顺序提取的草稿（每条带来源 P 编号）：`, ...fragments.map((fragment, index) => `草稿 ${index + 1}：\n${renderFragmentJson(fragment)}`)].join("\n\n");
}

export function entityIntegrationGoal(spec: MaterialCategorySpec): string {
    const rule = ["writing-technique", "material-feature", "system"].includes(spec.key)
        ? REUSABLE_ABSTRACTION_RULE
        : "- 只保留设定信息，合并重复内容，不丢失草稿中有价值的细节；不写剧情经过。";
    return [
        `【任务】把上面同一个${spec.label}在各块的草稿整合成一份完整的基本设定。`,
        rule,
        `- fields：键只能是：${fieldsExample(spec.fields)}，没有信息的字段写空字符串。`,
        `输出格式：{"fields": ${fieldsExample(spec.fields)}}`,
    ].join("\n");
}

export function documentIntegrationGoal(spec: MaterialCategorySpec, rule: DocumentRule): string {
    return [
        `【任务】把上面各块的${spec.label}草稿整合为${rule.maxEntries === 1 ? "一条" : "若干条"}完整的${spec.label}。`,
        rule.maxEntries === 1 ? "- 只输出一条，合并各块的重复内容，保留有价值的细节。" : "- 同一个对象在多个块中重复出现时合并为一条；不同对象各自一条。",
        spec.referenceField ? `- “${spec.referenceField}”字段只写草稿中出现过的 P 编号，可以合并，不要新增。` : "",
        rule.titleField ? `- “${rule.titleField}”必须填写，作为条目标题。` : "",
        categoryExtractionRule(spec),
        `输出格式：{"entries": [{"fields": ${fieldsExample(spec.fields)}}]}`,
    ].filter(Boolean).join("\n");
}

/** 手动合并：把用户勾选的同类条目合成一个。 */
export function mergeItemsPrefix(spec: MaterialCategorySpec, items: readonly Pick<MaterialDraftItem, "title" | "aliases" | "nodes">[]): string {
    return renderIntegrationPrefix(`待合并的${spec.label}`, items.map(item => ({
        title: item.title,
        aliases: item.aliases,
        nodes: item.nodes.map(node => ({role: node.role, entries: node.entries.map(entry => ({block: entry.block, fields: entry.fields}))})),
    })));
}

export function mergeItemsGoal(spec: MaterialCategorySpec): string {
    const rule = ["writing-technique", "material-feature", "system"].includes(spec.key)
        ? REUSABLE_ABSTRACTION_RULE
        : "- 合并重复内容，保留有价值的细节。";
    return [
        `【任务】用户认为上面这些${spec.label}条目是同一个对象，请把它们的基本设定合并成一份。`,
        rule,
        `- fields 的键只能是：${fieldsExample(spec.fields)}。`,
        `输出格式：{"fields": ${fieldsExample(spec.fields)}}`,
    ].join("\n");
}

export function noteIndexGoal(label: string): string {
    return [
        `【任务】为这些${label}条目建立检索索引。阅读每条全部字段，保留每个独立条目，不合并或重写正文。`,
        "为每个 key 输出且仅输出一条：group 是可复用的技法或素材分类（最多32字）；summary 是内容要点与适用场景（最多160字）；keywords 为1到5个短检索词（每个最多24字）。",
        "沿用叙事、描写、对话、结构、节奏、人物塑造、情绪营造、伏笔、反转等易理解的分类；可以根据内容选择其他简短分类。不要输出路径、全文或原文片段。",
        '输出格式：{"entries":[{"key":"输入的key","group":"分类","summary":"要点与适用场景","keywords":["检索词"]}]}',
    ].join("\n");
}

/** 取出模型产出中的 JSON 对象：容忍代码围栏与前后说明文字。 */
export function parseJsonObject(output: string): {ok: true; value: Record<string, unknown>} | {ok: false; error: string} {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(output);
    const body = fenced ? fenced[1]! : output;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return {ok: false, error: "产出里没有找到 JSON 对象，请只输出一个 JSON 对象"};
    try {
        const value: unknown = JSON.parse(body.slice(start, end + 1));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return {ok: false, error: "产出必须是 JSON 对象"};
        return {ok: true, value: value as Record<string, unknown>};
    } catch (error) {
        return {ok: false, error: `产出不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`};
    }
}
