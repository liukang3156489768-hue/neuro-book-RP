<script setup lang="ts">
import {computed} from "vue";
import type {AgentToolCall} from "nbook/app/components/novel-ide/agent/agent-message";
import {parseToolArgsObject} from "nbook/app/components/novel-ide/agent/tool-args-stream";

const props = defineProps<{
    toolCall: AgentToolCall;
}>();

const emit = defineEmits<{
    (e: "view-session", sessionId: number): void;
}>();

const specialistInfo = computed(() => {
    if (!["consult_planning_specialist", "delegate_planning_task"].includes(props.toolCall.name)) {
        return null;
    }

    // 流式阶段参数还是半截 JSON，specialist 字段一到就显示专家身份。
    const specialist = parseToolArgsObject<{specialist?: unknown}>(props.toolCall.argsJson ?? props.toolCall.argsText)?.specialist;
    if (typeof specialist !== "string" || !specialist) return null;

    const names: Record<string, string> = {
        "foreshadowing": "伏笔专家",
        "detailed": "细纲专家",
        "outline": "大纲专家",
    };

    const icons: Record<string, string> = {
        "foreshadowing": "i-lucide-sparkle",
        "detailed": "i-lucide-file-text",
        "outline": "i-lucide-list-tree",
    };

    return {
        name: names[specialist] || "规划专家",
        icon: icons[specialist] || "i-lucide-bot",
        mode: props.toolCall.name === "delegate_planning_task" ? "委派产出" : "咨询建议",
        specialist,
    };
});

const sessionId = computed(() => {
    // 从工具结果中提取 sessionId
    const details = props.toolCall.resultData;
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    return typeof details.sessionId === "number" ? details.sessionId : null;
});
</script>

<template>
    <div v-if="specialistInfo" class="specialist-indicator">
        <div class="specialist-header">
            <span class="specialist-icon" :class="specialistInfo.icon"></span>
            <span class="specialist-name">{{ specialistInfo.name }}</span>
            <span class="specialist-mode-badge">{{ specialistInfo.mode }}</span>
            <button
                v-if="sessionId"
                type="button"
                class="view-session-button"
                title="查看专家会话详情"
                @click="emit('view-session', sessionId)"
            >
                <span class="i-lucide-external-link"></span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.specialist-indicator {
    margin-bottom: var(--space-2);
}

.specialist-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-control);
    background: color-mix(in srgb, var(--accent-main) 10%, transparent);
    border-left: 3px solid var(--accent-main);
}

.specialist-icon {
    font-size: 16px;
    color: var(--accent-main);
    flex-shrink: 0;
}

.specialist-name {
    font-weight: 500;
    font-size: var(--text-sm);
    color: var(--text-main);
}

.specialist-mode-badge {
    padding: 2px var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--accent-main);
    color: var(--text-inverse);
    font-size: var(--text-2xs);
    font-weight: 500;
}

.view-session-button {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    transition: background var(--motion-fast) var(--ease-standard),
                color var(--motion-fast) var(--ease-standard);
}

.view-session-button:hover {
    background: color-mix(in srgb, var(--text-main) 10%, transparent);
    color: var(--text-main);
}
</style>
