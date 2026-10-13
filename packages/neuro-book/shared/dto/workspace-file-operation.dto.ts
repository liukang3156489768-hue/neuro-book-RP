import {z} from "zod";
import {ProjectReadyIdDtoSchema, ProjectRootDtoSchema} from "nbook/shared/dto/project.dto";

/** 批量文件副作用的有限状态；服务端不宣称事务原子性。 */
export const WorkspaceFileBatchItemStatusSchema = z.enum([
    "success",
    "failed",
    "skipped",
    "not-executed",
]);
export type WorkspaceFileBatchItemStatus = z.infer<typeof WorkspaceFileBatchItemStatusSchema>;

export const WorkspaceFileBatchKindSchema = z.enum(["copy", "move"]);
export type WorkspaceFileBatchKind = z.infer<typeof WorkspaceFileBatchKindSchema>;

const WorkspaceFileBatchOperationSchema = z.object({
    kind: WorkspaceFileBatchKindSchema,
    sources: z.array(z.string().trim().min(1, "source 不能为空")).min(1).max(256),
    destination: z.string().trim().min(1, "destination 不能为空"),
}).strict();

const WorkspaceFileBatchProjectBindingSchema = WorkspaceFileBatchOperationSchema.extend({
    projectRoot: ProjectRootDtoSchema,
    publicId: ProjectReadyIdDtoSchema,
}).strict();

const WorkspaceFileBatchUserAssetsBindingSchema = WorkspaceFileBatchOperationSchema.extend({
    workspaceKind: z.literal("user-assets"),
}).strict();

/** Project 必须保留精确 projectRoot + publicId；user-assets 必须显式声明 kind。 */
export const WorkspaceFileBatchBindingSchema = z.union([
    WorkspaceFileBatchProjectBindingSchema,
    WorkspaceFileBatchUserAssetsBindingSchema,
]);
export type WorkspaceFileBatchBinding = z.infer<typeof WorkspaceFileBatchBindingSchema>;

export const WorkspaceFileBatchRequestSchema = WorkspaceFileBatchBindingSchema;
export type WorkspaceFileBatchRequest = z.infer<typeof WorkspaceFileBatchRequestSchema>;

export const WorkspaceFileBatchItemResultSchema = z.object({
    source: z.string(),
    target: z.string(),
    status: WorkspaceFileBatchItemStatusSchema,
    reason: z.string().optional(),
}).strict();
export type WorkspaceFileBatchItemResult = z.infer<typeof WorkspaceFileBatchItemResultSchema>;

export const WorkspaceFileBatchResponseSchema = z.object({
    kind: WorkspaceFileBatchKindSchema,
    destination: z.string(),
    items: z.array(WorkspaceFileBatchItemResultSchema),
}).strict();
export type WorkspaceFileBatchResponse = z.infer<typeof WorkspaceFileBatchResponseSchema>;
