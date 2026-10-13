<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {Badge, Button, FormTextarea, type BadgeTone} from "@notnotype/nb-ui/components";
import type {WritingAttemptDto, WritingRunProgressDto, WritingSceneProgressDto} from "nbook/shared/dto/writing.dto";
import type {WritingUserDecision} from "nbook/app/utils/writing/writing-api";

const props = withDefaults(defineProps<{
    progress: WritingRunProgressDto;
    latest?: boolean;
    connectionLost?: boolean;
    pending?: boolean;
}>(), {latest: false, connectionLost: false, pending: false});
const emit = defineEmits<{
    stop: [runId: string];
    continue: [chapterEntryId: string];
    answer: [runId: string, key: string, decision: WritingUserDecision];
}>();

const SCENE_LABELS: Record<Exclude<WritingSceneProgressDto["state"], "retrying">, string> = {
    unplanned: "待规划", planning: "规划中", pending: "待写", writing: "写作中", reviewing: "审阅中", passed: "已通过", failed: "未通过",
};
const SCENE_TONES: Record<WritingSceneProgressDto["state"], BadgeTone> = {
    unplanned: "neutral", planning: "accent", pending: "neutral", writing: "accent", reviewing: "accent", retrying: "warning", passed: "success", failed: "danger",
};

const run = computed(() => props.progress);
const expanded = ref(new Set<number>());
const comments = ref("");
/** 改写只允许确认一次；已点过的待应答项按 key 记下，不等服务端返回就禁用按钮。 */
const decidedKeys = ref(new Set<string>());

watch(() => props.progress.runId, () => {
    expanded.value = new Set();
    comments.value = "";
    decidedKeys.value = new Set();
});

const title = computed(() => {
    if (run.value.kind === "rewrite") return "改写";
    return run.value.task === "continue" ? "续写本章" : run.value.task === "rewrite" ? "重写本章" : "写作本章";
});

const stopped = computed(() => {
    const value = run.value;
    return value.status === "failed" || value.status === "cancelled" || value.result?.outcome === "stopped";
});

const status = computed<{label: string; tone: BadgeTone}>(() => {
    const value = run.value;
    if (value.status === "running" && value.interrupted) return {label: "已中断", tone: "warning"};
    if (value.status === "running") return {label: "运行中", tone: "accent"};
    if (value.status === "waiting") return {label: "等待确认", tone: "warning"};
    if (value.status === "failed") return {label: "失败", tone: "danger"};
    if (value.status === "cancelled") return {label: "已停止", tone: "neutral"};
    if (value.result?.outcome === "stopped") return {label: "未完成", tone: "danger"};
    if (value.kind === "rewrite" && value.result?.outcome === "discarded") return {label: "已放弃", tone: "neutral"};
    return {label: value.kind === "rewrite" ? "已替换" : "已完成", tone: "success"};
});

const canStop = computed(() => run.value.status === "running" || run.value.status === "waiting");
/** 继续由服务端按这一章最近一次运行决定重放还是从检查点续写，所以只给最近一次运行。 */
const canContinue = computed(() => props.latest && (run.value.interrupted || (stopped.value && (run.value.kind === "chapter"
    || run.value.status === "failed"))));

const leadReview = computed(() => run.value.asks.some(({role}) => role === "lead-review"));
const userConfirm = computed(() => run.value.asks.find(({role}) => role === "user-confirm") ?? null);
const rewriteConfirm = computed(() => run.value.asks.find(({role}) => role === "rewrite-confirm") ?? null);

const sceneList = computed(() => (run.value.kind === "chapter" ? run.value.scenes : []));
const rewriteOriginal = computed(() => (run.value.kind === "rewrite" ? run.value.result?.original ?? run.value.original : null));
const rewriteReplacement = computed(() => (run.value.kind === "rewrite" ? run.value.result?.replacement ?? run.value.replacement : null));

function sceneLabel(scene: WritingSceneProgressDto): string {
    return scene.state === "retrying" ? `重写第 ${scene.retry} 次` : SCENE_LABELS[scene.state];
}

function toggleScene(index: number): void {
    const next = new Set(expanded.value);
    if (!next.delete(index)) next.add(index);
    expanded.value = next;
}

function attemptLabel(attempt: WritingAttemptDto, index: number): string {
    if (!attempt.judgement) return `第 ${index + 1} 次：审阅中`;
    return `第 ${index + 1} 次：${attempt.judgement.passed ? "通过" : "未通过"}`;
}

function answer(key: string, decision: WritingUserDecision): void {
    decidedKeys.value = new Set(decidedKeys.value).add(key);
    emit("answer", run.value.runId, key, decision);
}

function answerPlan(approved: boolean): void {
    const ask = userConfirm.value;
    if (!ask) return;
    const text = comments.value.trim();
    answer(ask.key, text ? {approved, comments: text} : {approved});
}

const resultMessage = computed(() => run.value.result?.message ?? null);
const resultFailed = computed(() => run.value.result?.outcome === "stopped");
const chapterResult = computed(() => (run.value.kind === "chapter" ? run.value.result : null));
const resultProblems = computed(() => {
    const value = run.value;
    if (value.kind === "rewrite") return value.result?.problems ?? [];
    return value.result?.failedScene?.problems ?? [];
});
</script>

<template>
    <article class="writing-run-card" :aria-label="`${title}进度`">
        <header class="card-header">
            <strong>{{ title }}</strong>
            <Badge size="sm" variant="soft" :tone="status.tone" :dot="run.status === 'running' && !run.interrupted">{{ status.label }}</Badge>
            <div class="card-actions">
                <Button v-if="canStop" size="sm" variant="secondary" icon-class="i-lucide-square" :disabled="props.pending"
                    @click="emit('stop', run.runId)">停止</Button>
                <Button v-if="canContinue" size="sm" variant="primary" icon-class="i-lucide-play" :disabled="props.pending"
                    @click="emit('continue', run.chapterEntryId)">继续</Button>
            </div>
        </header>

        <p v-if="props.connectionLost" class="card-notice" role="status"><span class="i-lucide-wifi-off"></span>连接中断，恢复后自动补齐进度</p>
        <p v-if="run.error" class="card-alert" role="alert"><span class="i-lucide-circle-alert"></span>{{ run.error }}</p>

        <template v-if="run.kind === 'chapter'">
            <p v-if="sceneList.length === 0 && !run.result" class="card-muted">正在规划场景…</p>
            <ol v-else-if="sceneList.length" class="scene-list">
                <li v-for="scene in sceneList" :key="scene.index" class="scene-item">
                    <button type="button" class="scene-row nb-ui-focus-ring" :aria-expanded="expanded.has(scene.index)"
                        @click="toggleScene(scene.index)">
                        <span :class="expanded.has(scene.index) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"></span>
                        <span class="scene-heading">{{ scene.heading }}</span>
                        <Badge size="sm" variant="soft" :tone="SCENE_TONES[scene.state]">{{ sceneLabel(scene) }}</Badge>
                    </button>
                    <div v-if="expanded.has(scene.index)" class="scene-detail">
                        <p v-if="scene.attempts.length === 0" class="card-muted">本次运行没有这个场景的写作记录。</p>
                        <section v-for="(attempt, index) in scene.attempts" :key="index" class="attempt">
                            <h4>{{ attemptLabel(attempt, index) }}</h4>
                            <details v-if="attempt.prompt">
                                <summary>写手提示</summary>
                                <pre class="prompt-text">{{ attempt.prompt.system }}</pre>
                                <pre class="prompt-text">{{ attempt.prompt.user }}</pre>
                            </details>
                            <ul v-if="attempt.judgement?.problems.length" class="problem-list">
                                <li v-for="problem in attempt.judgement.problems" :key="problem">{{ problem }}</li>
                            </ul>
                        </section>
                    </div>
                </li>
            </ol>
        </template>

        <div v-else class="rewrite-compare">
            <p class="rewrite-requirement"><span class="card-label">修改要求</span>{{ run.requirement }}</p>
            <p v-if="rewriteOriginal === null" class="card-muted">正在定位目标段落…</p>
            <template v-else>
                <div class="compare-block"><span class="card-label">原文</span><p class="compare-text">{{ rewriteOriginal }}</p></div>
                <div class="compare-block" data-kind="replacement">
                    <span class="card-label">改写后</span>
                    <p v-if="rewriteReplacement !== null" class="compare-text">{{ rewriteReplacement }}</p>
                    <p v-else class="card-muted">正在改写…</p>
                </div>
            </template>
        </div>

        <p v-if="leadReview" class="card-muted" role="status">场景规划正在等待主创核对…</p>
        <section v-if="userConfirm" class="confirm-area" aria-label="确认场景规划">
            <h4>{{ userConfirm.title }}</h4>
            <p v-if="userConfirm.description" class="plan-summary">{{ userConfirm.description }}</p>
            <FormTextarea v-model="comments" :rows="2" placeholder="退回修改时写明意见" aria-label="场景规划意见"
                :disabled="props.pending || decidedKeys.has(userConfirm.key)" />
            <div class="confirm-actions">
                <Button size="sm" variant="primary" :disabled="props.pending || decidedKeys.has(userConfirm.key)" @click="answerPlan(true)">确认场景</Button>
                <Button size="sm" variant="secondary" :disabled="props.pending || decidedKeys.has(userConfirm.key) || !comments.trim()"
                    @click="answerPlan(false)">退回修改</Button>
            </div>
        </section>
        <div v-if="rewriteConfirm" class="confirm-actions">
            <Button size="sm" variant="primary" :disabled="props.pending || decidedKeys.has(rewriteConfirm.key)"
                @click="answer(rewriteConfirm.key, {replace: true})">替换</Button>
            <Button size="sm" variant="secondary" :disabled="props.pending || decidedKeys.has(rewriteConfirm.key)"
                @click="answer(rewriteConfirm.key, {replace: false})">放弃</Button>
        </div>

        <section v-if="resultMessage" class="card-result" :data-failed="resultFailed" :role="resultFailed ? 'alert' : undefined">
            <p>{{ resultMessage }}</p>
            <ul v-if="resultProblems.length" class="problem-list">
                <li v-for="problem in resultProblems" :key="problem">{{ problem }}</li>
            </ul>
            <p v-if="chapterResult?.words != null" class="card-muted">
                共 {{ chapterResult.words }} 字<template v-if="chapterResult.targetWords != null">，目标 {{ chapterResult.targetWords }} 字</template>
            </p>
            <ul v-if="chapterResult?.hints.length" class="hint-list">
                <li v-for="hint in chapterResult.hints" :key="hint.id">{{ hint.message }}</li>
            </ul>
        </section>
    </article>
</template>

<style scoped>
.writing-run-card { display: grid; min-width: 0; gap: var(--space-3); border: 1px solid var(--border-color); border-radius: var(--radius-panel, 0.75rem); background: var(--bg-panel); padding: var(--space-4); font-size: var(--text-xs); line-height: var(--leading-ui); }
.card-header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.card-header strong { font-size: var(--text-sm); font-weight: var(--weight-strong); }
.card-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-left: auto; }
.card-notice, .card-alert { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; border-radius: var(--radius-control); padding: var(--space-2) var(--space-3); }
.card-notice { border: 1px solid var(--status-warning-border); background: var(--status-warning-bg); color: var(--text-main); }
.card-alert { border: 1px solid var(--status-danger-border); background: var(--status-danger-bg); color: var(--status-danger); }
.card-notice span, .card-alert span { flex: 0 0 auto; margin-top: 2px; }
.card-muted { margin: 0; color: var(--text-muted); }
.card-label { display: block; color: var(--text-muted); font-size: var(--text-2xs); }
.scene-list { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.scene-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: var(--space-2); border: 0; border-radius: var(--radius-control); background: transparent; padding: var(--space-2); color: var(--text-main); cursor: pointer; text-align: left; }
.scene-row:hover { background: var(--bg-subtle); }
.scene-heading { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.scene-detail { display: grid; max-height: 360px; gap: var(--space-3); overflow-y: auto; padding: var(--space-2) var(--space-3) var(--space-3) var(--space-6); }
.attempt { display: grid; gap: var(--space-2); }
.attempt h4, .confirm-area h4 { margin: 0; font-size: var(--text-xs); font-weight: var(--weight-strong); }
.attempt summary { color: var(--text-secondary); cursor: pointer; }
.prompt-text { max-height: 240px; overflow: auto; margin: var(--space-2) 0 0; border-radius: var(--radius-control); background: var(--bg-subtle); padding: var(--space-2) var(--space-3); font-family: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.problem-list, .hint-list { display: grid; gap: var(--space-1); margin: 0; padding-left: 1.25em; }
.problem-list { color: var(--status-danger); }
.rewrite-compare { display: grid; gap: var(--space-3); }
.rewrite-requirement { margin: 0; overflow-wrap: anywhere; }
.compare-block { display: grid; gap: var(--space-1); border-left: 3px solid var(--border-color); padding-left: var(--space-3); }
.compare-block[data-kind="replacement"] { border-left-color: var(--accent-main); }
.compare-text, .plan-summary { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.plan-summary, .card-result .problem-list, .hint-list { max-height: 240px; overflow-y: auto; }
.confirm-area { display: grid; gap: var(--space-2); }
.confirm-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.card-result { display: grid; gap: var(--space-2); border-top: 1px solid var(--border-color); padding-top: var(--space-3); }
.card-result p { margin: 0; }
.card-result[data-failed="true"] > p:first-child { color: var(--status-danger); }
</style>
