<script setup lang="ts">
import {computed} from "vue";
import {Button, FormField, FormInput} from "@notnotype/nb-ui/components";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import type {VolumeDraft} from "nbook/app/composables/useInspirationExtraction";

const props = withDefaults(defineProps<{
    mode: "chapters" | "chunks";
    chapterCount: number;
    chunkCount: number;
    volumes: readonly VolumeDraft[];
    chunksPerVolume: string;
    error?: string;
    checking?: boolean;
    valid?: boolean;
}>(), {error: "", checking: false, valid: false});

const emit = defineEmits<{
    (event: "update:volumes", volumes: VolumeDraft[]): void;
    (event: "update:chunksPerVolume", value: string): void;
    (event: "restore"): void;
}>();

const expectedVolumes = computed(() => {
    const perVolume = Number(props.chunksPerVolume);
    return Number.isInteger(perVolume) && perVolume > 0 ? Math.ceil(props.chunkCount / perVolume) : null;
});

function patch(position: number, change: Partial<VolumeDraft>): void {
    emit("update:volumes", props.volumes.map((volume, index) => index === position ? {...volume, ...change} : volume));
}

function remove(position: number): void {
    emit("update:volumes", props.volumes.filter((_, index) => index !== position));
}

function add(): void {
    const previousLast = Number(props.volumes.at(-1)?.last);
    const first = Number.isInteger(previousLast) ? String(previousLast + 1) : "";
    emit("update:volumes", [...props.volumes, {title: "", first, last: ""}]);
}
</script>

<template>
    <section class="division-editor" aria-label="划卷">
        <template v-if="props.mode === 'chapters'">
            <p v-if="!props.volumes.length" class="hint">尚无划分，可以点“恢复默认划分”使用系统建议，或自行添加。</p>
            <ol class="volume-list">
                <li v-for="(volume, position) in props.volumes" :key="position" class="volume-row">
                    <span class="volume-index">第 {{ position + 1 }} 卷</span>
                    <FormField label="卷名（可选）" class="cell cell-title">
                        <FormInput :model-value="volume.title" placeholder="留空使用默认卷名" @update:model-value="patch(position, {title: $event})" />
                    </FormField>
                    <FormField label="起始章" class="cell">
                        <FormInput :model-value="volume.first" inputmode="numeric" @update:model-value="patch(position, {first: $event})" />
                    </FormField>
                    <FormField :label="`结束章（共 ${props.chapterCount} 章）`" class="cell">
                        <FormInput :model-value="volume.last" inputmode="numeric" @update:model-value="patch(position, {last: $event})" />
                    </FormField>
                    <Button size="sm" variant="ghost" icon-class="i-lucide-trash-2" :disabled="props.volumes.length <= 1" :aria-label="`删除第 ${position + 1} 卷`" @click="remove(position)">删除</Button>
                </li>
            </ol>
            <div class="toolbar">
                <Button size="sm" variant="secondary" icon-class="i-lucide-plus" @click="add()">添加一卷</Button>
                <Button size="sm" variant="ghost" @click="emit('restore')">恢复默认划分</Button>
            </div>
        </template>
        <template v-else>
            <FormField label="每卷包含的块数" :description="`共 ${props.chunkCount} 块${expectedVolumes ? `，预计分成 ${expectedVolumes} 卷` : ''}`" class="cell">
                <FormInput :model-value="props.chunksPerVolume" inputmode="numeric" @update:model-value="emit('update:chunksPerVolume', $event)" />
            </FormField>
        </template>
        <ExtractionNotice v-if="props.error" tone="danger">{{ props.error }}</ExtractionNotice>
        <ExtractionNotice v-else-if="props.checking" tone="info">正在校验划分…</ExtractionNotice>
        <ExtractionNotice v-else-if="props.valid" tone="success">划分有效，共 {{ props.mode === 'chapters' ? props.volumes.length : expectedVolumes }} 卷。</ExtractionNotice>
    </section>
</template>

<style scoped>
.division-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.volume-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
}

.volume-row {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.volume-index {
    flex: 0 0 auto;
    align-self: center;
    min-width: 3.5em;
    color: var(--text-main);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
}

.cell {
    flex: 1 1 110px;
    min-width: 0;
}

.cell-title {
    flex-basis: 180px;
}

.toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
