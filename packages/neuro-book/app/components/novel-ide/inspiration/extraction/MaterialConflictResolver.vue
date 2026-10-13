<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, FormField, FormInput, SegmentedControl} from "@notnotype/nb-ui/components";
import type {MaterialConflictDecisionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ConflictComparison} from "nbook/app/utils/inspiration/extraction-api";
import ExtractionNotice from "nbook/app/components/novel-ide/inspiration/extraction/ExtractionNotice.vue";
import {NODE_ROLE_LABELS} from "nbook/app/utils/inspiration/extraction-labels";

type Action = MaterialConflictDecisionDto["action"];

const props = withDefaults(defineProps<{
    conflicts: readonly ConflictComparison[];
    busy?: boolean;
}>(), {busy: false});

const emit = defineEmits<{
    (event: "confirm", decisions: MaterialConflictDecisionDto[]): void;
    (event: "cancel"): void;
}>();

const actions = ref<Record<string, Action>>({});
const names = ref<Record<string, string>>({});

watch(() => props.conflicts, conflicts => {
    actions.value = Object.fromEntries(conflicts.map(conflict => [conflict.itemId, "skip" as Action]));
    names.value = {};
}, {immediate: true});

const ORIGIN_LABELS = {design: "你设计的内容", extract: "以往提取写入的内容"} as const;

const items = computed(() => {
    const byItem = new Map<string, {itemId: string; title: string; overwriteAllowed: boolean; conflicts: ConflictComparison[]}>();
    for (const conflict of props.conflicts) {
        const entry = byItem.get(conflict.itemId) ?? {itemId: conflict.itemId, title: conflict.title, overwriteAllowed: true, conflicts: []};
        entry.conflicts.push(conflict);
        entry.overwriteAllowed &&= conflict.overwriteAllowed;
        byItem.set(conflict.itemId, entry);
    }
    return [...byItem.values()];
});
const problems = computed(() => items.value.filter(item => actions.value[item.itemId] === "save-as" && !names.value[item.itemId]?.trim()).map(item => item.title));

const actionOf = (itemId: string): Action => actions.value[itemId] ?? "skip";

function optionsOf(allowed: boolean): Array<{label: string; value: Action}> {
    return [
        ...(allowed ? [{label: "覆盖", value: "overwrite" as const}] : []),
        {label: "另存为", value: "save-as"},
        {label: "跳过", value: "skip"},
    ];
}

function submit(): void {
    if (problems.value.length) return;
    emit("confirm", items.value.map(item => {
        const action = actions.value[item.itemId] ?? "skip";
        return {itemId: item.itemId, action, ...(action === "save-as" ? {saveAsName: names.value[item.itemId]!.trim()} : {})};
    }));
}
</script>

<template>
    <section class="conflict-resolver" aria-label="同名冲突">
        <ExtractionNotice tone="warning">以下条目在 lorebook 里已有同名文件。请逐个选择覆盖、另存为或跳过；没有表态的条目会被跳过。</ExtractionNotice>
        <article v-for="item in items" :key="item.itemId" class="item">
            <header class="item-head">
                <strong>{{ item.title }}</strong>
            </header>
            <div v-for="conflict in item.conflicts" :key="conflict.path" class="conflict">
                <p class="path"><Badge tone="neutral" variant="soft" size="sm">{{ conflict.role === 'main' ? '主文件' : NODE_ROLE_LABELS[conflict.role] }}</Badge> {{ conflict.path }}</p>
                <div class="sides">
                    <div class="side">
                        <h4>现有文件（{{ ORIGIN_LABELS[conflict.existing.origin] }}）</h4>
                        <p class="text">{{ conflict.existing.content }}</p>
                    </div>
                    <div class="side side-new">
                        <h4>即将写入</h4>
                        <p class="text">{{ conflict.incoming }}</p>
                    </div>
                </div>
            </div>
            <SegmentedControl :model-value="actionOf(item.itemId)" :options="optionsOf(item.overwriteAllowed)" size="sm" :aria-label="`${item.title} 的处理方式`" @update:model-value="actions[item.itemId] = $event as Action" />
            <p v-if="!item.overwriteAllowed" class="hint">现有文件不允许被覆盖，可以另存为或跳过。</p>
            <FormField v-if="actionOf(item.itemId) === 'save-as'" label="另存为的名称">
                <FormInput :model-value="names[item.itemId] ?? ''" placeholder="新的条目名称" @update:model-value="names[item.itemId] = $event" />
            </FormField>
        </article>
        <ExtractionNotice v-if="problems.length" tone="danger">请为“{{ problems.join('、') }}”填写另存为的名称。</ExtractionNotice>
        <div class="actions">
            <Button variant="primary" :loading="props.busy" :disabled="Boolean(problems.length)" @click="submit()">按所选处理并写入</Button>
            <Button variant="ghost" :disabled="props.busy" @click="emit('cancel')">返回清单</Button>
        </div>
    </section>
</template>

<style scoped>
.conflict-resolver {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
}

.item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
}

.item-head {
    color: var(--text-main);
    font-size: var(--text-sm);
}

.path {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0 0 var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
}

.sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-2);
}

.side {
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    background: var(--bg-main);
}

.side-new {
    border: 1px solid var(--accent-main);
}

.side h4 {
    margin: 0 0 var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
}

.text {
    max-height: 200px;
    margin: 0;
    overflow: auto;
    color: var(--text-main);
    font-size: var(--text-xs);
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.hint {
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
