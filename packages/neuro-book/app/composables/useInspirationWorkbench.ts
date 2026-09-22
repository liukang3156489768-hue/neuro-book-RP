import type {InspirationArtifactDto, InspirationCategory, InspirationConversationDto, InspirationConversationSummaryDto, InspirationDraftDto, InspirationSaveResultDto} from "nbook/shared/dto/inspiration.dto";
import type {InspirationSourceFileDto, InspirationSourceListResponseDto, InspirationSourcePrepareResponseDto} from "nbook/shared/dto/inspiration-source.dto";
import {INSPIRATION_CATEGORIES} from "nbook/shared/dto/inspiration.dto";
import {resolveApiErrorMessage} from "nbook/app/utils/api-error";
import type {EnabledModelOptionDto} from "nbook/shared/dto/app-settings.dto";

export type InspirationArtifactDraft = Pick<InspirationArtifactDto, "id" | "category" | "title" | "content" | "sessionId" | "source">;
export type InspirationMode = "design" | "extract";

export function useInspirationWorkbench(projectRoot: Ref<string | null>) {
    const request = ref(""); const feedback = ref(""); const mode = ref<InspirationMode>("design");
    const draft = ref<InspirationDraftDto | null>(null); const artifacts = ref<InspirationArtifactDraft[]>([]);
    const sources = ref<InspirationSourceFileDto[]>([]); const sourcePreview = ref<InspirationSourcePrepareResponseDto | null>(null);
    const selectedSource = ref(""); const selectedChunks = ref<number[]>([]); const selectedCategories = ref<InspirationCategory[]>([...INSPIRATION_CATEGORIES]);
    const conversations = ref<InspirationConversationSummaryDto[]>([]); const conversation = ref<InspirationConversationDto | null>(null);
    const loading = ref(false); const loadingSources = ref(false); const loadingConversations = ref(false); const saving = ref(false); const error = ref("");
    const modelOptions = ref<EnabledModelOptionDto[]>([]); const modelKey = ref<string | undefined>(); const thinkingEnabled = ref(true); const temperature = ref(0.7);
    const selectedArtifactIds = ref<string[]>([]); const refiningArtifactId = ref<string | null>(null);
    const requestId = ref<string | null>(null); let controller: AbortController | null = null;

    async function loadSources(): Promise<void> {
        if (!projectRoot.value) return; loadingSources.value = true;
        try { sources.value = (await $fetch<InspirationSourceListResponseDto>("/api/inspiration/sources", {query: {projectRoot: projectRoot.value}})).sources; }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法读取作品来源"); } finally { loadingSources.value = false; }
    }
    async function prepareSource(path: string): Promise<void> {
        if (!projectRoot.value || !path) return; selectedSource.value = path; sourcePreview.value = null; selectedChunks.value = [];
        try { sourcePreview.value = await $fetch<InspirationSourcePrepareResponseDto>("/api/inspiration/source-prepare", {method: "POST", body: {projectRoot: projectRoot.value, path}}); selectedChunks.value = sourcePreview.value.chunks.map(chunk => chunk.index); }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法预览作品来源"); }
    }
    async function loadConversations(): Promise<void> {
        if (!projectRoot.value) return; loadingConversations.value = true;
        try {
            conversations.value = await $fetch<InspirationConversationSummaryDto[]>("/api/inspiration/conversations", {query: {projectRoot: projectRoot.value}});
            if (!conversation.value && conversations.value[0]) await openConversation(conversations.value[0].id);
        }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法读取聊天记录"); } finally { loadingConversations.value = false; }
    }
    async function loadModelOptions(): Promise<void> {
        if (!projectRoot.value) return;
        try {
            const result = await useConfigApi().bootstrap({workspaceKind: "novel", projectRoot: projectRoot.value});
            modelOptions.value = result.modelSettings.enabledModels;
            if (!modelKey.value && modelOptions.value[0]) modelKey.value = modelOptions.value[0].key;
        } catch (cause) { error.value = resolveApiErrorMessage(cause, "无法读取模型配置"); }
    }
    async function createConversation(): Promise<InspirationConversationDto | null> {
        if (!projectRoot.value) return null;
        try { conversation.value = await $fetch<InspirationConversationDto>("/api/inspiration/conversations", {method: "POST", body: {projectRoot: projectRoot.value, title: mode.value === "extract" ? "作品分析与提取" : "原创设计"}}); draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; feedback.value = ""; await loadConversations(); return conversation.value; }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法新建聊天记录"); return null; }
    }
    async function openConversation(id: string, resetDraft = true): Promise<void> {
        if (!projectRoot.value) return;
        try {
            const nextConversation = await $fetch<InspirationConversationDto>(`/api/inspiration/conversations/${id}`, {query: {projectRoot: projectRoot.value}});
            conversation.value = nextConversation;
            if (resetDraft) { draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; feedback.value = ""; }
            const draftId = [...nextConversation.messages].reverse().find(message => message.draftId)?.draftId;
            if (draftId) {
                const nextDraft = await $fetch<InspirationDraftDto>(`/api/inspiration/drafts/${draftId}`, {query: {projectRoot: projectRoot.value}});
                draft.value = nextDraft; artifacts.value = nextDraft.artifacts.map(item => ({...item}));
            }
        }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法打开聊天记录"); }
    }
    async function archiveConversation(): Promise<void> {
        if (!projectRoot.value || !conversation.value) return;
        try { await $fetch(`/api/inspiration/conversations/${conversation.value.id}/archive`, {method: "POST", body: {projectRoot: projectRoot.value}}); conversation.value = null; await loadConversations(); }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "无法归档聊天记录"); }
    }
    async function ensureConversation(): Promise<InspirationConversationDto | null> { return conversation.value ?? createConversation(); }
    async function generate(): Promise<InspirationDraftDto | null> {
        if (!projectRoot.value || !request.value.trim()) return null;
        if (mode.value === "extract" && (!selectedSource.value || !selectedChunks.value.length || !selectedCategories.value.length)) { error.value = "请选择作品来源、分析范围和提取目标"; return null; }
        const activeConversation = await ensureConversation(); if (!activeConversation) return null;
        loading.value = true; error.value = ""; const id = crypto.randomUUID(); requestId.value = id; controller?.abort(); controller = new AbortController();
        try {
            const result = mode.value === "extract"
                ? await $fetch<InspirationDraftDto>("/api/inspiration/extract", {method: "POST", body: {projectRoot: projectRoot.value, requestId: id, conversationId: activeConversation.id, request: request.value.trim(), path: selectedSource.value, chunkIndexes: selectedChunks.value, categories: selectedCategories.value, modelKey: modelKey.value, thinkingEnabled: thinkingEnabled.value, temperature: temperature.value}, signal: controller.signal})
                : await $fetch<InspirationDraftDto>("/api/inspiration/generate", {method: "POST", body: {projectRoot: projectRoot.value, requestId: id, request: request.value.trim(), conversationId: activeConversation.id, ...(draft.value ? {draftId: draft.value.id, revision: draft.value.revision} : {}), ...(feedback.value.trim() ? {feedback: feedback.value.trim()} : {}), modelKey: modelKey.value, thinkingEnabled: thinkingEnabled.value, temperature: temperature.value}, signal: controller.signal});
            draft.value = result; artifacts.value = result.artifacts.map(item => ({...item})); feedback.value = ""; request.value = "";
            await openConversation(activeConversation.id, false); await loadConversations(); return result;
        } catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) error.value = resolveApiErrorMessage(cause, mode.value === "extract" ? "作品分析失败，请稍后重试" : "设计生成失败，请稍后重试"); return null; }
        finally { loading.value = false; }
    }
    async function cancel(): Promise<void> { if (!projectRoot.value || !requestId.value) return; controller?.abort(); try { await $fetch("/api/inspiration/cancel", {method: "POST", body: {projectRoot: projectRoot.value, requestId: requestId.value}}); } catch { /* request is already locally aborted */ } }
    async function save(): Promise<InspirationSaveResultDto | null> {
        if (!projectRoot.value || !draft.value) return null; saving.value = true; error.value = "";
        try { return await $fetch<InspirationSaveResultDto>("/api/inspiration/save", {method: "POST", body: {projectRoot: projectRoot.value, draftId: draft.value.id, revision: draft.value.revision, artifacts: artifacts.value.map(item => ({id: item.id, title: item.title, content: item.content}))}}); }
        catch (cause) { error.value = resolveApiErrorMessage(cause, "保存设计成果失败"); return null; } finally { saving.value = false; }
    }
    function toggleArtifact(id: string): void { selectedArtifactIds.value = selectedArtifactIds.value.includes(id) ? selectedArtifactIds.value.filter(item => item !== id) : [...selectedArtifactIds.value, id]; }
    function selectVisible(ids: string[]): void { selectedArtifactIds.value = [...new Set([...selectedArtifactIds.value, ...ids])]; }
    function deselectVisible(ids: string[]): void { const hidden = new Set(ids); selectedArtifactIds.value = selectedArtifactIds.value.filter(id => !hidden.has(id)); }
    function removeSelected(): void { const selected = new Set(selectedArtifactIds.value); artifacts.value = artifacts.value.filter(item => !selected.has(item.id)); selectedArtifactIds.value = []; }
    async function refineArtifact(artifactId: string, action: "refine" | "ask", instruction: string): Promise<string | null> {
        if (!projectRoot.value || !draft.value || !conversation.value || !instruction.trim()) return null;
        refiningArtifactId.value = artifactId; error.value = "";
        try {
            const result = await $fetch<{draft: InspirationDraftDto; answer?: string}>("/api/inspiration/refine", {method: "POST", body: {projectRoot: projectRoot.value, requestId: crypto.randomUUID(), conversationId: conversation.value.id, draftId: draft.value.id, revision: draft.value.revision, artifactId, action, instruction: instruction.trim(), modelKey: modelKey.value, thinkingEnabled: thinkingEnabled.value, temperature: temperature.value}});
            if (action === "refine") { draft.value = result.draft; artifacts.value = result.draft.artifacts.map(item => ({...item})); selectedArtifactIds.value = []; }
            await openConversation(conversation.value.id, false); await loadConversations(); return result.answer ?? null;
        } catch (cause) { error.value = resolveApiErrorMessage(cause, action === "ask" ? "追问失败" : "重新提取失败"); return null; }
        finally { refiningArtifactId.value = null; }
    }
    function reset(): void { request.value = ""; feedback.value = ""; draft.value = null; artifacts.value = []; selectedArtifactIds.value = []; sourcePreview.value = null; selectedSource.value = ""; selectedChunks.value = []; conversation.value = null; conversations.value = []; error.value = ""; }
    watch(projectRoot, () => { reset(); if (projectRoot.value) { void loadSources(); void loadConversations(); void loadModelOptions(); } }, {immediate: true}); onBeforeUnmount(() => controller?.abort());
    return {request, feedback, mode, draft, artifacts, sources, sourcePreview, selectedSource, selectedChunks, selectedCategories, conversations, conversation, loading, loadingSources, loadingConversations, saving, error, modelOptions, modelKey, thinkingEnabled, temperature, selectedArtifactIds, refiningArtifactId, generate, cancel, save, loadSources, prepareSource, loadConversations, createConversation, openConversation, archiveConversation, loadModelOptions, toggleArtifact, selectVisible, deselectVisible, removeSelected, refineArtifact, reset};
}
