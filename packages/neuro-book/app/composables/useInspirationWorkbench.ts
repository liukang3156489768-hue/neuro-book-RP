import {computed, onScopeDispose, ref, watch, type Ref} from "vue";
import type {InspirationArtifactDto, InspirationCategory, InspirationConversationDto, InspirationConversationSummaryDto, InspirationCreationMode, InspirationDraftDto, InspirationMaterialListDto, InspirationSaveResultDto} from "nbook/shared/dto/inspiration.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import type {EnabledModelOptionDto} from "nbook/shared/dto/app-settings.dto";
import {useConfigApi} from "nbook/app/composables/useConfigApi";

export type InspirationArtifactDraft = Pick<InspirationArtifactDto, "id" | "category" | "title" | "content" | "sessionId">;

export function useInspirationWorkbench(projectRoot: Ref<string | null>) {
    const request = ref(""); const feedback = ref("");
    const draft = ref<InspirationDraftDto | null>(null); const artifacts = ref<InspirationArtifactDraft[]>([]);
    const conversations = ref<InspirationConversationSummaryDto[]>([]); const conversation = ref<InspirationConversationDto | null>(null);
    const loading = ref(false); const loadingConversations = ref(false); const saving = ref(false); const error = ref("");
    const modelOptions = ref<EnabledModelOptionDto[]>([]); const modelKey = ref<string | undefined>(); const thinkingEnabled = ref(true); const temperature = ref(0.7);
    const selectedArtifactIds = ref<string[]>([]); const refiningArtifactId = ref<string | null>(null);
    const requestId = ref<string | null>(null); let controller: AbortController | null = null;
    const creationMode = ref<InspirationCreationMode>("original");
    const materialQuery = ref(""); const materialCategory = ref<InspirationCategory | "all">("all");
    const materials = ref<InspirationMaterialListDto["items"]>([]); const materialTotal = ref(0); const materialNextOffset = ref<number | null>(null);
    const loadingMaterials = ref(false); const materialError = ref(""); const materialPaths = ref<string[]>([]);
    const materialNames = ref<Record<string, string>>({});
    let projectGeneration = 0; let materialGeneration = 0; let conversationGeneration = 0; let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const activeMaterialPaths = computed(() => creationMode.value === "adaptation" ? materialPaths.value : []);
    const canReuseDraft = computed(() => Boolean(draft.value && (draft.value.creationMode ?? "original") === creationMode.value
        && JSON.stringify([...(draft.value.materialSources ?? []).map(source => source.path)].sort()) === JSON.stringify([...activeMaterialPaths.value].sort())));
    const canGenerate = computed(() => !loading.value && !saving.value && !refiningArtifactId.value && Boolean(projectRoot.value)
        && (creationMode.value !== "adaptation" || materialPaths.value.length > 0)
        && Boolean(request.value.trim() || (canReuseDraft.value && feedback.value.trim())));

    function materialName(path: string): string { return materialNames.value[path] ?? path.split("/").at(-1)?.replace(/\.md$/u, "") ?? path; }
    function toggleMaterial(path: string): void {
        if (loading.value || saving.value || refiningArtifactId.value) return;
        if (materialPaths.value.includes(path)) materialPaths.value = materialPaths.value.filter(item => item !== path);
        else if (materialPaths.value.length < 12) materialPaths.value = [...materialPaths.value, path];
        else materialError.value = "最多选择 12 项参考素材，请先移除部分选择";
    }
    async function loadMaterials(append = false): Promise<void> {
        const root = projectRoot.value;
        if (!root || creationMode.value !== "adaptation") return;
        const offset = append ? materialNextOffset.value : 0;
        if (offset === null) return;
        const generation = ++materialGeneration;
        loadingMaterials.value = true; materialError.value = "";
        try {
            const result = await $fetch<InspirationMaterialListDto>("/api/inspiration/materials", {query: {projectRoot: root, query: materialQuery.value.trim(),
                ...(materialCategory.value === "all" ? {} : {category: materialCategory.value}), offset, limit: 20}});
            if (generation !== materialGeneration || root !== projectRoot.value) return;
            materials.value = append ? [...materials.value, ...result.items] : result.items;
            materialTotal.value = result.total; materialNextOffset.value = result.nextOffset;
            for (const item of result.items) materialNames.value[item.path] = item.title;
        } catch (cause) { if (generation === materialGeneration) materialError.value = resolveApiErrorMessage(cause, "无法读取参考素材目录"); }
        finally { if (generation === materialGeneration) loadingMaterials.value = false; }
    }

    function restoreDraft(result: InspirationDraftDto, restoreSelection: boolean): void {
        draft.value = result; artifacts.value = result.artifacts.map(item => ({...item})); selectedArtifactIds.value = [];
        if (restoreSelection) {
            creationMode.value = result.creationMode ?? "original";
            materialPaths.value = (result.materialSources ?? []).map(source => source.path);
        }
        for (const source of result.materialSources ?? []) materialNames.value[source.path] = source.title;
    }

    async function loadConversations(): Promise<void> {
        const root = projectRoot.value; const generation = projectGeneration;
        if (!root) return; loadingConversations.value = true;
        try {
            const result = await $fetch<InspirationConversationSummaryDto[]>("/api/inspiration/conversations", {query: {projectRoot: root}});
            if (generation !== projectGeneration) return;
            conversations.value = result;
            if (!conversation.value && conversations.value[0]) await openConversation(conversations.value[0].id);
        }
        catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, "无法读取聊天记录"); } finally { if (generation === projectGeneration) loadingConversations.value = false; }
    }
    async function loadModelOptions(): Promise<void> {
        const root = projectRoot.value; const generation = projectGeneration;
        if (!root) return;
        try {
            const result = await useConfigApi().bootstrap({workspaceKind: "novel", projectRoot: root});
            if (generation !== projectGeneration) return;
            modelOptions.value = result.modelSettings.enabledModels;
            if (!modelKey.value && modelOptions.value[0]) modelKey.value = modelOptions.value[0].key;
        } catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, "无法读取模型配置"); }
    }
    async function createConversation(): Promise<InspirationConversationDto | null> {
        const root = projectRoot.value; const generation = projectGeneration;
        if (!root) return null;
        try { const result = await $fetch<InspirationConversationDto>("/api/inspiration/conversations", {method: "POST", body: {projectRoot: root, title: creationMode.value === "adaptation" ? "素材改编" : "原创设计"}});
            if (generation !== projectGeneration) return null;
            conversationGeneration++; conversation.value = result; draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; feedback.value = ""; await loadConversations(); return result; }
        catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, "无法新建聊天记录"); return null; }
    }
    async function openConversation(id: string, resetDraft = true): Promise<void> {
        const root = projectRoot.value; const project = projectGeneration; const generation = ++conversationGeneration;
        if (!root) return;
        try {
            const nextConversation = await $fetch<InspirationConversationDto>(`/api/inspiration/conversations/${id}`, {query: {projectRoot: root}});
            if (project !== projectGeneration || generation !== conversationGeneration) return;
            conversation.value = nextConversation;
            if (resetDraft) { draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; feedback.value = ""; request.value = ""; }
            const draftId = [...nextConversation.messages].reverse().find(message => message.draftId)?.draftId;
            if (draftId) {
                const nextDraft = await $fetch<InspirationDraftDto>(`/api/inspiration/drafts/${draftId}`, {query: {projectRoot: root}});
                if (project !== projectGeneration || generation !== conversationGeneration) return;
                restoreDraft(nextDraft, resetDraft);
            }
        }
        catch (cause) { if (project === projectGeneration && generation === conversationGeneration) error.value = resolveApiErrorMessage(cause, "无法打开聊天记录"); }
    }
    async function archiveConversation(): Promise<void> {
        const root = projectRoot.value; const generation = projectGeneration; const current = conversation.value;
        if (!root || !current) return;
        try { await $fetch(`/api/inspiration/conversations/${current.id}/archive`, {method: "POST", body: {projectRoot: root}}); if (generation !== projectGeneration) return; conversation.value = null; await loadConversations(); }
        catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, "无法归档聊天记录"); }
    }
    async function ensureConversation(): Promise<InspirationConversationDto | null> { return conversation.value ?? createConversation(); }
    async function generate(): Promise<InspirationDraftDto | null> {
        if (creationMode.value === "adaptation" && !materialPaths.value.length) { error.value = "改编设计需要先选择至少一项参考素材"; return null; }
        if (!canGenerate.value) return null;
        const root = projectRoot.value!; const generation = projectGeneration;
        const mode = creationMode.value; const paths = [...activeMaterialPaths.value]; const previous = canReuseDraft.value ? draft.value : null;
        const intent = request.value.trim() || previous?.request; const note = previous ? feedback.value.trim() : "";
        loading.value = true; error.value = "";
        const id = crypto.randomUUID(); requestId.value = id; controller?.abort(); const runController = new AbortController(); controller = runController;
        try {
            const activeConversation = await ensureConversation(); if (!activeConversation || generation !== projectGeneration || runController.signal.aborted) return null;
            const result = await $fetch<InspirationDraftDto>("/api/inspiration/generate", {method: "POST", body: {projectRoot: root, requestId: id, request: intent, conversationId: activeConversation.id,
                creationMode: mode, materialPaths: paths, ...(previous ? {draftId: previous.id, revision: previous.revision} : {}), ...(note ? {feedback: note} : {}), modelKey: modelKey.value, thinkingEnabled: thinkingEnabled.value, temperature: temperature.value}, signal: runController.signal});
            if (generation !== projectGeneration || runController.signal.aborted) return null;
            restoreDraft(result, false); feedback.value = ""; request.value = "";
            await openConversation(activeConversation.id, false); await loadConversations(); return result;
        } catch (cause) { if (generation === projectGeneration && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = resolveApiErrorMessage(cause, "设计生成失败，请稍后重试"); return null; }
        finally { if (generation === projectGeneration) loading.value = false; }
    }
    async function cancel(): Promise<void> { if (!projectRoot.value || !requestId.value) return; controller?.abort(); try { await $fetch("/api/inspiration/cancel", {method: "POST", body: {projectRoot: projectRoot.value, requestId: requestId.value}}); } catch { /* request is already locally aborted */ } }
    async function save(): Promise<InspirationSaveResultDto | null> {
        if (!projectRoot.value || !draft.value || saving.value || loading.value || refiningArtifactId.value) return null; saving.value = true; error.value = "";
        const generation = projectGeneration;
        try { const result = await $fetch<InspirationSaveResultDto>("/api/inspiration/save", {method: "POST", body: {projectRoot: projectRoot.value, draftId: draft.value.id, revision: draft.value.revision, artifacts: artifacts.value.map(item => ({id: item.id, title: item.title, content: item.content}))}}); return generation === projectGeneration ? result : null; }
        catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, "保存设计成果失败"); return null; } finally { if (generation === projectGeneration) saving.value = false; }
    }
    function toggleArtifact(id: string): void { selectedArtifactIds.value = selectedArtifactIds.value.includes(id) ? selectedArtifactIds.value.filter(item => item !== id) : [...selectedArtifactIds.value, id]; }
    function selectVisible(ids: string[]): void { selectedArtifactIds.value = [...new Set([...selectedArtifactIds.value, ...ids])]; }
    function deselectVisible(ids: string[]): void { const hidden = new Set(ids); selectedArtifactIds.value = selectedArtifactIds.value.filter(id => !hidden.has(id)); }
    function removeSelected(): void { const selected = new Set(selectedArtifactIds.value); artifacts.value = artifacts.value.filter(item => !selected.has(item.id)); selectedArtifactIds.value = []; }
    async function refineArtifact(artifactId: string, action: "refine" | "ask", instruction: string): Promise<string | null> {
        if (!projectRoot.value || !draft.value || !conversation.value || !instruction.trim() || loading.value || saving.value || refiningArtifactId.value) return null;
        const generation = projectGeneration; const conversationId = conversation.value.id;
        const id = crypto.randomUUID(); requestId.value = id; controller?.abort(); const runController = new AbortController(); controller = runController;
        refiningArtifactId.value = artifactId; error.value = "";
        try {
            const result = await $fetch<{draft: InspirationDraftDto; answer?: string}>("/api/inspiration/refine", {method: "POST", body: {projectRoot: projectRoot.value, requestId: id, conversationId: conversation.value.id, draftId: draft.value.id, revision: draft.value.revision, artifactId, action, instruction: instruction.trim(), modelKey: modelKey.value, thinkingEnabled: thinkingEnabled.value, temperature: temperature.value}, signal: runController.signal});
            if (generation !== projectGeneration || conversation.value?.id !== conversationId || runController.signal.aborted) return null;
            if (action === "refine") restoreDraft(result.draft, false);
            await openConversation(conversationId, false); await loadConversations(); return generation === projectGeneration ? result.answer ?? null : null;
        } catch (cause) { if (generation === projectGeneration) error.value = resolveApiErrorMessage(cause, action === "ask" ? "追问失败" : "重新设计失败"); return null; }
        finally { if (generation === projectGeneration) refiningArtifactId.value = null; }
    }
    function reset(): void { projectGeneration++; conversationGeneration++; materialGeneration++; controller?.abort(); clearTimeout(searchTimer); request.value = ""; feedback.value = ""; draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; conversation.value = null; conversations.value = []; error.value = "";
        creationMode.value = "original"; materialPaths.value = []; materials.value = []; materialNames.value = {}; materialQuery.value = ""; materialCategory.value = "all"; materialTotal.value = 0; materialNextOffset.value = null; loadingMaterials.value = false; materialError.value = ""; loading.value = false; saving.value = false; refiningArtifactId.value = null; modelKey.value = undefined; modelOptions.value = []; }
    watch([creationMode, materialQuery, materialCategory], () => { ++materialGeneration; clearTimeout(searchTimer); materials.value = []; materialNextOffset.value = null; materialTotal.value = 0; loadingMaterials.value = false;
        if (creationMode.value === "adaptation") searchTimer = setTimeout(() => { void loadMaterials(); }, 200); }, {flush: "sync"});
    watch(projectRoot, () => { reset(); if (projectRoot.value) { void loadConversations(); void loadModelOptions(); } }, {immediate: true, flush: "sync"});
    onScopeDispose(() => { projectGeneration++; materialGeneration++; controller?.abort(); clearTimeout(searchTimer); });
    return {creationMode, materialQuery, materialCategory, materials, materialTotal, materialNextOffset, loadingMaterials, materialError, materialPaths, materialName, toggleMaterial, loadMaterials, canReuseDraft, canGenerate,
        request, feedback, draft, artifacts, conversations, conversation, loading, loadingConversations, saving, error, modelOptions, modelKey, thinkingEnabled, temperature, selectedArtifactIds, refiningArtifactId, generate, cancel, save, loadConversations, createConversation, openConversation, archiveConversation, loadModelOptions, toggleArtifact, selectVisible, deselectVisible, removeSelected, refineArtifact, reset};
}
