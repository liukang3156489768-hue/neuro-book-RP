<script setup lang="ts">
import {computed, onScopeDispose, ref, watch} from "vue";
import {Spinner} from "@notnotype/nb-ui/components";
import type {AgentCompactionStateDto} from "nbook/shared/dto/agent-session.dto";
import {compactionPresentation} from "nbook/app/components/novel-ide/agent/agent-compaction-state";

const props = defineProps<{state: AgentCompactionStateDto | null}>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
}
watch(() => props.state?.status === "running", (running) => {
    stopTimer();
    now.value = Date.now();
    if (running) timer = setInterval(() => { now.value = Date.now(); }, 1000);
}, {immediate: true});
onScopeDispose(stopTimer);
const presentation = computed(() => props.state ? compactionPresentation(props.state, now.value) : null);
</script>

<template>
    <div v-if="presentation" class="compaction-status" :data-status="props.state?.status" role="status" aria-live="polite">
        <div class="compaction-heading">
            <Spinner v-if="presentation.running" size="sm" :label="presentation.title" />
            <span>{{ presentation.title }}</span>
            <span class="compaction-detail"><template v-if="presentation.batch">{{ presentation.batch }} · </template>{{ presentation.elapsedSeconds }} 秒</span>
        </div>
        <div class="compaction-detail">{{ presentation.context }}</div>
        <div v-if="presentation.summaryUsage" class="compaction-detail">{{ presentation.summaryUsage }}</div>
        <div v-if="props.state?.error" class="compaction-error">{{ props.state.error }}</div>
    </div>
</template>

<style scoped>
.compaction-status { flex-shrink: 0; padding: 8px 12px; color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.compaction-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--status-info); }
.compaction-status[data-status="failed"] .compaction-heading, .compaction-error { color: var(--status-danger); }
.compaction-detail { color: var(--text-muted); }
</style>
