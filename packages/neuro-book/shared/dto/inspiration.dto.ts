import {z} from "zod";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";
import {ThinkingLevelSchema} from "nbook/shared/dto/app-settings.dto";

export const INSPIRATION_CATEGORIES = ["character", "faction", "instruction", "item", "location", "note", "system", "world"] as const;
export const InspirationCategorySchema = z.enum(INSPIRATION_CATEGORIES);
export type InspirationCategory = z.infer<typeof InspirationCategorySchema>;
export const INSPIRATION_CATEGORY_LABELS: Record<InspirationCategory, string> = {
    character: "角色人设", faction: "势力设定", instruction: "风格基调", item: "特殊物品",
    location: "地点设定", note: "写作指导与参考资料", system: "特殊规则", world: "世界观",
};
export const INSPIRATION_TEMPLATE_FIELDS: Record<InspirationCategory, readonly string[]> = {
    character: ["角色名称", "别称", "基本身份", "外貌", "衣着", "性格", "性格对应的表现描述", "梦想（外在愿望、内在渴望）", "价值观与底线", "恐惧与弱点", "能力与特长", "喜好与习惯", "语言与交流方式"],
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
    source: z.object({
        path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/u), chunkIndex: z.number().int().positive(),
        citations: z.array(z.object({firstParagraphId: z.string().regex(/^P[1-9]\d*$/u), lastParagraphId: z.string().regex(/^P[1-9]\d*$/u)}).strict()).min(1).max(12),
    }).strict().optional(),
}).strict();
const INSPIRATION_DRAFT_MAX_BYTES = 4_500_000;
export const InspirationDraftSchema = z.object({
    id: z.string().uuid(), projectRoot: ProjectRootDtoSchema, revision: z.number().int().positive(),
    request: z.string().min(1).max(20_000), artifacts: z.array(InspirationArtifactSchema).min(1).max(32),
    sessionId: z.number().int().positive(), createdAt: z.string().datetime(),
}).strict().superRefine((draft, context) => {
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

export const InspirationExtractSchema = z.object({
    projectRoot: ProjectRootDtoSchema, requestId: z.string().uuid(), conversationId: z.string().uuid(),
    request: z.string().trim().min(1).max(20_000), path: z.string().min(1).max(2048),
    chunkIndexes: z.array(z.number().int().positive()).min(1).max(128), categories: z.array(InspirationCategorySchema).min(1).max(8),
    modelKey: z.string().trim().min(1).max(300).optional(), thinkingEnabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(), thinkingLevel: ThinkingLevelSchema.optional(),
}).strict().refine(value => new Set(value.chunkIndexes).size === value.chunkIndexes.length, "分析范围不能包含重复分块")
    .refine(value => new Set(value.categories).size === value.categories.length, "分析目标不能包含重复类别");
export type InspirationExtractDto = z.infer<typeof InspirationExtractSchema>;

export const InspirationArtifactRefineSchema = z.object({
    projectRoot: ProjectRootDtoSchema, requestId: z.string().uuid(), conversationId: z.string().uuid(),
    draftId: z.string().uuid(), revision: z.number().int().positive(), artifactId: z.string().uuid(),
    action: z.enum(["refine", "ask"]), instruction: z.string().trim().min(1).max(20_000),
    modelKey: z.string().trim().min(1).max(300).optional(), thinkingEnabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(), thinkingLevel: ThinkingLevelSchema.optional(),
}).strict();
export type InspirationArtifactRefineDto = z.infer<typeof InspirationArtifactRefineSchema>;
