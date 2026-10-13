import {z} from "zod";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";
import {ThinkingLevelSchema} from "nbook/shared/dto/app-settings.dto";

export const INSPIRATION_CATEGORIES = ["character", "faction", "instruction", "item", "location", "note", "system", "world"] as const;
export const InspirationCategorySchema = z.enum(INSPIRATION_CATEGORIES);
export type InspirationCategory = z.infer<typeof InspirationCategorySchema>;
export const InspirationCreationModeSchema = z.enum(["original", "adaptation"]);
export type InspirationCreationMode = z.infer<typeof InspirationCreationModeSchema>;
export const InspirationMaterialPathSchema = z.string().max(1000).regex(/^lorebook\/(?:character|faction|instruction|item|location|note|system|world)\/.+$/u)
    .refine(value => !value.includes("\\") && value.split("/").every(segment => segment !== "." && segment !== ".." && segment !== "" && !segment.includes(":")), "参考素材路径无效");
export const InspirationMaterialSourceSchema = z.object({
    path: InspirationMaterialPathSchema, category: InspirationCategorySchema,
    title: z.string().min(1).max(120), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    content: z.string().min(1).max(60_000),
}).strict();
export type InspirationMaterialSourceDto = z.infer<typeof InspirationMaterialSourceSchema>;
export const InspirationMaterialSourcesSchema = z.array(InspirationMaterialSourceSchema).max(12)
    .refine(sources => new Set(sources.map(source => source.path.toLowerCase())).size === sources.length, "参考素材不能重复")
    .refine(sources => sources.reduce((size, source) => size + source.content.length, 0) <= 160_000, "参考素材过多，请减少选择或缩小参考内容");
export const InspirationMaterialListRequestSchema = z.object({
    projectRoot: ProjectRootDtoSchema, category: InspirationCategorySchema.optional(), query: z.string().max(100).optional(),
    offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type InspirationMaterialListRequestDto = z.infer<typeof InspirationMaterialListRequestSchema>;
export type InspirationMaterialListDto = {items: Array<{path: string; category: InspirationCategory; title: string}>; total: number; nextOffset: number | null};
export const INSPIRATION_CATEGORY_LABELS: Record<InspirationCategory, string> = {
    character: "角色人设", faction: "势力设定", instruction: "风格基调", item: "特殊物品",
    location: "地点设定", note: "写作指导与参考资料", system: "特殊规则", world: "世界观",
};
export const INSPIRATION_TEMPLATE_FIELDS: Record<InspirationCategory, readonly string[]> = {
    character: ["名称", "别名", "标签", "摘要", "基本身份", "外貌", "穿着", "家庭情况", "经济情况", "特殊能力", "性格", "性格描述"],
    faction: ["势力名称与别称", "势力性质", "势力人员构成", "势力作用", "势力行为", "理念与宗旨", "活动范围与据点", "资源与专长", "内部规则与禁忌", "标识与外在特征"],
    instruction: ["风格名称或概述", "整体基调", "叙述声音", "用词特点", "句式与段落", "对话风格", "描写方式", "情绪表达", "修辞与意象", "表达节奏", "参考片段"],
    item: ["名称", "作用", "来源", "外观", "其他用处", "别称", "使用方式与条件", "限制与代价", "特殊表现", "保存与维护"],
    location: ["名称", "描述", "与其他地点的关联", "特点", "别称", "地点类型与用途", "内部布局", "常见居民与管理归属", "出入条件与限制", "环境与感官特征"],
    note: [],
    system: ["名称与别称", "类型", "内容描述", "适用范围", "适用情境与条件", "遵循方式或运行方式", "作用与意义", "限制、代价与违反后果", "例外与豁免", "来源与解释", "外在表现", "与其他规则的关联"],
    world: ["名称与概述", "时代与文明水平", "世界结构与地理格局", "主要种族与群体", "社会制度与阶层", "经济与生活方式", "文化与信仰", "力量与技术体系", "基础运行规律", "历史背景"],
};

export const InspirationArtifactSchema = z.object({
    id: z.string().uuid(), category: InspirationCategorySchema, title: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(80_000), sessionId: z.number().int().positive(),
}).strict();
const INSPIRATION_DRAFT_MAX_BYTES = 4_500_000;
export const InspirationDraftSchema = z.object({
    id: z.string().uuid(), projectRoot: ProjectRootDtoSchema, revision: z.number().int().positive(),
    request: z.string().min(1).max(20_000), artifacts: z.array(InspirationArtifactSchema).min(1).max(32),
    sessionId: z.number().int().positive(), createdAt: z.string().datetime(),
    creationMode: InspirationCreationModeSchema.optional(), materialSources: InspirationMaterialSourcesSchema.optional(),
}).strict().superRefine((draft, context) => {
    if ((draft.creationMode ?? "original") === "adaptation" && !draft.materialSources?.length) {
        context.addIssue({code: z.ZodIssueCode.custom, message: "改编草稿必须包含参考来源快照"});
    }
    if ((draft.creationMode ?? "original") === "original" && draft.materialSources?.length) {
        context.addIssue({code: z.ZodIssueCode.custom, message: "原创草稿不能包含改编来源"});
    }
    // Drafts are kept in the workspace's 5 MiB text-file boundary; leave room for JSON framing.
    if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > INSPIRATION_DRAFT_MAX_BYTES) {
        context.addIssue({code: z.ZodIssueCode.custom, message: "设计草稿过大，请拆分需求后重试"});
    }
});
export type InspirationDraftDto = z.infer<typeof InspirationDraftSchema>;
export type InspirationArtifactDto = z.infer<typeof InspirationArtifactSchema>;
export const InspirationGenerateSchema = z.object({
    projectRoot: ProjectRootDtoSchema, requestId: z.string().uuid(), request: z.string().trim().min(1).max(20_000),
    draftId: z.string().uuid().optional(), revision: z.number().int().positive().optional(),
    feedback: z.string().trim().min(1).max(20_000).optional(), conversationId: z.string().uuid().optional(),
    creationMode: InspirationCreationModeSchema.optional(), materialPaths: z.array(InspirationMaterialPathSchema).max(12).optional(),
    modelKey: z.string().trim().min(1).max(300).optional(), thinkingEnabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(), thinkingLevel: ThinkingLevelSchema.optional(),
}).strict().refine(value => Boolean(value.draftId) === Boolean(value.revision), "修改草稿需要同时提供草稿编号和版本");
export type InspirationGenerateDto = z.infer<typeof InspirationGenerateSchema>;
export const InspirationCancelSchema = z.object({projectRoot: ProjectRootDtoSchema, requestId: z.string().uuid()}).strict();
export const InspirationSaveSchema = z.object({
    projectRoot: ProjectRootDtoSchema, draftId: z.string().uuid(), revision: z.number().int().positive(),
    artifacts: z.array(InspirationArtifactSchema.pick({id: true, title: true, content: true})).min(1).max(32),
}).strict().refine(value => new Set(value.artifacts.map(item => item.id)).size === value.artifacts.length, "成果编号不能重复");
export type InspirationSaveDto = z.infer<typeof InspirationSaveSchema>;
export type InspirationSaveResultDto = {draftId: string; revision: number; saved: Array<{id: string; path: string}>};

const InspirationMessageRoleSchema = z.enum(["user", "assistant", "status"]);
const InspirationMessageKindSchema = z.enum(["design", "extract"]);
export const InspirationMessageSchema = z.object({
    id: z.string().uuid(), role: InspirationMessageRoleSchema, kind: InspirationMessageKindSchema,
    content: z.string().trim().min(1).max(20_000), createdAt: z.string().datetime(), draftId: z.string().uuid().optional(),
    creationMode: InspirationCreationModeSchema.optional(), materialPaths: z.array(InspirationMaterialPathSchema).max(12).optional(),
    source: z.object({path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/u), chunkIndexes: z.array(z.number().int().positive()).min(1).max(128)}).strict().optional(),
}).strict();
export type InspirationMessageDto = z.infer<typeof InspirationMessageSchema>;

export const InspirationConversationSchema = z.object({
    id: z.string().uuid(), projectRoot: ProjectRootDtoSchema, title: z.string().trim().min(1).max(120),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archivedAt: z.string().datetime().nullable(),
    messages: z.array(InspirationMessageSchema).max(200),
}).strict();
export type InspirationConversationDto = z.infer<typeof InspirationConversationSchema>;
export const InspirationConversationSummarySchema = InspirationConversationSchema.pick({id: true, title: true, createdAt: true, updatedAt: true, archivedAt: true})
    .extend({messageCount: z.number().int().nonnegative()}).strict();
export type InspirationConversationSummaryDto = z.infer<typeof InspirationConversationSummarySchema>;
export const InspirationConversationListRequestSchema = z.object({projectRoot: ProjectRootDtoSchema, includeArchived: z.enum(["true", "false"]).optional()}).strict();
export const InspirationConversationCreateSchema = z.object({projectRoot: ProjectRootDtoSchema, title: z.string().trim().min(1).max(120).optional()}).strict();
export const InspirationConversationGetRequestSchema = z.object({projectRoot: ProjectRootDtoSchema, id: z.string().uuid()}).strict();
export const InspirationConversationArchiveSchema = InspirationConversationGetRequestSchema;

export const InspirationArtifactRefineSchema = z.object({
    projectRoot: ProjectRootDtoSchema, requestId: z.string().uuid(), conversationId: z.string().uuid(),
    draftId: z.string().uuid(), revision: z.number().int().positive(), artifactId: z.string().uuid(),
    action: z.enum(["refine", "ask"]), instruction: z.string().trim().min(1).max(20_000),
    modelKey: z.string().trim().min(1).max(300).optional(), thinkingEnabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(), thinkingLevel: ThinkingLevelSchema.optional(),
}).strict();
export type InspirationArtifactRefineDto = z.infer<typeof InspirationArtifactRefineSchema>;
