<script setup lang="ts">
const props = withDefaults(defineProps<{tone?: "danger" | "warning" | "info" | "success"}>(), {tone: "info"});
</script>

<template>
    <p class="notice" :class="`notice-${props.tone}`" :role="props.tone === 'danger' ? 'alert' : undefined">
        <slot />
    </p>
</template>

<style scoped>
.notice {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 1.6;
    overflow-wrap: anywhere;
}

.notice-danger {
    border-color: var(--status-danger-border);
    background: var(--status-danger-bg);
    color: var(--status-danger);
}

.notice-warning {
    border-color: var(--status-warning-border);
    background: var(--status-warning-bg);
    color: var(--status-warning);
}

.notice-success {
    border-color: var(--status-success-border);
    background: var(--status-success-bg);
    color: var(--status-success);
}
</style>
