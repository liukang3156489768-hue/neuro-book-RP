<script setup lang="ts">
import {computed, ref, shallowRef, toRaw, watch} from "vue";
import {Button, Badge, FormInput, FormTextarea, FormSelect, TagInput, SegmentedControl, Dialog} from "@notnotype/nb-ui/components";
import type {CharacterDetailRecordDto as DetailRecord, CharacterFacetDto as CharacterFacet, CharacterPlanDto, CharacterProfileDto as CharacterProfile, CharacterRecordDto} from "nbook/shared/dto/character-workspace.dto";

type RecordKind = "experience" | "relationships" | "knowledge";
type WorkspaceBindings = {
    characters: CharacterRecordDto[];
    plans: CharacterPlanDto[];
    loading?: boolean;
    saving?: boolean;
    error?: string;
    commitProfile: (id: string, profile: CharacterProfile, avatarFile?: File | null) => Promise<void>;
    commitFacet: (id: string, planId: string, kind: "experience" | "relationships" | "knowledge" | "state", facet: CharacterFacet) => Promise<void>;
    openFile: (path: string) => void;
};

function emptyFacet(): CharacterFacet {
    return {experience: [], relationships: [], knowledge: [], state: {chapter: "", location: "", items: "", psychology: ""}};
}
function characterFile(id: string, scope: string, kind: string): string {
    return `lorebook/character/${id}/${scope === "original" ? "original" : `plans/${scope}`}/${kind === "knowledge" ? "knowledge/index.md" : `${kind}.md`}`;
}

const props = defineProps<WorkspaceBindings>();
const selectedId = ref(props.characters.find((character) => character.profile)?.id ?? "");
const scope = ref("original");
const query = ref("");
const tag = ref("all");
const sort = ref("name");
const listMode = ref("list");
const showIssues = ref(false);
const mobileSection = ref("profile");
const detailOrigin = ref("original");
const detailKind = ref<RecordKind>("experience");
const profileDraft = ref<CharacterProfile | null>(null);
const facetDraft = ref<CharacterFacet | null>(null);
const editingRecordId = ref("");
const editingState = ref(false);
const saving = ref(false);
const choosingImage = ref(false);
const avatarFile = ref<File | null>(null);
const error = ref("");
const notice = ref("");
const pendingAction = shallowRef<(() => void) | null>(null);
const avatarInput = ref<HTMLInputElement | null>(null);

watch(() => props.characters, (characters) => {
    if (!characters.some((item) => item.id === selectedId.value && item.profile)) {
        selectedId.value = characters.find((item) => item.profile)?.id ?? "";
    }
}, {deep: false});

const selected = computed(() => props.characters.find((character) => character.id === selectedId.value));
const profile = computed(() => selected.value?.profile);
const plan = computed(() => props.plans.find((item) => item.id === scope.value));
const activeFacet = computed(() => scope.value === "original" ? selected.value?.original : selected.value?.plans[scope.value]);
const visibleFacet = computed(() => detailOrigin.value === "original" ? selected.value?.original : activeFacet.value);
const activeDetails = computed(() => visibleFacet.value?.[detailKind.value] ?? []);
const sourceScope = computed(() => detailOrigin.value === "original" ? "original" : scope.value);
const sourcePath = computed(() => characterFile(selectedId.value, sourceScope.value, detailKind.value));
const canEditDetails = computed(() => detailOrigin.value === "plan" && scope.value !== "original");
const originalDraft = ref("");
const dirty = computed(() => {
    if (profileDraft.value) return JSON.stringify(profileDraft.value) !== originalDraft.value;
    if (facetDraft.value) return JSON.stringify(facetDraft.value) !== originalDraft.value;
    return false;
});
const editorActive = computed(() => Boolean(profileDraft.value || facetDraft.value));
const recordDraft = computed(() => facetDraft.value?.[detailKind.value].find((row) => row.id === editingRecordId.value));
const issues = computed(() => props.characters.filter((item) => !item.profile));
const formal = computed(() => props.characters.filter((item) => item.profile));
// 方案资料可以从空白开始编辑；只有原作侧面要求已有正式角色入口。
const eligible = computed(() => formal.value);
const tagOptions = computed(() => [
    {label: "全部角色标签", value: "all"},
    ...[...new Set(formal.value.flatMap((item) => item.profile?.tags ?? []))].map((value) => ({label: value, value})),
]);
const relationOptions = computed(() => [
    {label: "请选择关联角色", value: "none"},
    ...formal.value.filter((item) => item.id !== selectedId.value).map((item) => ({label: item.profile?.name ?? item.id, value: item.id})),
]);
const filtered = computed(() => {
    const keyword = query.value.trim().toLocaleLowerCase();
    const list = eligible.value.filter((item) => {
        const p = item.profile;
        if (!p) return false;
        return (tag.value === "all" || p.tags.includes(tag.value))
            && [p.name, ...p.aliases, ...p.tags, p.summary, item.id].join(" ").toLocaleLowerCase().includes(keyword);
    });
    return list.sort((a, b) => sort.value === "name"
        ? (a.profile?.name ?? "").localeCompare(b.profile?.name ?? "", "zh-CN")
        : (a.profile?.name ?? "").localeCompare(b.profile?.name ?? "", "zh-CN") * -1);
});
const profileFields: {key: keyof Pick<CharacterProfile, "identity" | "appearance" | "clothing" | "family" | "economy" | "abilities" | "personality" | "temperament">; label: string; long?: boolean}[] = [
    {key: "identity", label: "基本身份"}, {key: "appearance", label: "外貌", long: true},
    {key: "clothing", label: "穿着", long: true}, {key: "family", label: "家庭情况", long: true},
    {key: "economy", label: "经济情况", long: true}, {key: "abilities", label: "特殊能力", long: true},
    {key: "personality", label: "性格"}, {key: "temperament", label: "性格描述", long: true},
];
const stateFields = [
    {key: "chapter" as const, label: "上次出现章节"}, {key: "location" as const, label: "上次出现位置"},
    {key: "items" as const, label: "持有物品"}, {key: "psychology" as const, label: "心理状态"},
];
const kindLabels: Record<RecordKind, string> = {experience: "经历", relationships: "关系", knowledge: "角色知识"};

function clearDraft(): void {
    const preview = profileDraft.value?.avatarUrl;
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
    profileDraft.value = null;
    facetDraft.value = null;
    avatarFile.value = null;
    editingRecordId.value = "";
    editingState.value = false;
    error.value = "";
}
function change(action: () => void): void {
    if (saving.value || choosingImage.value) return;
    if (dirty.value) {
        pendingAction.value = action;
    } else {
        clearDraft();
        notice.value = "";
        action();
    }
}
function selectCharacter(id: string): void {
    change(() => {
        selectedId.value = id;
        mobileSection.value = "profile";
    });
}
function selectScope(id: string): void {
    change(() => {
        scope.value = id;
        detailOrigin.value = id === "original" ? "original" : "plan";
        const current = props.characters.find((item) => item.id === selectedId.value);
        if (!current?.profile) {
            selectedId.value = formal.value[0]?.id ?? "";
        }
        showIssues.value = false;
    });
}
function editProfile(): void {
    const currentProfile = profile.value;
    if (!currentProfile) return;
    change(() => {
        profileDraft.value = structuredClone(toRaw(currentProfile));
        avatarFile.value = null;
        originalDraft.value = JSON.stringify(profileDraft.value);
    });
}
function editState(): void {
    change(() => {
        facetDraft.value = structuredClone(toRaw(activeFacet.value ?? emptyFacet()));
        originalDraft.value = JSON.stringify(facetDraft.value);
        editingState.value = true;
    });
}
function editRecord(record?: DetailRecord): void {
    change(() => {
        facetDraft.value = structuredClone(toRaw(activeFacet.value ?? emptyFacet()));
        originalDraft.value = JSON.stringify(facetDraft.value);
        if (record) {
            editingRecordId.value = record.id;
        } else {
            const row: DetailRecord = {
                id: crypto.randomUUID(), title: "", content: "", source: "",
                targetId: "", unknown: "", misunderstanding: "",
            };
            facetDraft.value[detailKind.value].push(row);
            editingRecordId.value = row.id;
        }
    });
}
async function save(): Promise<boolean> {
    if (saving.value || choosingImage.value) return false;
    error.value = "";
    if (profileDraft.value && !profileDraft.value.name.trim()) {
        error.value = "请填写角色名称。";
        return false;
    }
    if (recordDraft.value) {
        if (!recordDraft.value.title.trim() || !recordDraft.value.content.trim()) {
            error.value = "请填写记录标题和内容。";
            return false;
        }
        if (detailKind.value === "relationships" && !relationOptions.value.some((option) => option.value !== "none" && option.value === recordDraft.value?.targetId)) {
            error.value = "请选择一个既有角色作为关系对象。";
            return false;
        }
    }
    saving.value = true;
    try {
        if (profileDraft.value) await props.commitProfile(selectedId.value, {...profileDraft.value, name: profileDraft.value.name.trim()}, avatarFile.value);
        if (facetDraft.value) await props.commitFacet(selectedId.value, scope.value, editingState.value ? "state" : detailKind.value, facetDraft.value);
        clearDraft();
        notice.value = "已保存";
        return true;
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "保存失败，请重试。";
        return false;
    } finally {
        saving.value = false;
    }
}
async function leave(saveFirst: boolean): Promise<void> {
    if (saveFirst && !(await save())) {
        pendingAction.value = null;
        return;
    }
    const action = pendingAction.value;
    pendingAction.value = null;
    clearDraft();
    action?.();
}
async function pickAvatar(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.files?.[0] || !profileDraft.value) return;
    choosingImage.value = true;
    error.value = "";
    try {
        const file = input.files[0];
        const previousPreview = profileDraft.value.avatarUrl;
        if (previousPreview?.startsWith("blob:")) URL.revokeObjectURL(previousPreview);
        const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
        profileDraft.value.avatar = `avatar.${extension}`;
        profileDraft.value.avatarUrl = URL.createObjectURL(file);
        avatarFile.value = file;
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : "图片无法读取，请选择其他图片。";
    } finally {
        choosingImage.value = false;
        input.value = "";
    }
}

defineExpose({
    hasUnsaved: dirty,
    saving,
    requestLeave(action: () => void): void {
        change(action);
    },
});
</script>

<template>
    <section class="character-workspace" aria-label="角色管理">
        <header class="workspace-heading">
            <div class="heading-copy">
                <span class="eyebrow">角色档案 / CHARACTER</span>
                <h1>角色管理 <span class="heading-count">{{ formal.length }}</span></h1>
                <p>从基础人设到每个方案中的成长，放在同一处查看。</p>
            </div>
            <div class="heading-actions"><Badge size="sm" tone="accent" variant="soft" dot>文件为准</Badge></div>
        </header>

        <div class="scope-bar">
            <span class="scope-caption">资料侧面</span>
            <div class="scope-tabs" aria-label="大纲方案">
                <Button size="sm" :variant="scope === 'original' ? 'primary' : 'ghost'" :aria-pressed="scope === 'original'" @click="selectScope('original')">基础 / 原作</Button>
                <Button v-for="item in props.plans" :key="item.id" size="sm" :variant="scope === item.id ? 'primary' : 'ghost'" :aria-pressed="scope === item.id" @click="selectScope(item.id)">{{ item.title }}</Button>
            </div>
            <span class="scope-note">{{ scope === 'original' ? '原作资料保留来源' : '方案资料独立保存' }}</span>
        </div>
        <div class="mobile-navigation">
            <SegmentedControl :model-value="mobileSection" :options="[{value: 'list', label: '角色列表'}, {value: 'profile', label: '基础信息'}, {value: 'details', label: '经历关系'}]" aria-label="角色页面区域" full-width @update:model-value="(value) => change(() => mobileSection = String(value))" />
        </div>

        <div class="workspace-columns" :data-mobile-section="mobileSection">
            <aside class="roster-pane" aria-label="角色列表">
                <div class="roster-controls">
                    <div class="pane-title"><h2>角色库</h2><span>{{ eligible.length }} 位角色</span></div>
                    <FormInput v-model="query" type="search" placeholder="搜索名称、别名、标签…" aria-label="搜索角色" clearable />
                    <div class="filter-row">
                        <FormSelect v-model="tag" :options="tagOptions" aria-label="角色标签筛选" class="filter-select" size="sm" />
                        <FormSelect v-model="sort" :options="[{value: 'name', label: '姓名升序'}, {value: 'reverse', label: '姓名降序'}]" aria-label="角色排序" class="sort-select" size="sm" />
                    </div>
                    <div class="list-mode-row">
                        <SegmentedControl v-model="listMode" :options="[{value: 'list', label: '条目'}, {value: 'cards', label: '卡片'}]" aria-label="角色显示方式" size="xs" />
                        <Button size="sm" :variant="showIssues ? 'secondary' : 'ghost'" @click="change(() => showIssues = !showIssues)">资料异常 {{ issues.length }}</Button>
                    </div>
                </div>

                <div class="pane-scroll roster-content">
                    <template v-if="showIssues">
                        <article v-for="item in issues" :key="item.id" class="issue-card">
                            <Badge tone="warning" size="sm">资料异常</Badge>
                            <h3>{{ item.id }}</h3><p>{{ item.issue }}</p>
                            <Button size="sm" variant="secondary" @click="props.openFile('lorebook/character/' + item.id + '/')">查看目录</Button>
                        </article>
                        <div v-if="!issues.length" class="empty-copy">所有角色资料完整。</div>
                    </template>
                    <div v-else :class="['roster-entries', {'card-grid': listMode === 'cards'}]">
                        <Button v-for="item in filtered" :key="item.id" variant="ghost" :class="['character-choice', {'is-selected': selectedId === item.id, 'is-card': listMode === 'cards'}]" :aria-pressed="selectedId === item.id" :aria-label="'查看角色 ' + item.profile?.name" @click="selectCharacter(item.id)">
                            <span class="choice-avatar">
                                <img v-if="item.profile?.avatarUrl" :src="item.profile.avatarUrl" alt="" />
                                <span v-else>{{ item.profile?.name.slice(0, 1) }}</span>
                            </span>
                            <span class="choice-info">
                                <strong>{{ item.profile?.name }}</strong>
                                <span class="choice-tags">{{ item.profile?.tags.join(' · ') }}</span>
                            </span>
                            <span v-if="listMode === 'cards'" class="card-tag">{{ item.profile?.tags[0] }}</span>
                        </Button>
                    </div>
                    <div v-if="!showIssues && !filtered.length" class="empty-copy">
                        <h3>没有匹配的角色</h3><p>试试其他关键词或角色标签。</p>
                        <Button variant="secondary" size="sm" @click="query = ''; tag = 'all'">清空筛选</Button>
                    </div>
                </div>
                <footer class="roster-footer">仅显示有效入口文件的角色</footer>
            </aside>

            <main class="profile-pane" aria-label="角色基础信息">
                <div v-if="!profile" class="empty-copy">选择一个角色，查看基础信息。</div>
                <template v-else>
                    <header class="pane-toolbar">
                        <div><h2>基础信息</h2><span>{{ profileDraft ? '编辑中的草稿' : '角色共用的基础人设' }}</span></div>
                        <Button v-if="!profileDraft" variant="secondary" size="sm" :disabled="saving" @click="editProfile">编辑资料</Button>
                        <Badge v-else tone="warning" size="sm">未保存</Badge>
                    </header>
                    <div class="pane-scroll profile-content">
                        <div class="profile-hero">
                            <div class="hero-avatar">
                                <img v-if="(profileDraft || profile).avatarUrl" :src="(profileDraft || profile).avatarUrl" :alt="profile.name + '的形象'" />
                                <span v-else>{{ profile.name.slice(0, 1) }}</span>
                            </div>
                            <div class="hero-copy">
                                <span class="eyebrow">CHARACTER PROFILE</span>
                                <h2>{{ profileDraft?.name || profile.name }}</h2>
                                <p>{{ profileDraft?.identity ?? profile.identity }}</p>
                                <div class="badge-row"><Badge v-for="label in (profileDraft || profile).tags" :key="label" size="sm">{{ label }}</Badge></div>
                                <Button v-if="profileDraft" variant="secondary" size="sm" :loading="choosingImage" @click="avatarInput?.click()">{{ profileDraft.avatarUrl ? '更换角色图片' : '设置角色图片' }}</Button>
                                <span v-else-if="!profile.avatar" class="muted small">尚未设置角色图片</span>
                                <input ref="avatarInput" type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="上传角色图片" @change="pickAvatar" />
                            </div>
                        </div>

                        <template v-if="profileDraft">
                            <div class="field"><label for="character-name">名称</label><FormInput id="character-name" v-model="profileDraft.name" /></div>
                            <div class="field"><label for="character-aliases">别名</label><TagInput id="character-aliases" v-model="profileDraft.aliases" placeholder="输入别名后回车" /></div>
                            <div class="field"><label for="character-tags">角色标签</label><TagInput id="character-tags" v-model="profileDraft.tags" placeholder="输入标签后回车" /></div>
                            <div class="field"><label for="character-summary">角色摘要</label><FormTextarea id="character-summary" v-model="profileDraft.summary" :rows="2" /></div>
                            <div v-for="field in profileFields" :key="field.key" class="field">
                                <label :for="'profile-' + field.key">{{ field.label }}</label>
                                <FormTextarea v-if="field.long" :id="'profile-' + field.key" v-model="profileDraft[field.key]" :rows="2" />
                                <FormInput v-else :id="'profile-' + field.key" v-model="profileDraft[field.key]" />
                            </div>
                            <p v-if="profileDraft.avatar" class="file-caption">图片相对路径：{{ profileDraft.avatar }}</p>
                        </template>
                        <template v-else>
                            <div class="profile-summary">{{ profile.summary || '尚未填写角色摘要。' }}</div>
                            <dl class="profile-definitions">
                                <div><dt>别名</dt><dd>{{ profile.aliases.join('、') || '未记录' }}</dd></div>
                                <div v-for="field in profileFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ profile[field.key] || '未记录' }}</dd></div>
                            </dl>
                        </template>

                        <section v-if="!profileDraft" class="state-section">
                            <div class="section-heading"><h3>正文状态追踪</h3><Badge size="sm" :tone="scope === 'original' ? 'neutral' : 'accent'">{{ scope === 'original' ? '原作' : '当前方案' }}</Badge></div>
                            <p class="section-description">{{ plan?.description || '来自原作，供改编时参考。' }}</p>
                            <div v-if="editingState && facetDraft" class="state-editor">
                                <div v-for="field in stateFields" :key="field.key" class="field"><label :for="'state-' + field.key">{{ field.label }}</label><FormTextarea :id="'state-' + field.key" v-model="facetDraft.state[field.key]" :rows="2" /></div>
                            </div>
                            <dl v-else class="state-definitions">
                                <div v-for="field in stateFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ activeFacet?.state[field.key] || '未记录' }}</dd></div>
                            </dl>
                            <Button v-if="scope !== 'original' && !editingState" variant="ghost" size="sm" @click="editState">编辑当前方案状态</Button>
                        </section>
                        <Button variant="ghost" size="sm" class="source-button" @click="props.openFile('lorebook/character/' + selectedId + '/index.md')">查看基础文件</Button>
                    </div>
                    <footer v-if="profileDraft || editingState" class="editor-footer">
                        <span class="muted">{{ dirty ? '修改尚未保存' : '编辑模式' }}</span>
                        <Button variant="ghost" size="sm" :disabled="saving || choosingImage" @click="clearDraft">取消</Button>
                        <Button size="sm" :loading="saving" :disabled="choosingImage" @click="save">保存{{ editingState ? '状态' : '资料' }}</Button>
                    </footer>
                    <footer v-else class="profile-footer"><span>基础人设不会被方案切换覆盖</span></footer>
                </template>
            </main>

            <aside class="details-pane" aria-label="角色经历关系与知识">
                <header class="pane-toolbar">
                    <div><h2>经历与关系</h2><span>{{ detailOrigin === 'original' ? '原作资料 · 只读' : plan?.title }}</span></div>
                    <Badge size="sm" :tone="canEditDetails ? 'accent' : 'neutral'">{{ canEditDetails ? '方案资料' : '只读' }}</Badge>
                </header>
                <div class="detail-controls">
                    <SegmentedControl :model-value="detailOrigin" :options="[{value: 'original', label: '原作资料'}, {value: 'plan', label: '当前方案', disabled: scope === 'original'}]" aria-label="详情来源" full-width @update:model-value="(value) => change(() => detailOrigin = String(value))" />
                    <div class="detail-tabs" aria-label="详细信息类别">
                        <Button v-for="kind in (['experience', 'relationships', 'knowledge'] as const)" :key="kind" size="sm" :variant="detailKind === kind ? 'secondary' : 'ghost'" :aria-pressed="detailKind === kind" @click="change(() => detailKind = kind)">{{ kindLabels[kind] }} <span class="tab-count">{{ visibleFacet?.[kind].length || 0 }}</span></Button>
                    </div>
                    <p class="detail-explanation">{{ detailKind === 'knowledge' ? '区分角色已知、未知与误解，保留信息差。' : canEditDetails ? '新增内容只归属于当前方案。' : '保留原作依据；编辑底层文件或重新提取可更新。' }}</p>
                    <Button v-if="canEditDetails && !recordDraft && profile" variant="secondary" size="sm" block @click="editRecord()">新增{{ kindLabels[detailKind] }}</Button>
                </div>
                <div class="pane-scroll detail-content">
                    <div v-if="!profile" class="empty-copy">请先选择角色。</div>
                    <template v-else-if="recordDraft">
                        <Badge size="sm" tone="warning">编辑当前方案 · {{ kindLabels[detailKind] }}</Badge>
                        <div class="field"><label for="record-title">记录标题</label><FormInput id="record-title" v-model="recordDraft.title" /></div>
                        <div v-if="detailKind === 'relationships'" class="field"><label for="record-target">关联角色</label><FormSelect id="record-target" :model-value="recordDraft.targetId || 'none'" :options="relationOptions" @update:model-value="(value) => recordDraft && (recordDraft.targetId = value === 'none' ? '' : value)" /></div>
                        <div class="field"><label for="record-content">{{ detailKind === 'knowledge' ? '角色已知的内容' : '内容' }}</label><FormTextarea id="record-content" v-model="recordDraft.content" :rows="6" /></div>
                        <template v-if="detailKind === 'knowledge'">
                            <div class="field"><label for="record-unknown">未知内容 / 信息差</label><FormTextarea id="record-unknown" v-model="recordDraft.unknown" :rows="3" /></div>
                            <div class="field"><label for="record-misunderstanding">角色的误解</label><FormTextarea id="record-misunderstanding" v-model="recordDraft.misunderstanding" :rows="3" /></div>
                        </template>
                        <div class="field"><label for="record-source">来源章节 / 信息来源</label><FormInput id="record-source" v-model="recordDraft.source" placeholder="例如：第 1 卷 · 第 2 章" /></div>
                    </template>
                    <template v-else>
                        <article v-for="(row, index) in activeDetails" :key="row.id" class="detail-record">
                            <header><span class="record-number">{{ String(index + 1).padStart(2, '0') }}</span><h3>{{ row.title }}</h3><Button v-if="canEditDetails" variant="ghost" size="sm" :aria-label="'编辑 ' + row.title" @click="editRecord(row)">编辑</Button></header>
                            <p>{{ row.content }}</p>
                            <div v-if="row.targetId" class="relation-target">关联角色：{{ props.characters.find((item) => item.id === row.targetId)?.profile?.name || row.targetId }}</div>
                            <div v-if="detailKind === 'knowledge' && row.unknown" class="knowledge-note"><span>未知 / 信息差</span><p>{{ row.unknown }}</p></div>
                            <div v-if="detailKind === 'knowledge' && row.misunderstanding" class="knowledge-note misunderstanding"><span>角色误解</span><p>{{ row.misunderstanding }}</p></div>
                            <footer>{{ row.source || '尚未标注来源' }}</footer>
                        </article>
                        <div v-if="!activeDetails.length" class="empty-copy"><h3>尚未记录{{ kindLabels[detailKind] }}</h3><p>{{ canEditDetails ? '可以为当前方案补充，原作资料保持独立。' : '这里仅展示文件中已经记录的原作资料。' }}</p></div>
                    </template>
                </div>
                <footer v-if="recordDraft" class="editor-footer">
                    <span class="muted">仅保存至当前方案</span>
                    <Button variant="ghost" size="sm" :disabled="saving" @click="clearDraft">取消</Button>
                    <Button size="sm" :loading="saving" @click="save">保存记录</Button>
                </footer>
                <footer v-else class="detail-footer">
                    <span class="file-caption" :title="sourcePath">{{ sourcePath.split('/').slice(2).join('/') }}</span>
                    <Button variant="ghost" size="sm" :disabled="!profile" @click="props.openFile(sourcePath)">查看文件</Button>
                </footer>
            </aside>
        </div>
        <div class="workspace-status" aria-live="polite">
            <span :class="error ? 'error-message' : notice ? 'success-message' : 'muted'">{{ error || notice || (editorActive ? '编辑草稿只在保存后生效。' : '角色资料来自当前项目 lorebook/character/ 目录') }}</span>
            <span class="status-context">{{ profile?.name || '未选择角色' }} / {{ plan?.title || '基础与原作' }}</span>
        </div>
        <Dialog :model-value="Boolean(pendingAction)" title="当前修改尚未保存" size="default" :show-footer="false" :close-on-overlay="false" :busy="saving" @update:model-value="(value) => {if (!value) pendingAction = null}">
            <p>保存当前修改后再继续，或放弃本次草稿。</p>
            <div class="leave-actions">
                <Button variant="ghost" :disabled="saving" @click="pendingAction = null">继续编辑</Button>
                <Button variant="secondary" :disabled="saving" @click="leave(false)">放弃修改</Button>
                <Button :loading="saving" @click="leave(true)">保存并继续</Button>
            </div>
        </Dialog>
    </section>
</template>

<style src="./character-workspace.css" scoped></style>
