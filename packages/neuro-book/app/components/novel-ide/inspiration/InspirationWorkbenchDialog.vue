<script setup lang="ts">
import {computed, reactive, ref, watch} from "vue";
import {Button, FormTextarea, SegmentedControl} from "@notnotype/nb-ui/components";
import Dialog from "nbook/app/components/common/Dialog.vue";
import {INSPIRATION_CATEGORIES, INSPIRATION_CATEGORY_LABELS, type InspirationCategory} from "nbook/shared/dto/inspiration.dto";
import {useInspirationWorkbench} from "nbook/app/composables/useInspirationWorkbench";
import InspirationExtractionPanel from "nbook/app/components/novel-ide/inspiration/extraction/InspirationExtractionPanel.vue";
import InspirationMaterialPicker from "nbook/app/components/novel-ide/inspiration/InspirationMaterialPicker.vue";

const props = defineProps<{modelValue: boolean; projectRoot: string | null}>();
const emit = defineEmits<{(event: "update:modelValue", value: boolean): void; (event: "open-outline-plan", plan: {planId: string; planTitle: string}): void}>();
const workbench = useInspirationWorkbench(computed(() => props.projectRoot));
const {request, feedback, draft, artifacts, conversations, conversation, loading, saving, error, modelOptions, modelKey, thinkingEnabled, temperature, selectedArtifactIds, refiningArtifactId,
    creationMode, materialQuery, materialCategory, materials, materialTotal, materialNextOffset, loadingMaterials, materialError, materialPaths, canReuseDraft, canGenerate} = workbench;
// "作品提取"页首次打开才挂载，避免没用到时就请求来源与任务列表；挂载后用 v-show 保留进度与未提交的编辑。
const page = ref<"design" | "extraction">("design"); const extractionMounted = ref(false);
watch(page, value => { if (value === "extraction") extractionMounted.value = true; });
const pageTabs = [{label: "素材设计", value: "design"}, {label: "作品提取", value: "extraction"}];
const creationOptions = computed(() => [{label: "原创", value: "original", disabled: loading.value || saving.value || !!workbench.refiningArtifactId.value}, {label: "改编", value: "adaptation", disabled: loading.value || saving.value || !!workbench.refiningArtifactId.value}]);
const chosenMaterials = computed(() => materialPaths.value.map(path => ({path, title: workbench.materialName(path)})));
const activeCategory = ref<InspirationCategory | "all">("all"); const savedNotice = ref(""); const artifactInstructions = reactive<Record<string, string>>({}); const artifactAnswers = reactive<Record<string, string>>({});
const visibleArtifacts = computed(() => activeCategory.value === "all" ? artifacts.value : artifacts.value.filter(item => item.category === activeCategory.value));
const visibleArtifactIds = computed(() => visibleArtifacts.value.map(item => item.id));
const allVisibleSelected = computed(() => visibleArtifactIds.value.length > 0 && visibleArtifactIds.value.every(id => selectedArtifactIds.value.includes(id)));
const sourceName = (path: string) => path.replace(/^reference\//, "");
const citationText = () => draft.value?.creationMode === "adaptation" ? `改编设计 · ${(draft.value.materialSources ?? []).map(source => source.title).join('、')}` : "原创设计";
watch(() => props.projectRoot, () => { savedNotice.value = ""; for (const key of Object.keys(artifactInstructions)) delete artifactInstructions[key]; for (const key of Object.keys(artifactAnswers)) delete artifactAnswers[key]; });
watch(() => draft.value?.id, () => { savedNotice.value = ""; });
async function save(): Promise<void> { const result = await workbench.save(); if (result) savedNotice.value = `已保存 ${result.saved.length} 项成果`; }
async function refineArtifact(id: string, action: "refine" | "ask"): Promise<void> { const answer = await workbench.refineArtifact(id, action, artifactInstructions[id] ?? ""); if (answer) artifactAnswers[id] = answer; if (action === "refine") artifactInstructions[id] = ""; }
function normalizeTemperature(): void { const value = Number(temperature.value); temperature.value = Number.isFinite(value) ? Math.min(2, Math.max(0, Number(value.toFixed(1)))) : 0.7; }
</script>

<template>
    <Dialog
        :model-value="props.modelValue"
        width="100vw"
        height="100dvh"
        max-height="100dvh"
        :show-footer="false"
        :close-on-overlay="false"
        title="Inspiration 设计工作台"
        :busy="loading || saving || !!refiningArtifactId"
        body-class="!gap-0 !overflow-hidden !p-0"
        @update:model-value="emit('update:modelValue', $event)"
    >
        <div class="page-tabs"><SegmentedControl v-model="page" :options="pageTabs" aria-label="工作台页面" /></div>
        <div v-show="page === 'design'" class="workbench">
            <aside class="sessions" aria-label="聊天记录">
                <div class="sidebar-header"><strong>聊天记录</strong><button type="button" class="icon-button" title="新建聊天" :disabled="loading || saving" @click="workbench.createConversation()"><span class="i-lucide-plus h-4 w-4"></span></button></div>
                <button v-for="item in conversations" :key="item.id" type="button" class="session-item" :disabled="loading || saving" :class="conversation?.id === item.id ? 'is-active' : ''" @click="workbench.openConversation(item.id)">
                    <span>{{ item.title }}</span><small>{{ item.messageCount }} 条消息</small>
                </button>
                <div v-if="!conversations.length" class="empty-sidebar">
                    <span class="i-lucide-message-circle-plus empty-sidebar-icon"></span>
                    <p>新建对话后，设计过程与分析上下文会保存在当前作品中。</p>
                    <button type="button" class="sidebar-create" :disabled="loading || saving" @click="workbench.createConversation()"><span class="i-lucide-plus h-3.5 w-3.5"></span>新建对话</button>
                </div>
            </aside>
            <section class="chat-panel" aria-label="Inspiration 对话">
                <header class="chat-header"><div><strong>{{ conversation?.title ?? '新对话' }}</strong><p>{{ creationMode === 'adaptation' ? '改编设计' : '原创设计' }}</p></div><button v-if="conversation" type="button" class="icon-button" title="归档当前聊天" :disabled="loading || saving" @click="workbench.archiveConversation()"><span class="i-lucide-archive h-4 w-4"></span></button></header>
                <div class="messages" aria-live="polite">
                    <div v-if="!conversation?.messages.length" class="empty-chat">
                        <span class="i-lucide-sparkles empty-state-icon"></span>
                        <strong>从一个想法开始</strong>
                        <p>描述你要设计的内容，Inspiration 会按专业方向生成可审阅的成果。</p>
                    </div>
                    <article v-for="message in conversation?.messages" :key="message.id" class="message" :class="`message-${message.role}`"><span class="message-role">{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'Inspiration' : '状态' }} · {{ message.creationMode === 'adaptation' ? '改编设计' : '原创设计' }}</span><p>{{ message.content }}</p><small v-if="message.materialPaths?.length">参考：{{ message.materialPaths.map(workbench.materialName).join('、') }}</small><small v-if="message.source">{{ sourceName(message.source.path) }} · 分块 {{ message.source.chunkIndexes.join('、') }}</small></article>
                </div>
                <div class="composer">
                    <div class="creation-mode"><span>创作方式</span><SegmentedControl v-model="creationMode" :options="creationOptions" aria-label="素材创作方式" /></div>
                    <InspirationMaterialPicker v-if="creationMode === 'adaptation'" v-model:query="materialQuery" v-model:category="materialCategory" :items="materials" :selected="chosenMaterials" :total="materialTotal" :has-more="materialNextOffset !== null" :loading="loadingMaterials" :disabled="loading || saving || !!refiningArtifactId" :error="materialError" @toggle="workbench.toggleMaterial" @load-more="workbench.loadMaterials(true)" />
                    <FormTextarea v-model="request" :rows="4" :disabled="loading || saving" aria-label="设计需求" placeholder="例如：设计一支与主角敌对、信奉潮汐神的海上势力" />
                    <FormTextarea v-if="draft && canReuseDraft" v-model="feedback" :rows="2" :disabled="loading || saving" aria-label="重做反馈" placeholder="补充反馈，可沿用此草稿的原始需求重新设计" />
                    <p v-if="draft && !canReuseDraft" class="draft-context-hint">当前创作方式或参考来源已变更。已有成果仍可审阅保存；下一次发送会按新需求生成独立草稿。</p>
                    <div class="model-controls" aria-label="模型参数">
                        <label>模型<select v-model="modelKey" class="compact-field"><option :value="undefined">跟随默认模型</option><option v-for="item in modelOptions" :key="item.key" :value="item.key">{{ item.label }}</option></select></label>
                        <button type="button" class="thinking-switch" :class="thinkingEnabled ? 'is-on' : 'is-off'" :aria-pressed="thinkingEnabled" @click="thinkingEnabled = !thinkingEnabled"><span class="thinking-indicator"></span><span>思考</span><strong>{{ thinkingEnabled ? '开启' : '关闭' }}</strong></button>
                        <label class="temperature-label"><span>温度</span><input v-model.number="temperature" type="number" min="0" max="2" step="0.1" inputmode="decimal" aria-label="温度数值" @change="normalizeTemperature" /><input v-model.number="temperature" type="range" min="0" max="2" step="0.1" aria-label="温度滑块" @change="normalizeTemperature" /></label>
                    </div>
                    <p v-if="error" class="message-error">{{ error }}</p><p v-if="savedNotice" class="message-success">{{ savedNotice }}</p>
                    <div class="composer-actions"><Button variant="primary" :disabled="!canGenerate" icon-class="i-lucide-sparkles" @click="workbench.generate()">{{ loading ? '处理中…' : canReuseDraft ? '按反馈重做' : '发送需求' }}</Button><Button v-if="loading" variant="secondary" @click="workbench.cancel()">停止</Button></div>
                </div>
            </section>
            <section class="review-panel" aria-label="来源与成果审阅">
                <div class="section-title"><strong>待审阅成果</strong><span v-if="draft">版本 {{ draft.revision }} · {{ artifacts.length }} 项</span></div>
                <div v-if="visibleArtifacts.length" class="selection-toolbar"><label><input type="checkbox" :checked="allVisibleSelected" @change="allVisibleSelected ? workbench.deselectVisible(visibleArtifactIds) : workbench.selectVisible(visibleArtifactIds)" />全选当前</label><span v-if="selectedArtifactIds.length">已选 {{ selectedArtifactIds.length }} 项</span><button v-if="selectedArtifactIds.length" type="button" class="danger-button" @click="workbench.removeSelected()">删除所选</button></div>
                <div class="tabs"><button type="button" :class="activeCategory === 'all' ? 'is-active' : ''" @click="activeCategory = 'all'">全部</button><button v-for="category in INSPIRATION_CATEGORIES" :key="category" type="button" :class="activeCategory === category ? 'is-active' : ''" @click="activeCategory = category">{{ INSPIRATION_CATEGORY_LABELS[category] }}</button></div>
                <div v-if="!visibleArtifacts.length" class="empty-results">
                    <span class="i-lucide-panels-top-left empty-state-icon"></span>
                    <strong>成果将在这里呈现</strong>
                    <p>分析或设计完成后，你可以在这里审阅、编辑并保存成果。</p>
                </div>
                <article v-for="artifact in visibleArtifacts" :key="artifact.id" class="artifact"><div class="artifact-head"><label class="artifact-select"><input type="checkbox" :checked="selectedArtifactIds.includes(artifact.id)" @change="workbench.toggleArtifact(artifact.id)" /><span>{{ INSPIRATION_CATEGORY_LABELS[artifact.category] }}</span></label><small :title="citationText()">{{ citationText() }}</small></div><input v-model="artifact.title" class="artifact-title" /><textarea v-model="artifact.content" rows="7" class="field"></textarea><div class="artifact-refine"><input v-model="artifactInstructions[artifact.id]" class="compact-field refine-input" placeholder="针对该条候选提出修改或追问" /><button type="button" class="secondary-button" :disabled="!!refiningArtifactId || loading || saving" @click="refineArtifact(artifact.id, 'refine')">重新设计</button><button type="button" class="secondary-button" :disabled="!!refiningArtifactId || loading || saving" @click="refineArtifact(artifact.id, 'ask')">追问</button></div><p v-if="artifactAnswers[artifact.id]" class="artifact-answer">{{ artifactAnswers[artifact.id] }}</p></article>
                <button v-if="draft" type="button" class="primary-button save-button" :disabled="saving || loading || !!refiningArtifactId || !artifacts.length" @click="save()">{{ saving ? '保存中…' : '保存已审阅成果' }}</button>
            </section>
        </div>
        <div v-if="extractionMounted" v-show="page === 'extraction'" class="extraction-page">
            <InspirationExtractionPanel v-model:model-key="modelKey" :project-root="props.projectRoot" :model-options="modelOptions" @open-outline-plan="emit('open-outline-plan', $event)" />
        </div>
    </Dialog>
</template>

<style scoped>
.workbench{display:grid;grid-template-columns:200px minmax(300px,1fr) minmax(340px,1.1fr);height:min(760px,calc(100vh - 120px));min-height:500px;color:var(--text-main)}.sessions,.chat-panel,.review-panel{min-width:0}.sessions{overflow:auto;border-right:1px solid var(--border-color);background:var(--bg-subtle);padding:10px}.sidebar-header,.chat-header,.section-title,.composer-actions,.artifact-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-header{margin-bottom:8px;font-size:13px}.session-item{display:flex;width:100%;flex-direction:column;gap:2px;border:0;border-radius:6px;background:transparent;padding:8px;text-align:left;color:var(--text-secondary);font-size:12px}.session-item:hover,.session-item.is-active{background:var(--bg-hover);color:var(--text-main)}.session-item small,.empty-sidebar,.chat-header p,.message small,.section-title span,.source-hint{color:var(--text-muted);font-size:11px}.empty-sidebar{padding:8px;line-height:1.5}.chat-panel{display:flex;flex-direction:column;border-right:1px solid var(--border-color)}.chat-header{padding:12px 14px;border-bottom:1px solid var(--border-color)}.chat-header p{margin:2px 0 0}.messages{flex:1;overflow:auto;padding:12px}.empty-chat,.empty-results{display:grid;min-height:160px;place-items:center;color:var(--text-muted);font-size:13px;text-align:center}.message{max-width:88%;margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--bg-subtle);font-size:13px;white-space:pre-wrap}.message-user{margin-left:auto;background:var(--accent-bg)}.message-role{display:block;margin-bottom:3px;color:var(--accent-text);font-size:11px}.message p{margin:0}.composer{border-top:1px solid var(--border-color);padding:10px}.field{width:100%;resize:vertical;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);color:var(--text-main);padding:8px 10px;font-size:13px;outline:none}.field:focus{border-color:var(--accent-main)}.mode-switch,.tabs,.chip-list{display:flex;flex-wrap:wrap;gap:4px}.mode-switch{margin-bottom:7px}.mode-switch button,.tabs button,.chip-list button{border:1px solid var(--border-color);border-radius:5px;background:transparent;padding:4px 7px;color:var(--text-muted);font-size:11px}.mode-switch button.is-active,.tabs button.is-active,.chip-list button.is-selected{border-color:var(--accent-main);background:var(--accent-bg);color:var(--accent-text)}.composer-actions{justify-content:flex-end;margin-top:8px}.review-panel{overflow:auto;padding:12px}.section-title{margin:0 0 8px;font-size:13px}.source-panel{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border-color)}.source-meta{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;color:var(--text-muted);font-size:11px}.source-meta p{width:100%;margin:0;color:var(--status-warning)}.source-hint{margin:8px 0 0;line-height:1.5}.tabs{overflow:auto;flex-wrap:nowrap;margin-bottom:10px;padding-bottom:4px}.tabs button{white-space:nowrap}.artifact{margin-bottom:10px;border:1px solid var(--border-color);border-radius:7px;background:var(--bg-subtle);padding:10px}.artifact-head span{border-radius:4px;background:var(--accent-bg);padding:2px 5px;color:var(--accent-text);font-size:11px}.artifact-head small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:10px}.artifact-title{width:100%;margin:8px 0;border:0;background:transparent;color:var(--text-main);font-size:14px;font-weight:600;outline:0}.icon-button,.secondary-button,.primary-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border-color);border-radius:6px;padding:6px 10px;color:var(--text-secondary);font-size:12px}.icon-button{border:0;padding:5px}.icon-button:hover,.secondary-button:hover{background:var(--bg-hover);color:var(--text-main)}.primary-button{border-color:var(--accent-main);background:var(--accent-main);color:var(--accent-contrast,white)}button:disabled{opacity:.5;cursor:not-allowed}.message-error,.message-success{margin:7px 0 0;border:1px solid var(--border-color);border-radius:5px;padding:6px 8px;font-size:12px}.message-error{color:var(--status-danger)}.message-success{color:var(--status-success)}.save-button{width:100%;margin-top:4px}@media (max-width:900px){.workbench{grid-template-columns:150px minmax(270px,1fr);height:calc(100vh - 70px)}.review-panel{grid-column:1 / -1;border-top:1px solid var(--border-color);max-height:45vh}.chat-panel{border-right:0}}@media (max-width:520px){.workbench{grid-template-columns:1fr;height:calc(100vh - 60px)}.sessions{display:none}.chat-panel{min-height:360px}.review-panel{max-height:none}.artifact-head{align-items:flex-start;flex-direction:column}}
/* Inspiration 与 Novel IDE 的面板层保持同一组语义色，空状态也保留清晰的层级。 */
.workbench { background: var(--bg-main); }
/* Grid 的默认最小行高会被长回复撑大；每个面板必须在窗口分配的高度内自行滚动。 */
.workbench { height: auto; min-height: 0; flex: 1 1 0; grid-template-rows: minmax(0, 1fr); overflow: hidden; }
.sessions, .chat-panel, .review-panel { min-height: 0; }
.chat-panel { overflow: hidden; }
.chat-header { flex: 0 0 auto; }
.messages { display: flex; flex-direction: column; min-height: 0; }
.message, .artifact { flex-shrink: 0; min-width: 0; }
.message, .artifact-answer { overflow-wrap: anywhere; }
.review-panel { display: flex; flex-direction: column; gap: 0; }
.empty-sidebar { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin: 12px 4px 0; padding: 14px 12px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-panel); line-height: 1.6; }
.empty-sidebar p { margin: 0; }
.empty-sidebar-icon { color: var(--accent-text); font-size: 18px; }
.sidebar-create { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-accent); border-radius: 999px; background: var(--accent-bg); padding: 5px 9px; color: var(--accent-text); font-size: 11px; transition: background-color .15s ease, border-color .15s ease; }
.sidebar-create:hover { border-color: var(--accent-main); background: color-mix(in srgb, var(--accent-bg) 72%, var(--accent-main)); }
.sessions { background: var(--bg-sidebar); border-color: var(--border-color); }
.chat-panel { background: var(--bg-main); border-color: var(--border-color); }
.review-panel { background: var(--bg-main); }
.chat-header { background: var(--bg-panel); }
.messages { background: var(--bg-main); }
.composer { background: var(--bg-panel); box-shadow: 0 -4px 14px color-mix(in srgb, var(--shadow-color) 7%, transparent); }
.session-item { border: 1px solid transparent; border-radius: 8px; }
.session-item.is-active { border-color: var(--border-accent); background: var(--accent-bg); color: var(--text-main); }
.empty-chat, .empty-results { display: flex; flex-direction: column; align-items: center; justify-content: center; width: min(100%, 440px); max-width: 440px; min-height: 150px; margin: auto; padding: 24px; border: 1px dashed var(--border-strong); border-radius: 12px; background: var(--bg-panel); line-height: 1.7; text-align: center; }
.empty-chat { flex: 1; width: min(100%, 420px); min-height: 220px; }
.empty-chat strong, .empty-results strong { margin-top: 8px; color: var(--text-main); font-size: 14px; }
.empty-chat p, .empty-results p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; }
.empty-state-icon { color: var(--accent-text); font-size: 22px; }
.source-panel { border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-panel); padding: 12px; }
.section-title { color: var(--text-main); }
.source-meta { border-top: 1px solid var(--border-color); padding-top: 8px; }
.mode-switch button, .tabs button, .chip-list button { border-radius: 999px; transition: border-color .15s ease, background-color .15s ease, color .15s ease; }
.mode-switch button.is-active, .tabs button.is-active, .chip-list button.is-selected { border-color: var(--border-accent); background: var(--accent-bg); color: var(--accent-text); }
.field { border-color: var(--border-color); background: var(--bg-input); }
.field:hover { border-color: var(--border-strong); }
.field:focus { border-color: var(--accent-main); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-main) 18%, transparent); }
.message { border: 1px solid var(--border-color); background: var(--bg-panel); }
.message-user { border-color: var(--border-accent); background: var(--accent-bg); }
.artifact { border-radius: 10px; background: var(--bg-panel); box-shadow: 0 2px 8px color-mix(in srgb, var(--shadow-color) 6%, transparent); }
.artifact-head span { border: 1px solid var(--border-accent); }
.message-error { border-color: var(--status-danger-border); background: var(--status-danger-bg); }
.message-success { border-color: var(--status-success-border); background: var(--status-success-bg); }
.primary-button { color: var(--text-inverse); font-weight: 600; box-shadow: 0 2px 6px color-mix(in srgb, var(--shadow-color) 12%, transparent); }
@media (prefers-reduced-motion: reduce) { .mode-switch button, .tabs button, .chip-list button { transition: none; } }
.model-controls{display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-main);color:var(--text-muted);font-size:11px}.model-controls label{display:flex;align-items:center;gap:5px;min-width:0}.compact-field{max-width:150px;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-input);padding:4px 6px;color:var(--text-main);font-size:11px}.thinking-switch{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-strong);border-radius:999px;background:var(--bg-input);padding:5px 9px;color:var(--text-secondary);font-size:11px;font-weight:600;white-space:nowrap}.thinking-switch.is-on{border-color:var(--accent-main);background:var(--accent-bg);color:var(--accent-text)}.thinking-switch.is-off{opacity:.82}.thinking-indicator{width:8px;height:8px;border-radius:50%;background:var(--text-muted);box-shadow:0 0 0 2px color-mix(in srgb, var(--text-muted) 18%, transparent)}.thinking-switch.is-on .thinking-indicator{background:var(--accent-main);box-shadow:0 0 0 2px color-mix(in srgb, var(--accent-main) 22%, transparent)}.temperature-label{display:grid;grid-template-columns:auto 58px minmax(70px,1fr);align-items:center;gap:6px;flex:1;min-width:170px}.temperature-label input[type=number]{width:58px;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-input);padding:4px 5px;color:var(--text-main);font-size:11px}.temperature-label input[type=range]{min-width:70px;accent-color:var(--accent-main)}.selection-toolbar{display:flex;align-items:center;gap:10px;flex:0 0 auto;margin:0 0 8px;color:var(--text-muted);font-size:11px}.selection-toolbar label,.artifact-select{display:inline-flex;align-items:center;gap:6px}.danger-button{margin-left:auto;border:1px solid var(--status-danger-border);border-radius:6px;background:var(--status-danger-bg);padding:5px 8px;color:var(--status-danger);font-size:11px}.artifact-select span{border-radius:4px;background:var(--accent-bg);padding:2px 5px;color:var(--accent-text);font-size:11px}.review-panel .section-title,.review-panel .tabs,.review-panel .source-panel{flex-shrink:0}.review-panel .tabs{min-height:30px;align-items:flex-start}.review-panel .tabs button{flex:0 0 auto;line-height:18px}
.artifact-refine{display:flex;gap:6px;margin-top:8px}.refine-input{flex:1;max-width:none}.artifact-answer{margin:8px 0 0;border-left:2px solid var(--accent-main);padding-left:8px;color:var(--text-secondary);font-size:12px;white-space:pre-wrap}
@media (max-width:600px){.model-controls{flex-wrap:wrap}.model-controls .temperature-label{flex-basis:100%;min-width:0}.model-controls .compact-field{max-width:none;flex:1}}
.page-tabs {
    flex: 0 0 auto;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-subtle);
}
.composer { display: grid; flex: 0 0 auto; min-height: 0; max-height: 65%; overflow: auto; gap: var(--space-3); grid-auto-rows: max-content; align-content: start; }
.creation-mode { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--text-secondary); font-size: var(--text-xs); }
.draft-context-hint { margin: 0; color: var(--text-muted); font-size: var(--text-xs); }

@media (max-width: 900px) {
    .workbench { grid-template-rows: minmax(0, 3fr) minmax(0, 2fr); }
    .chat-panel { min-height: 0; }
    .review-panel { max-height: none; }
}

.extraction-page {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    color: var(--text-main);
}

</style>
