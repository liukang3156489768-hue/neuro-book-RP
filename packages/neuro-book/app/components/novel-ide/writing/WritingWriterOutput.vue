<script setup lang="ts">
import {computed, ref} from "vue";
import {Badge, Button, Collapsible} from "@notnotype/nb-ui/components";
import {useWritingWriterOutput} from "nbook/app/composables/useWritingWriterOutput";
import type {WritingAttemptDto} from "nbook/shared/dto/writing.dto";

const props = withDefaults(defineProps<{
    projectRoot: string;
    runId: string;
    title: string;
    attempt: WritingAttemptDto;
    active?: boolean;
}>(), {active: false});
const open = ref(false);
const writer = useWritingWriterOutput(() => ({projectRoot: props.projectRoot, runId: props.runId,
    sessionId: props.attempt.writerSessionId ?? null, open: open.value, active: props.active}));
const output = computed(() => writer.output.value || props.attempt.output || "");
const noThinkingMessage = computed(() => {
    if (!props.attempt.writerSessionId) return "此记录没有写手会话关联，无法读取思考内容。";
    if (writer.loading.value) return "正在读取思考内容…";
    if (writer.error.value) return "思考内容暂不可用，请重试读取。";
    return props.active ? "等待模型返回思考内容；关闭思考的模型不会产生此内容。" : "模型没有返回思考内容。";
});
const status = computed(() => {
    if (props.attempt.judgement) return props.attempt.judgement.passed ? "已通过" : "未通过";
    if (props.attempt.output !== null) return "待审阅";
    return props.active ? "生成中" : "已结束";
});
</script>

<template>
    <Collapsible v-model:open="open" class="writer-output">
        <template #trigger>
            <Button class="writer-toggle" size="sm" variant="ghost" :aria-label="`${open ? '收起' : '展开'}${title}`">
                <span :class="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true"></span>
                <span class="writer-title">{{ title }}</span>
                <Badge size="sm" variant="soft" :tone="attempt.judgement?.passed === false ? 'warning' : 'neutral'">{{ status }}</Badge>
            </Button>
        </template>
        <div v-if="open" class="writer-content">
            <p v-if="writer.loading.value" class="writer-muted" role="status">正在读取写手输出…</p>
            <div v-if="writer.error.value" class="writer-error" role="alert">
                <span>{{ writer.error.value }}</span>
                <Button size="sm" variant="ghost" @click="void writer.reload()">重试</Button>
            </div>
            <section aria-label="写手思考内容">
                <h4>思考内容</h4>
                <pre v-if="writer.thinking.value" class="writer-text writer-thinking">{{ writer.thinking.value }}</pre>
                <p v-else class="writer-muted">{{ noThinkingMessage }}</p>
            </section>
            <section aria-label="写手正文输出">
                <h4>正文输出</h4>
                <pre v-if="output" class="writer-text">{{ output }}</pre>
                <p v-else class="writer-muted">{{ active ? '正在等待写手输出…' : '本次尝试没有正文输出。' }}</p>
            </section>
        </div>
    </Collapsible>
</template>

<style scoped>
.writer-output { min-width: 0; flex: 0 0 auto; border: var(--border-w) solid var(--divider); border-radius: var(--radius-control); background: var(--bg-panel); }
.writer-toggle { display: flex; width: 100%; height: auto; min-height: 32px; justify-content: flex-start; gap: var(--space-2); padding: var(--space-2) var(--space-3); text-align: left; white-space: normal; }
.writer-toggle > :first-child { flex: 0 0 auto; }
.writer-title { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.writer-content { display: grid; min-width: 0; gap: var(--space-3); padding: 0 var(--space-3) var(--space-3); }
.writer-content section { min-width: 0; }
.writer-content h4 { margin: 0 0 var(--space-2); color: var(--text-secondary); font-size: var(--text-2xs); font-weight: var(--weight-strong); }
.writer-text { max-height: 32vh; margin: 0; overflow-y: auto; overflow-x: hidden; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; color: var(--text-main); font-size: var(--text-xs); line-height: var(--leading-reading); }
.writer-thinking { max-height: 22vh; color: var(--text-secondary); }
.writer-muted { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.writer-error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--status-danger); font-size: var(--text-2xs); }
.writer-error > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
</style>
