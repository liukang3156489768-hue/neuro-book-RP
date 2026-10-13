<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Button, FormField, FormInput, FormTextarea} from "@notnotype/nb-ui/components";
import type {MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {MaterialReview} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {NODE_ROLE_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

type ReviewItem = MaterialReview["items"][number];
type ItemPatch = Extract<MaterialReviewActionDto, {kind: "update"}>["patch"];

const props = withDefaults(defineProps<{
    item: ReviewItem;
    busy?: boolean;
    error?: string;
}>(), {busy: false, error: ""});

const emit = defineEmits<{
    (event: "save", patch: ItemPatch): void;
    (event: "cancel"): void;
}>();

const title = ref("");
const aliases = ref("");
// 草稿按节点 → 记录 → 字段保存为深拷贝，避免编辑时改到服务端返回的对象。
const nodes = ref<ReviewItem["nodes"]>([]);

watch(() => props.item, item => {
    title.value = item.title;
    aliases.value = item.aliases.join("、");
    nodes.value = structuredClone(item.nodes);
}, {immediate: true});

const aliasList = computed(() => [...new Set(aliases.value.split(/[,，、\n]/u).map(alias => alias.trim()).filter(Boolean))]);
const titleChanged = computed(() => title.value.trim() !== props.item.title);
const aliasesChanged = computed(() => JSON.stringify(aliasList.value) !== JSON.stringify(props.item.aliases));
const nodesChanged = computed(() => JSON.stringify(nodes.value) !== JSON.stringify(props.item.nodes));
const changed = computed(() => titleChanged.value || aliasesChanged.value || nodesChanged.value);

function save(): void {
    if (!changed.value) return;
    emit("save", {
        ...(titleChanged.value ? {title: title.value.trim()} : {}),
        ...(aliasesChanged.value ? {aliases: aliasList.value} : {}),
        ...(nodesChanged.value ? {nodes: nodes.value} : {}),
    });
}
</script>

<template>
    <section class="item-editor" :aria-label="`编辑 ${props.item.title}`">
        <FormField label="标题">
            <FormInput v-model="title" :disabled="props.busy" />
        </FormField>
        <FormField label="别称" description="用逗号或顿号分隔">
            <FormInput v-model="aliases" :disabled="props.busy" />
        </FormField>
        <div v-for="(node, nodePosition) in nodes" :key="node.role" class="node">
            <h4 class="node-title">{{ NODE_ROLE_LABELS[node.role] }}</h4>
            <div v-for="(entry, entryPosition) in node.entries" :key="entryPosition" class="entry">
                <p v-if="node.entries.length > 1 || entry.block" class="entry-title">第 {{ entryPosition + 1 }} 条<template v-if="entry.block">（来自第 {{ entry.block }} 块）</template></p>
                <FormField v-for="field in Object.keys(entry.fields)" :key="field" :label="field">
                    <FormTextarea
                        :model-value="nodes[nodePosition]!.entries[entryPosition]!.fields[field]" :rows="3" :disabled="props.busy"
                        @update:model-value="nodes[nodePosition]!.entries[entryPosition]!.fields[field] = $event"
                    />
                </FormField>
            </div>
        </div>
        <ExtractionNotice v-if="props.error" tone="danger">{{ props.error }}</ExtractionNotice>
        <div class="actions">
            <Button variant="primary" :loading="props.busy" :disabled="!changed" @click="save()">保存修改</Button>
            <Button variant="ghost" :disabled="props.busy" @click="emit('cancel')">取消</Button>
        </div>
    </section>
</template>

<style scoped>
.item-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-3);
    border: 1px solid var(--accent-main);
    border-radius: var(--radius-control);
    background: var(--bg-main);
}

.node {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.node-title {
    margin: 0;
    color: var(--text-main);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-left: 2px solid var(--border-color);
}

.entry-title {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}
</style>
