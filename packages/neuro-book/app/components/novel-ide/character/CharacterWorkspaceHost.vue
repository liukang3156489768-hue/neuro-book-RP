<script setup lang="ts">
import {computed, ref, watch} from "vue";
import CharacterWorkspace from "./CharacterWorkspace.vue";
import type {
    CharacterFacetDto,
    CharacterProfileDto,
    CharacterRecordDto,
    CharacterWorkspaceSnapshotDto,
} from "nbook/shared/dto/character-workspace.dto";

const props = defineProps<{projectRoot: string}>();
const emit = defineEmits<{
    (event: "open-file", path: string): void;
}>();

type WorkspaceApi = CharacterWorkspaceSnapshotDto;
type CharacterWorkspaceInstance = {
    requestLeave: (action: () => void) => void;
    hasUnsaved: boolean;
    saving: boolean;
};

const workspace = ref<WorkspaceApi>({characters: [], plans: []});
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const generation = ref(0);
const viewRef = ref<CharacterWorkspaceInstance | null>(null);
function avatarUrl(characterId: string, path: string): string {
    const query = new URLSearchParams({projectRoot: props.projectRoot, path: `lorebook/character/${characterId}/${path}`});
    return `/api/projects/characters/avatar?${query.toString()}`;
}

function withAvatarUrls(snapshot: WorkspaceApi): WorkspaceApi {
    return {
        ...snapshot,
        characters: snapshot.characters.map((character) => ({
            ...character,
            profile: character.profile
                ? {...character.profile, avatarUrl: character.profile.avatar ? avatarUrl(character.id, character.profile.avatar) : ""}
                : null,
        })),
    };
}

async function load(): Promise<void> {
    const requestGeneration = ++generation.value;
    loading.value = true;
    error.value = "";
    try {
        const snapshot = await $fetch<WorkspaceApi>("/api/projects/characters", {query: {projectRoot: props.projectRoot}});
        if (requestGeneration !== generation.value) return;
        workspace.value = withAvatarUrls(snapshot);
    } catch (cause) {
        if (requestGeneration !== generation.value) return;
        error.value = cause instanceof Error ? cause.message : "角色资料读取失败。";
    } finally {
        if (requestGeneration === generation.value) loading.value = false;
    }
}

function recordFor(id: string): CharacterRecordDto {
    const record = workspace.value.characters.find((item) => item.id === id);
    if (!record) throw new Error("角色资料已不存在，请刷新页面。");
    return record;
}

function expectedMtime(record: CharacterRecordDto, planId: string, kind: "experience" | "relationships" | "knowledge" | "state"): number | null {
    if (planId === "original") return null;
    return record.files.plans[planId]?.[kind]?.mtimeMs ?? null;
}

async function fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
}

async function commitProfile(id: string, profile: CharacterProfileDto, avatarFile?: File | null): Promise<void> {
    const record = recordFor(id);
    saving.value = true;
    try {
        const body = {
            projectRoot: props.projectRoot,
            characterId: id,
            profile,
            expectedMtimeMs: record.files.profile?.mtimeMs ?? null,
            ...(avatarFile ? {avatarUpload: {base64: await fileToBase64(avatarFile), mime: avatarFile.type}} : {}),
        };
        const snapshot = await $fetch<WorkspaceApi>("/api/projects/characters/profile", {
            method: "PUT",
            body,
        });
        workspace.value = withAvatarUrls(snapshot);
    } finally {
        saving.value = false;
    }
}

async function commitFacet(id: string, planId: string, kind: "experience" | "relationships" | "knowledge" | "state", facet: CharacterFacetDto): Promise<void> {
    if (planId === "original") throw new Error("原作资料只读，请切换到改编方案。");
    const record = recordFor(id);
    saving.value = true;
    try {
        const snapshot = await $fetch<WorkspaceApi>("/api/projects/characters/facet", {
            method: "PUT",
            body: {projectRoot: props.projectRoot, characterId: id, planId, kind, facet, expectedMtimeMs: expectedMtime(record, planId, kind)},
        });
        workspace.value = withAvatarUrls(snapshot);
    } finally {
        saving.value = false;
    }
}

function requestLeave(action: () => void): void {
    viewRef.value?.requestLeave(action) ?? action();
}

watch(() => props.projectRoot, () => void load(), {immediate: true});

defineExpose({
    hasUnsaved: computed(() => Boolean(viewRef.value?.hasUnsaved)),
    saving: computed(() => saving.value || Boolean(viewRef.value?.saving)),
    requestLeave,
    reload: load,
});
</script>

<template>
    <section class="character-workspace-host flex h-full w-full min-h-0 min-w-0 flex-col" aria-label="角色管理工作台">
        <div v-if="loading && !workspace.characters.length" class="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--text-muted)]">正在读取角色资料…</div>
        <div v-else-if="error && !workspace.characters.length" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
            <p role="alert">{{ error }}</p>
            <button type="button" class="rounded border border-[var(--divider)] px-3 py-1.5" @click="void load()">重新读取</button>
        </div>
        <CharacterWorkspace
            v-else
            ref="viewRef"
            :characters="workspace.characters"
            :plans="workspace.plans"
            :loading="loading"
            :saving="saving"
            :error="error"
            :commit-profile="commitProfile"
            :commit-facet="commitFacet"
            :open-file="(path: string) => emit('open-file', path)"
        />
        <div v-if="error && workspace.characters.length" class="shrink-0 border-t border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] px-3 py-1.5 text-xs" role="alert">
            {{ error }}
            <button type="button" class="ml-2 underline" @click="void load()">重新读取</button>
        </div>
    </section>
</template>
