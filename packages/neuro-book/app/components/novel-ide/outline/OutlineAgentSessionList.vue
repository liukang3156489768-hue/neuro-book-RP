<script setup lang="ts">
import {computed, ref} from "vue";
import {IconButton} from "@notnotype/nb-ui/components";

export type OutlineAgentSessionItem = {
    sessionId: number;
    title?: string;
    createdAt: number;
    lastActiveAt: number;
};

const props = defineProps<{
    sessions: readonly OutlineAgentSessionItem[];
    activeSessionId: number | null;
    loading?: boolean;
}>();

const emit = defineEmits<{
    select: [sessionId: number];
    create: [];
    delete: [sessionId: number];
    rename: [sessionId: number, newTitle: string];
}>();

const editingSessionId = ref<number | null>(null);
const editingTitle = ref("");

const sortedSessions = computed(() => {
    return [...props.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
});

function formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
}

function startRename(session: OutlineAgentSessionItem): void {
    editingSessionId.value = session.sessionId;
    editingTitle.value = session.title || "新会话";
}

function confirmRename(sessionId: number): void {
    if (editingTitle.value.trim()) {
        emit("rename", sessionId, editingTitle.value.trim());
    }
    editingSessionId.value = null;
    editingTitle.value = "";
}

function cancelRename(): void {
    editingSessionId.value = null;
    editingTitle.value = "";
}

function selectSession(sessionId: number): void {
    if (editingSessionId.value === null) {
        emit("select", sessionId);
    }
}

function deleteSession(sessionId: number, event: Event): void {
    event.stopPropagation();
    if (confirm("确定删除此会话吗？删除后无法恢复。")) {
        emit("delete", sessionId);
    }
}
</script>

<template>
    <div class="session-list">
        <div class="session-list-header">
            <h3>对话历史</h3>
            <IconButton
                title="新建会话"
                icon-class="i-lucide-plus"
                size="sm"
                :disabled="loading"
                @click="emit('create')"
            />
        </div>

        <div v-if="loading" class="session-list-loading">
            <span class="i-lucide-loader-circle animate-spin"></span>
            <span>加载中...</span>
        </div>

        <div v-else-if="sortedSessions.length === 0" class="session-list-empty">
            <span class="i-lucide-message-square"></span>
            <p>暂无会话历史</p>
            <button type="button" class="create-first-button" @click="emit('create')">
                <span class="i-lucide-plus"></span>
                新建会话
            </button>
        </div>

        <div v-else class="session-list-items">
            <div
                v-for="session in sortedSessions"
                :key="session.sessionId"
                class="session-item"
                :class="{
                    'is-active': session.sessionId === activeSessionId,
                    'is-editing': editingSessionId === session.sessionId
                }"
                @click="selectSession(session.sessionId)"
            >
                <div class="session-item-content">
                    <input
                        v-if="editingSessionId === session.sessionId"
                        v-model="editingTitle"
                        type="text"
                        class="session-title-input"
                        maxlength="100"
                        @click.stop
                        @keydown.enter="confirmRename(session.sessionId)"
                        @keydown.esc="cancelRename()"
                        @blur="confirmRename(session.sessionId)"
                    >
                    <div v-else class="session-item-info">
                        <div class="session-title">{{ session.title || "新会话" }}</div>
                        <div class="session-time">{{ formatTime(session.lastActiveAt) }}</div>
                    </div>

                    <div v-if="editingSessionId !== session.sessionId" class="session-item-actions">
                        <IconButton
                            title="重命名"
                            icon-class="i-lucide-pencil"
                            size="sm"
                            @click.stop="startRename(session)"
                        />
                        <IconButton
                            title="删除"
                            icon-class="i-lucide-trash-2"
                            size="sm"
                            variant="danger"
                            :disabled="session.sessionId === activeSessionId"
                            @click="deleteSession(session.sessionId, $event)"
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.session-list {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--bg-panel);
}

.session-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-color);
}

.session-list-header h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-main);
}

.session-list-loading,
.session-list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-8);
    color: var(--text-muted);
}

.session-list-loading span:first-child,
.session-list-empty span:first-child {
    font-size: 32px;
}

.session-list-empty p {
    margin: 0;
    font-size: var(--text-sm);
}

.create-first-button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-main);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all 0.2s;
}

.create-first-button:hover {
    border-color: var(--accent-main);
    background: var(--bg-hover);
}

.session-list-items {
    overflow-y: auto;
    flex: 1;
}

.session-item {
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.2s;
}

.session-item:hover {
    background: var(--bg-hover);
}

.session-item.is-active {
    background: color-mix(in srgb, var(--accent-main) 10%, transparent);
    border-left: 3px solid var(--accent-main);
    padding-left: calc(var(--space-5) - 3px);
}

.session-item.is-editing {
    background: var(--bg-hover);
}

.session-item-content {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.session-item-info {
    flex: 1;
    min-width: 0;
}

.session-title {
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-main);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.session-time {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
}

.session-title-input {
    flex: 1;
    padding: var(--space-2);
    border: 1px solid var(--accent-main);
    border-radius: var(--radius-control);
    background: var(--bg-main);
    color: var(--text-main);
    font-size: var(--text-sm);
    outline: none;
}

.session-item-actions {
    display: flex;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 0.2s;
}

.session-item:hover .session-item-actions {
    opacity: 1;
}
</style>
