<script setup lang="ts">
import {computed, ref} from "vue";
import {Button, FormCheckbox, FormField, FormInput} from "@notnotype/nb-ui/components";
import type {MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {MaterialReview} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {NODE_ROLE_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

type ReviewItem = MaterialReview["items"][number];
type SplitInput = Extract<MaterialReviewActionDto, {kind: "split"}>["input"];
type MovableRole = "experience" | "relationship";

const props = withDefaults(defineProps<{
    item: ReviewItem;
    busy?: boolean;
    error?: string;
}>(), {busy: false, error: ""});

const emit = defineEmits<{
    (event: "split", input: SplitInput): void;
    (event: "cancel"): void;
}>();

const title = ref("");
const aliases = ref("");
const moved = ref<Set<string>>(new Set());

const movable = computed(() => props.item.nodes.flatMap(node => node.role === "main" ? [] : node.entries.map((entry, index) => ({
    role: node.role as MovableRole, index, key: `${node.role}:${index}`,
    summary: Object.values(entry.fields).join(" ").replace(/\s+/gu, " ").trim().slice(0, 60),
}))));
const canSplit = computed(() => Boolean(title.value.trim()) && moved.value.size > 0);

function setMoved(key: string, value: boolean | "indeterminate"): void {
    const next = new Set(moved.value);
    if (value === true) next.add(key);
    else next.delete(key);
    moved.value = next;
}

function submit(): void {
    if (!canSplit.value) return;
    const move = (["experience", "relationship"] as const).flatMap(role => {
        const entryIndexes = movable.value.filter(entry => entry.role === role && moved.value.has(entry.key)).map(entry => entry.index);
        return entryIndexes.length ? [{role, entryIndexes}] : [];
    });
    const aliasList = [...new Set(aliases.value.split(/[,，、\n]/u).map(alias => alias.trim()).filter(Boolean))];
    emit("split", {title: title.value.trim(), ...(aliasList.length ? {aliases: aliasList} : {}), move});
}
</script>

<template>
    <section class="split-form" :aria-label="`拆分 ${props.item.title}`">
        <FormField label="新条目标题">
            <FormInput v-model="title" :disabled="props.busy" />
        </FormField>
        <FormField label="新条目别称" description="用逗号或顿号分隔，可留空">
            <FormInput v-model="aliases" :disabled="props.busy" />
        </FormField>
        <p v-if="!movable.length" class="hint">没有可以移动的记录。</p>
        <div v-else class="move-list" role="group" aria-label="要移到新条目的记录">
            <FormCheckbox
                v-for="entry in movable" :key="entry.key" :model-value="moved.has(entry.key)" :disabled="props.busy"
                :label="`${NODE_ROLE_LABELS[entry.role]} ${entry.index + 1}`" :description="entry.summary || undefined"
                @update:model-value="setMoved(entry.key, $event)"
            />
        </div>
        <ExtractionNotice v-if="props.error" tone="danger">{{ props.error }}</ExtractionNotice>
        <div class="actions">
            <Button variant="primary" :loading="props.busy" :disabled="!canSplit" @click="submit()">拆分</Button>
            <Button variant="ghost" :disabled="props.busy" @click="emit('cancel')">取消</Button>
        </div>
    </section>
</template>

<style scoped>
.split-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-3);
    border: 1px solid var(--accent-main);
    border-radius: var(--radius-control);
    background: var(--bg-main);
}

.hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.move-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 240px;
    overflow: auto;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
