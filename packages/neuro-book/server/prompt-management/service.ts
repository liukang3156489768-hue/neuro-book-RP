import {createHash, randomUUID} from "node:crypto";
import {mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {createError} from "h3";
import {z} from "zod";
import {PromptMutationDtoSchema, PromptPresetSchema, PromptPurposeDefinitionSchema, PromptSnapshotSchema,
    type PromptCatalogDto, type PromptMutationDto, type PromptPurposeDefinition, type PromptSnapshot} from "nbook/shared/dto/prompt-management.dto";
import {runtimePathsFromEnv, type RuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import {validatePromptEntries, compileWriterTavern, validateTavernRetainedFacts, promptVariableNames} from "./render";
import {tavernPromptsForGeneration, compileTavernPreset, parseTavernPreset, TAVERN_ENV_MACROS} from "./tavern-preset";
import {TavernPreviewRequestSchema, type TavernPreviewRequest, type TavernPreviewResult, type TavernWriterPreset} from "nbook/shared/dto/tavern-preset.dto";
import {extractTavernGeneration} from "./tavern-generation";
import {prepareTavernBudget} from "./tavern-budget";
import {supportedTavernMacroNames} from "./tavern-macros";
import {FrozenWriterPromptSchema, TavernVariablesSchema, tavernDictionary} from "nbook/shared/dto/tavern-preset.dto";

const StoreSchema = z.object({schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), purposes: z.record(z.string(), z.object({
    selectedPresetId: z.string(), presets: z.array(PromptPresetSchema),
}).strict())}).strict();
type Store = z.infer<typeof StoreSchema>;
const BindingSchema = z.object({schemaVersion: z.literal(1), key: z.string(), snapshotId: z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const writers = new Map<string, Promise<void>>();
type FrozenWriterPrompt = ReturnType<typeof FrozenWriterPromptSchema.parse>;
type TavernVariableScope = NonNullable<FrozenWriterPrompt["variableScope"]>;
const VariablesSchema = z.object({
    schemaVersion: z.literal(2), projectRoot: z.string(), purposeId: z.string(), presetId: z.string(),
    global: TavernVariablesSchema, locals: tavernDictionary(TavernVariablesSchema),
    attempts: tavernDictionary(z.object({ownerKey: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u)}).strict()), outputApplied: z.array(z.string()),
}).strict();
function sameScope(left: TavernVariableScope | undefined, right: TavernVariableScope): boolean {
    return left !== undefined && left.projectRoot === right.projectRoot && left.purposeId === right.purposeId && left.presetId === right.presetId
        && left.ownerKey === right.ownerKey && left.attemptKey === right.attemptKey;
}

/** All HTTP and runtime callers share one mutation queue per global State Root. */
async function serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const previous = writers.get(root) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(done => {release = done;});
    writers.set(root, tail);
    await previous;
    try {return await operation();} finally {release(); if (writers.get(root) === tail) writers.delete(root);}
}

function missing(error: unknown): boolean {return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";}
async function readJson(path: string): Promise<unknown | null> {
    try {return JSON.parse(await readFile(path, "utf8"));} catch (error) {if (missing(error)) return null; throw error;}
}

/** Atomic replacement keeps a failed save from destroying the previous configuration. */
async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx");
        try {await file.writeFile(JSON.stringify(value), "utf8"); await file.sync();} finally {await file.close();}
        await rename(temporary, path);
    } finally {await rm(temporary, {force: true});}
}

function snapshotHash(purposes: PromptSnapshot["purposes"]): string {return createHash("sha256").update(JSON.stringify({schemaVersion: 1, purposes})).digest("hex");}

async function loadDefinitions(paths: RuntimePaths): Promise<PromptPurposeDefinition[]> {
    const [{loadAgentPromptDefinitions}, {loadExtractionPromptDefinitions}, {loadWritingPromptDefinitions}] = await Promise.all([
        import("./agent-catalog"), import("./extraction-catalog"), import("./writing-catalog"),
    ]);
    const definitions = [...await loadAgentPromptDefinitions(paths), ...await loadExtractionPromptDefinitions(paths), ...loadWritingPromptDefinitions()]
        .filter(definition => definition.purposeId !== "writing.writer");
    if (new Set(definitions.map(definition => definition.purposeId)).size !== definitions.length) throw new Error("提示词调用用途重复");
    return definitions.map(definition => PromptPurposeDefinitionSchema.parse(definition));
}

export class PromptManagementService {
    private readonly root: string;
    constructor(private readonly paths: RuntimePaths, private readonly definitions?: readonly PromptPurposeDefinition[]) {
        this.root = resolve(paths.stateRoot, "prompt-management");
    }
    private async definitionList(): Promise<PromptPurposeDefinition[]> {return this.definitions ? this.definitions.map(value => PromptPurposeDefinitionSchema.parse(value)) : loadDefinitions(this.paths);}
    private async readStore(): Promise<Store> {
        const raw = await readJson(join(this.root, "presets.json"));
        return raw === null ? {schemaVersion: 1, revision: 0, purposes: {}} : StoreSchema.parse(raw);
    }
    private project(definitions: readonly PromptPurposeDefinition[], store: Store): PromptCatalogDto {
        return {revision: store.revision, purposes: definitions.map(definition => {
            const stored = store.purposes[definition.purposeId];
            const presets = [{id: "builtin", name: "内置默认", builtin: true, revision: 1, entries: definition.entries},
                ...(stored?.presets ?? []).filter(preset => preset.id !== "builtin" && !preset.builtin)];
            const selectedPresetId = presets.some(preset => preset.id === stored?.selectedPresetId) ? stored!.selectedPresetId : "builtin";
            return {...definition, presets, selectedPresetId};
        })};
    }
    async catalog(): Promise<PromptCatalogDto> {return this.project(await this.definitionList(), await this.readStore());}
    private scopeHash(scope: TavernVariableScope): string {
        return createHash("sha256").update(JSON.stringify([scope.projectRoot, scope.purposeId, scope.presetId])).digest("hex");
    }
    private variablePath(scope: TavernVariableScope): string {
        return join(this.root, "tavern-variables", `${this.scopeHash(scope)}.json`);
    }
    private compilationPath(scope: TavernVariableScope): string {
        const attemptHash = createHash("sha256").update(scope.attemptKey).digest("hex");
        return join(this.root, "tavern-compilations", `${this.scopeHash(scope)}-${attemptHash}.json`);
    }
    private async readCompilation(scope: TavernVariableScope, index: {ownerKey: string; sha256: string}): Promise<FrozenWriterPrompt> {
        if (index.ownerKey !== scope.ownerKey) throw new Error("酒馆编译收据作用域不一致");
        let bytes: string;
        try {bytes = await readFile(this.compilationPath(scope), "utf8");}
        catch (error) {
            if (missing(error)) throw new Error("已提交的酒馆编译收据缺失；未重新求值", {cause: error});
            throw error;
        }
        if (createHash("sha256").update(bytes).digest("hex") !== index.sha256) throw new Error("酒馆编译收据内容校验失败；未重新求值");
        const receipt = FrozenWriterPromptSchema.parse(JSON.parse(bytes));
        if (!sameScope(receipt.variableScope, scope)) throw new Error("酒馆编译收据作用域不一致");
        if (!receipt.tavernState) throw new Error("酒馆编译收据缺少变量终态");
        return receipt;
    }
    private async readVariables(scope: TavernVariableScope, initial: {local: Record<string, string>; global: Record<string, string>}) {
        const raw = await readJson(this.variablePath(scope));
        const store = raw === null ? {schemaVersion: 2 as const, projectRoot: scope.projectRoot, purposeId: scope.purposeId, presetId: scope.presetId,
            global: {...initial.global}, locals: {}, attempts: {}, outputApplied: []} : VariablesSchema.parse(raw);
        if (store.projectRoot !== scope.projectRoot || store.purposeId !== scope.purposeId || store.presetId !== scope.presetId) throw new Error("酒馆变量作用域校验失败");
        return VariablesSchema.parse(store);
    }
    /** Only an atomic state index commits a receipt; an orphan receipt cannot advance variables or be replayed as sent input. */
    async compileWriter(scope: TavernVariableScope, initial: {local: Record<string, string>; global: Record<string, string>},
        compile: (variables: {local: Record<string, string>; global: Record<string, string>}) => FrozenWriterPrompt,
    ): Promise<FrozenWriterPrompt> {
        return serialized(this.root, async () => {
            const store = await this.readVariables(scope, initial);
            const existing = Object.hasOwn(store.attempts, scope.attemptKey) ? store.attempts[scope.attemptKey] : undefined;
            if (existing) return this.readCompilation(scope, existing);
            const local = Object.hasOwn(store.locals, scope.ownerKey) ? store.locals[scope.ownerKey]! : initial.local;
            const frozen = FrozenWriterPromptSchema.parse({...compile({local: {...local}, global: {...store.global}}), variableScope: scope});
            if (!frozen.tavernState) throw new Error("酒馆写手缺少编译变量终态");
            const sha256 = createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
            await writeJson(this.compilationPath(scope), frozen);
            Object.defineProperty(store.locals, scope.ownerKey, {value: frozen.tavernState.local, configurable: true, enumerable: true, writable: true});
            store.global = frozen.tavernState.global;
            Object.defineProperty(store.attempts, scope.attemptKey, {value: {ownerKey: scope.ownerKey, sha256}, configurable: true, enumerable: true, writable: true});
            await writeJson(this.variablePath(scope), store);
            return frozen;
        });
    }
    /** Output macros apply only their delta; concurrent attempts cannot overwrite another attempt's variable update. */
    async applyWriterOutput(scope: TavernVariableScope, after: {local: Record<string, string>; global: Record<string, string>}): Promise<void> {
        return serialized(this.root, async () => {
            const store = await this.readVariables(scope, {local: {}, global: {}});
            const index = Object.hasOwn(store.attempts, scope.attemptKey) ? store.attempts[scope.attemptKey] : undefined;
            if (!index) throw new Error("酒馆输出缺少对应编译收据");
            const frozen = await this.readCompilation(scope, index);
            if (!frozen.tavernState) throw new Error("酒馆输出缺少对应编译变量终态");
            if (store.outputApplied.includes(scope.attemptKey)) return;
            const local = Object.hasOwn(store.locals, scope.ownerKey) ? store.locals[scope.ownerKey]! : {};
            for (const [kind, current] of [["local", local], ["global", store.global]] as const) {
                const before = frozen.tavernState[kind];
                for (const key of Object.keys(before)) {
                    if (Object.hasOwn(after[kind], key)) continue;
                    const currentValue = Object.hasOwn(current, key) ? current[key] : undefined;
                    if (currentValue !== undefined && currentValue !== before[key]) {
                        throw new Error(`酒馆输出变量并发冲突：${kind}.${key}；原输出已保留`);
                    }
                    delete current[key];
                }
                for (const [key, value] of Object.entries(after[kind])) {
                    const previous = Object.hasOwn(before, key) ? before[key] : undefined;
                    const currentValue = Object.hasOwn(current, key) ? current[key] : undefined;
                    if (value === previous) continue;
                    if (currentValue !== previous && currentValue !== value) throw new Error(`酒馆输出变量并发冲突：${kind}.${key}；原输出已保留`);
                    Object.defineProperty(current, key, {value, configurable: true, enumerable: true, writable: true});
                }
            }
            Object.defineProperty(store.locals, scope.ownerKey, {value: local, configurable: true, enumerable: true, writable: true});
            store.outputApplied.push(scope.attemptKey);
            await writeJson(this.variablePath(scope), store);
        });
    }
    private async validateTavern(definition: PromptPurposeDefinition, tavern: TavernWriterPreset): Promise<void> {
        if (definition.purposeId !== "writing.writer.scene" && definition.purposeId !== "writing.writer.rewrite") throw new Error("酒馆预设仅支持写手用途");
        const budget = await prepareTavernBudget(tavern);
        if (tavern.writerMappings !== undefined) {
            const variables = Object.fromEntries(definition.variables.map(name => [name, `【${name}】`]));
            compileWriterTavern(definition.purposeId, tavern, variables, definition.requiredVariables ?? [], budget);
            return;
        }
        const compiled = compileTavernPreset(tavern.sourceJson, tavern.bindings, {macroEngine: tavern.macroEngine, budget,
            generation: {...extractTavernGeneration(tavern.sourceJson), ...tavern.generationOverride}});
        if (budget) validateTavernRetainedFacts(tavern.bindings, compiled.retainedHistoryIndices, definition.requiredVariables ?? [], tavern.sourceJson);
        extractTavernGeneration(tavern.sourceJson);
        const active = new Set(tavernPromptsForGeneration(parseTavernPreset(tavern.sourceJson), tavern.bindings.generationType)
            .filter(prompt => prompt.marker).map(prompt => prompt.identifier));
        const bound = Object.entries(tavern.bindings.slots).filter(([id]) => active.has(id)).flatMap(([, messages]) => messages);
        const entry = {id: "bindings", name: "小说资料绑定", role: "user" as const,
            content: [tavern.bindings.user, tavern.bindings.char, ...bound.map(message => message.content)].join("\n")};
        const macroNames = supportedTavernMacroNames(tavern.macroEngine);
        const bindingMacros = [...promptVariableNames([entry])].filter(name => macroNames.has(name.toLowerCase()));
        validatePromptEntries({...definition, variables: [...definition.variables, ...TAVERN_ENV_MACROS, ...bindingMacros]}, [entry]);
    }
    /** Preview uses explicit inputs only; it cannot advance a writing session's persistent variables. */
    async preview(input: TavernPreviewRequest): Promise<TavernPreviewResult> {
        const request = TavernPreviewRequestSchema.parse(input);
        try {
            const definition = (await this.definitionList()).find(value => value.purposeId === request.purposeId);
            if (!definition) throw new Error("未知的提示词调用用途");
            await this.validateTavern(definition, request.tavern);
            const variables = Object.fromEntries(definition.variables.map(name => [name, `【${name}】`]));
            Object.assign(variables, request.variables);
            const budget = await prepareTavernBudget(request.tavern);
            const compiled = compileWriterTavern(request.purposeId, request.tavern, variables, definition.requiredVariables ?? [], budget);
            return {...compiled, generation: {...extractTavernGeneration(request.tavern.sourceJson), ...request.tavern.generationOverride}};
        } catch (error) {throw createError({statusCode: 400, message: error instanceof Error ? error.message : "酒馆预设无效"});}
    }
    async mutate(input: PromptMutationDto): Promise<PromptCatalogDto> {
        const request = PromptMutationDtoSchema.parse(input);
        return serialized(this.root, async () => {
            const definitions = await this.definitionList();
            const definition = definitions.find(value => value.purposeId === request.purposeId);
            if (!definition) throw createError({statusCode: 400, message: "未知的提示词调用用途"});
            const store = await this.readStore();
            if (store.revision !== request.expectedRevision) throw createError({statusCode: 409, message: "提示词配置已被另一处修改，请刷新后重试；本次草稿未保存"});
            const purpose = store.purposes[request.purposeId] ?? {selectedPresetId: "builtin", presets: []};
            if ("presetId" in request && request.action !== "select" && request.presetId === "builtin") throw createError({statusCode: 403, message: "内置默认预设不可修改或删除，请新建副本后编辑"});
            if (request.action === "import-tavern") {
                if (request.purposeId !== "writing.writer.scene" && request.purposeId !== "writing.writer.rewrite") throw createError({statusCode: 400, message: "酒馆预设仅支持写手用途"});
                const existing = purpose.presets.find(value => value.id === request.presetId);
                if (request.presetId && !existing) throw createError({statusCode: 404, message: "提示词预设不存在"});
                if (existing && !existing.tavern) throw createError({statusCode: 400, message: "普通预设不能被原生酒馆预设覆盖，请另存"});
                if (!existing && purpose.presets.length >= 64) throw createError({statusCode: 400, message: "每个用途最多保留 64 个自定义预设"});
                try {
                    await this.validateTavern(definition, request.tavern);
                } catch (error) {throw createError({statusCode: 400, message: error instanceof Error ? error.message : "酒馆预设无效"});}
                const preset = {id: existing?.id ?? randomUUID(), name: request.name, builtin: false, revision: (existing?.revision ?? 0) + 1, entries: [], tavern: request.tavern};
                purpose.presets = [...purpose.presets.filter(value => value.id !== preset.id), preset];
                purpose.selectedPresetId = preset.id;
            } else if (request.action === "save") {
                try {validatePromptEntries(definition, request.entries);} catch (error) {throw createError({statusCode: 400, message: error instanceof Error ? error.message : "提示词无效"});}
                const existing = purpose.presets.find(value => value.id === request.presetId);
                if (existing?.tavern) throw createError({statusCode: 400, message: "原生酒馆预设不能用普通条目覆盖，请重新导入"});
                if (request.presetId && !existing) throw createError({statusCode: 404, message: "提示词预设不存在"});
                if (!existing && purpose.presets.length >= 64) throw createError({statusCode: 400, message: "每个用途最多保留 64 个自定义预设"});
                const preset = {id: existing?.id ?? randomUUID(), name: request.name, builtin: false, revision: (existing?.revision ?? 0) + 1, entries: request.entries};
                purpose.presets = [...purpose.presets.filter(value => value.id !== preset.id), preset];
                purpose.selectedPresetId = preset.id;
            } else if (request.action === "toggle") {
                if (request.purposeId !== "writing.writer.scene" && request.purposeId !== "writing.writer.rewrite") throw createError({statusCode: 400, message: "仅写手支持即时保存启用状态，其他用途请保存整个预设"});
                const preset = purpose.presets.find(value => value.id === request.presetId);
                if (!preset) throw createError({statusCode: 404, message: "请先保存写手预设，再切换启用状态"});
                if (preset.tavern) throw createError({statusCode: 400, message: "原生酒馆预设请修改 prompt_order 后重新导入"});
                if (!preset.entries.some(entry => entry.id === request.entryId)) throw createError({statusCode: 404, message: "提示词条目不存在，请保存新条目后再切换"});
                const entries = preset.entries.map(entry => entry.id === request.entryId ? {...entry, enabled: request.enabled} : entry);
                try {validatePromptEntries(definition, entries);} catch (error) {throw createError({statusCode: 400, message: error instanceof Error ? error.message : "提示词无效"});}
                preset.entries = entries;
                preset.revision += 1;
            } else {
                if (request.presetId !== "builtin" && !purpose.presets.some(value => value.id === request.presetId)) throw createError({statusCode: 404, message: "提示词预设不存在"});
                if (request.action === "select") purpose.selectedPresetId = request.presetId;
                else {
                    purpose.presets = purpose.presets.filter(value => value.id !== request.presetId);
                    if (purpose.selectedPresetId === request.presetId) purpose.selectedPresetId = "builtin";
                }
            }
            store.purposes[request.purposeId] = purpose;
            store.revision += 1;
            await writeJson(join(this.root, "presets.json"), store);
            return this.project(definitions, store);
        });
    }
    private async captureUnlocked(mode: "active" | "builtin"): Promise<PromptSnapshot> {
        const catalog = await this.catalog();
        const purposes: PromptSnapshot["purposes"] = {};
        for (const purpose of [...catalog.purposes].sort((a, b) => a.purposeId.localeCompare(b.purposeId))) {
            const preset = purpose.presets.find(value => value.id === (mode === "builtin" ? "builtin" : purpose.selectedPresetId))!;
            purposes[purpose.purposeId] = {presetId: preset.id, presetRevision: preset.revision, entries: structuredClone(preset.entries),
                ...(mode === "active" ? {messageOrder: "configured" as const} : {}), ...(preset.tavern ? {tavern: structuredClone(preset.tavern), requiredVariables: purpose.requiredVariables ?? []} : {})};
        }
        const snapshot: PromptSnapshot = {schemaVersion: 1, id: snapshotHash(purposes), purposes};
        const path = join(this.root, "snapshots", `${snapshot.id}.json`);
        const existing = await readJson(path);
        if (existing === null) await writeJson(path, snapshot);
        else await this.readSnapshot(snapshot.id);
        return snapshot;
    }
    async capture(mode: "active" | "builtin" = "active"): Promise<PromptSnapshot> {return serialized(this.root, () => this.captureUnlocked(mode));}
    async readSnapshot(id: string): Promise<PromptSnapshot> {
        if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("提示词版本标识无效");
        const raw = await readJson(join(this.root, "snapshots", `${id}.json`));
        if (raw === null) throw new Error("无法恢复此会话使用的提示词版本，请检查运行数据；未切换为当前配置");
        const snapshot = PromptSnapshotSchema.parse(raw);
        if (snapshot.id !== id || snapshotHash(snapshot.purposes) !== id) throw new Error("提示词版本内容校验失败");
        return snapshot;
    }
    private bindingPath(key: string): string {
        if (!key || key.length > 1024) throw new Error("提示词绑定标识无效");
        return join(this.root, "bindings", `${createHash("sha256").update(key).digest("hex")}.json`);
    }
    async bound(key: string): Promise<PromptSnapshot | null> {
        const raw = await readJson(this.bindingPath(key));
        if (raw === null) return null;
        const binding = BindingSchema.parse(raw);
        if (binding.key !== key) throw new Error("提示词绑定校验失败");
        return this.readSnapshot(binding.snapshotId);
    }
    async bind(key: string, options: {mode?: "active" | "builtin"; inheritSnapshotId?: string} = {}): Promise<PromptSnapshot> {
        return serialized(this.root, async () => {
            const existing = await this.bound(key);
            if (existing) return existing;
            const snapshot = options.inheritSnapshotId ? await this.readSnapshot(options.inheritSnapshotId) : await this.captureUnlocked(options.mode ?? "active");
            await writeJson(this.bindingPath(key), {schemaVersion: 1, key, snapshotId: snapshot.id});
            return snapshot;
        });
    }
}

export function usePromptManagement(paths: RuntimePaths = runtimePathsFromEnv()): PromptManagementService {return new PromptManagementService(paths);}
