<script setup lang="ts">
import {nextTick, ref} from "vue";
import {Button, FormCheckbox, FormField, FormInput, FormSelect, FormTextarea, IconButton, TagInput} from "@notnotype/nb-ui/components";
import type {ForeshadowMarkerAction} from "nbook/shared/markdown-workbench";
import type {OutlineEntryFormValue} from "nbook/app/utils/outline/outline-entry-form";
import {createMarkerId, insertForeshadowMarker} from "nbook/app/utils/outline/outline-foreshadow-form";

const props = defineProps<{
    withMetadata: boolean;
    disabled?: boolean;
    /** 细纲正文可以带场景写作指导标注，提示作者保持标注格式。 */
    detail?: boolean;
    /** 提供时显示伏笔标记工具条；只有章节大纲的标记参与伏笔状态计算。 */
    foreshadowOptions?: readonly Readonly<{value: string; label: string}>[];
}>();
const form = defineModel<OutlineEntryFormValue>({required: true});

const bodyInput = ref<InstanceType<typeof FormTextarea> | null>(null);
const markerForeshadow = ref("");
const markerAction = ref<ForeshadowMarkerAction>("plant");
const markerError = ref<string | null>(null);
const actionOptions = [{value: "plant", label: "埋设"}, {value: "reinforce", label: "强化"}, {value: "recover", label: "回收"}];

async function insertMarker(): Promise<void> {
    const textarea = bodyInput.value?.$el as HTMLTextAreaElement | undefined;
    if (!textarea) return;
    if (!markerForeshadow.value) {
        markerError.value = "请先选择要标记的伏笔";
        return;
    }
    const result = insertForeshadowMarker(form.value.body, textarea.selectionStart, textarea.selectionEnd,
        {foreshadowId: markerForeshadow.value, action: markerAction.value, marker: createMarkerId()});
    if (typeof result === "string") {
        markerError.value = result;
        return;
    }
    markerError.value = null;
    form.value.body = result.body;
    await nextTick();
    textarea.focus();
    textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
}

function addReference(): void {
    form.value.references.push({path: "", locator: "", purpose: "", pending: false});
}
function removeReference(index: number): void {
    form.value.references.splice(index, 1);
}
</script>

<template>
    <div class="entry-form">
        <FormField label="标题" required>
            <FormInput v-model="form.title" :disabled="props.disabled" />
        </FormField>
        <FormField label="正文" :description="props.detail ? '场景写作指导以标注形式写在正文中，保存时会校验标注格式。' : undefined">
            <FormTextarea ref="bodyInput" v-model="form.body" :rows="12" :disabled="props.disabled" />
        </FormField>
        <section v-if="props.foreshadowOptions" class="marker-toolbar" aria-label="伏笔标记">
            <template v-if="props.foreshadowOptions.length">
                <FormSelect v-model="markerForeshadow" :options="[...props.foreshadowOptions]" placeholder="选择伏笔" size="sm" aria-label="伏笔" :disabled="props.disabled" />
                <FormSelect v-model="markerAction" :options="actionOptions" size="sm" aria-label="标记动作" :disabled="props.disabled" />
                <Button size="sm" variant="secondary" icon-class="i-lucide-bookmark-plus" :disabled="props.disabled" @click="insertMarker">标记选中文字</Button>
                <span class="marker-hint">章节大纲正式采用后，标记才会计入伏笔状态。</span>
            </template>
            <span v-else class="marker-hint">伏笔库还没有伏笔，先到伏笔库新建后再回来标记。</span>
            <p v-if="markerError" class="marker-error" role="alert">{{ markerError }}</p>
        </section>
        <template v-if="props.withMetadata">
            <div class="entry-form-grid">
                <FormField label="目标字数" description="留空表示不限定。">
                    <FormInput v-model="form.targetWords" inputmode="numeric" :disabled="props.disabled" />
                </FormField>
                <FormField label="素材索引" description="作品内的资料文件路径，回车添加。">
                    <TagInput v-model="form.materialRefs" placeholder="例如 lorebook/人物/林默.md" :disabled="props.disabled" />
                </FormField>
            </div>
            <FormField label="写作指导" description="交给正文写作的整体要求，例如节奏、视角和语气。">
                <FormTextarea v-model="form.writingGuidance" :rows="3" :disabled="props.disabled" />
            </FormField>
            <section class="reference-editor" aria-label="参考资料">
                <div class="reference-heading">
                    <strong>参考资料</strong>
                    <Button size="sm" variant="ghost" icon-class="i-lucide-plus" :disabled="props.disabled" @click="addReference">添加</Button>
                </div>
                <p v-if="!form.references.length" class="reference-empty">还没有参考资料。尚未找到的资料可以先标记为“待补”。</p>
                <article v-for="(item, index) in form.references" :key="index" class="reference-row">
                    <FormInput v-model="item.path" placeholder="文件路径" :disabled="props.disabled" aria-label="参考文件路径" />
                    <FormInput v-model="item.locator" placeholder="定位（章节、段落或所需资料说明）" :disabled="props.disabled" aria-label="参考定位" />
                    <FormInput v-model="item.purpose" placeholder="用途" :disabled="props.disabled" aria-label="参考用途" />
                    <FormCheckbox v-model="item.pending" label="待补" :disabled="props.disabled" />
                    <IconButton title="移除这条参考资料" icon-class="i-lucide-x" variant="danger" size="sm" :disabled="props.disabled" @click="removeReference(index)" />
                </article>
            </section>
        </template>
    </div>
</template>

<style scoped>
.entry-form { display: grid; gap: var(--space-5); }
.entry-form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--space-5); }
.reference-editor { display: grid; gap: var(--space-3); }
.reference-heading { display: flex; align-items: center; justify-content: space-between; font-size: var(--text-sm); }
.reference-empty { margin: 0; color: var(--text-muted); font-size: var(--text-2xs); }
.marker-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-top: calc(var(--space-3) * -1); }
.marker-hint { color: var(--text-muted); font-size: var(--text-2xs); }
.marker-error { flex-basis: 100%; margin: 0; color: var(--status-danger); font-size: var(--text-2xs); }
.reference-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); }
</style>
