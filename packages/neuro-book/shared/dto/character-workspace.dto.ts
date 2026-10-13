import {z} from "zod";
import {ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";

export const CharacterStateDtoSchema = z.object({
    chapter: z.string(),
    location: z.string(),
    items: z.string(),
    psychology: z.string(),
}).strict();

export const CharacterDetailRecordDtoSchema = z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    source: z.string(),
    targetId: z.string(),
    unknown: z.string(),
    misunderstanding: z.string(),
}).strict();

export const CharacterFacetDtoSchema = z.object({
    experience: z.array(CharacterDetailRecordDtoSchema),
    relationships: z.array(CharacterDetailRecordDtoSchema),
    knowledge: z.array(CharacterDetailRecordDtoSchema),
    state: CharacterStateDtoSchema,
}).strict();

export const CharacterProfileDtoSchema = z.object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
    identity: z.string(),
    summary: z.string(),
    appearance: z.string(),
    clothing: z.string(),
    family: z.string(),
    economy: z.string(),
    abilities: z.string(),
    personality: z.string(),
    temperament: z.string(),
    avatar: z.string(),
    avatarUrl: z.string(),
}).strict();

export type CharacterStateDto = z.infer<typeof CharacterStateDtoSchema>;
export type CharacterDetailRecordDto = z.infer<typeof CharacterDetailRecordDtoSchema>;
export type CharacterFacetDto = z.infer<typeof CharacterFacetDtoSchema>;
export type CharacterProfileDto = z.infer<typeof CharacterProfileDtoSchema>;

export type CharacterPlanDto = {id: string; title: string; description?: string};

export type CharacterRecordDto = {
    id: string;
    profile: CharacterProfileDto | null;
    original: CharacterFacetDto;
    plans: Record<string, CharacterFacetDto>;
    issue?: string;
    files: {
        profile: {path: string; mtimeMs: number | null} | null;
        original: Record<string, {path: string; mtimeMs: number | null}>;
        plans: Record<string, Record<string, {path: string; mtimeMs: number | null}>>;
    };
};

export type CharacterWorkspaceSnapshotDto = {
    plans: CharacterPlanDto[];
    characters: CharacterRecordDto[];
};

export const CharacterProfileSaveRequestSchema = z.object({
    projectRoot: ProjectRootDtoSchema,
    characterId: z.string().min(1),
    profile: CharacterProfileDtoSchema,
    expectedMtimeMs: z.number().nullable(),
    // 头像在保存基础资料时一并提交；base64 上限约对应 20 MiB 原始文件。
    avatarUpload: z.object({base64: z.string().max(28_000_000), mime: z.string().max(128)}).strict().optional(),
}).strict();

export const CharacterFacetSaveRequestSchema = z.object({
    projectRoot: ProjectRootDtoSchema,
    characterId: z.string().min(1),
    planId: z.string().min(1),
    facet: CharacterFacetDtoSchema,
    kind: z.enum(["experience", "relationships", "knowledge", "state"]),
    expectedMtimeMs: z.number().nullable(),
}).strict();
