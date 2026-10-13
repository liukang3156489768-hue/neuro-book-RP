import {computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref} from "vue";

/** 服务端对象的并发基准，保存时作为 expectedVersion / expectedContentHash 发送。 */
export type OutlineAutosaveBase = Readonly<{version: number; contentHash: string}>;

export type OutlineAutosaveStatus =
    | Readonly<{kind: "idle"}>
    | Readonly<{kind: "dirty"}>
    | Readonly<{kind: "saving"}>
    | Readonly<{kind: "saved"}>
    /** 表单形状不合法，修好后自动继续保存 */
    | Readonly<{kind: "invalid"; message: string}>
    /** 需要作者先确认（总纲全局修改、已采用条目回到草稿、共用条目另存） */
    | Readonly<{kind: "blocked"}>
    | Readonly<{kind: "error"; message: string}>
    /** 条目在别处被修改，本地还有未保存内容 */
    | Readonly<{kind: "conflict"}>;

export type OutlineAutosaveOptions<F> = Readonly<{
    /** 当前编辑对象的身份；变化时按新对象重新载入表单 */
    key: () => string | null;
    /** 当前对象在快照中的基准；对象尚未出现在快照里时为 null */
    base: () => OutlineAutosaveBase | null;
    form: Ref<F>;
    /** 由当前快照生成表单 */
    load: () => F;
    /** 与服务端内容等价的序列化，用于判断是否有未保存修改 */
    serialize: (form: F) => string;
    validate: (form: F) => string | null;
    /** 返回 true 时暂停自动保存，等宿主拿到作者确认后调用 flush */
    blocked: () => boolean;
    /** 发出保存请求；payload 必须在第一次 await 之前从表单取完 */
    save: (form: F, base: OutlineAutosaveBase) => Promise<boolean>;
    errorMessage: () => string | null;
    delay?: number;
}>;

export type OutlineAutosave = Readonly<{
    status: Readonly<Ref<OutlineAutosaveStatus>>;
    dirty: ComputedRef<boolean>;
    /** 编辑器以它为 key：重新载入时递增，让富文本编辑器连同撤销历史一起重建 */
    generation: Readonly<Ref<number>>;
    /** 立即尝试保存并等待完成；返回之后是否已无未保存修改 */
    flush: () => Promise<boolean>;
    /** 丢弃本地修改，按当前快照重新载入 */
    reload: () => void;
}>;

/**
 * 大纲库与伏笔库的自动保存。每次保存都会让对象 version 加一；刷新回来的快照若正好是自己保存的
 * 下一个版本，就只更新基准、保留表单，作者输入不会被刷新打断。版本号不符说明他处改过：
 * 本地没有修改时直接载入新内容，有修改时进入冲突，由作者决定是否丢弃。
 *
 * 前提是服务端一次编辑只让该对象 version 加一；若编辑还会连带再改同一对象，回显判断会误报冲突。
 */
export function useOutlineAutosave<F>(options: OutlineAutosaveOptions<F>): OutlineAutosave {
    const delay = options.delay ?? 1000;
    const status = ref<OutlineAutosaveStatus>({kind: "idle"});
    const generation = ref(0);
    const revision = ref(0);
    let baseline = "";
    let base: OutlineAutosaveBase | null = null;
    let echoVersion: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let saving: Promise<void> | null = null;

    const dirty = computed(() => {
        void revision.value;
        return options.serialize(options.form.value) !== baseline;
    });

    function clearTimer(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    function reload(): void {
        clearTimer();
        options.form.value = options.load();
        baseline = options.serialize(options.form.value);
        base = options.base();
        echoVersion = null;
        status.value = {kind: "idle"};
        generation.value += 1;
        revision.value += 1;
    }

    function schedule(): void {
        clearTimer();
        timer = setTimeout(() => {
            timer = null;
            void attempt();
        }, delay);
    }

    function refreshStatus(): void {
        if (status.value.kind === "conflict" || status.value.kind === "saving") return;
        if (!dirty.value) {
            clearTimer();
            if (status.value.kind !== "saved") status.value = {kind: "idle"};
            return;
        }
        status.value = {kind: "dirty"};
        schedule();
    }

    function reconcile(): void {
        const current = options.base();
        if (!current || saving) return;
        if (base && current.version === base.version && current.contentHash === base.contentHash) return;
        if (echoVersion !== null && current.version === echoVersion) {
            base = current;
            echoVersion = null;
            return;
        }
        if (dirty.value && base) {
            clearTimer();
            status.value = {kind: "conflict"};
            return;
        }
        reload();
    }

    async function attempt(): Promise<void> {
        if (saving) {
            await saving;
            if (dirty.value) return attempt();
            return;
        }
        clearTimer();
        if (!dirty.value || status.value.kind === "conflict" || !base) return;
        const problem = options.validate(options.form.value);
        if (problem) {
            status.value = {kind: "invalid", message: problem};
            return;
        }
        if (options.blocked()) {
            status.value = {kind: "blocked"};
            return;
        }
        const submitted = options.serialize(options.form.value);
        const submittedBase = base;
        const key = options.key();
        status.value = {kind: "saving"};
        saving = (async () => {
            const ok = await options.save(options.form.value, submittedBase);
            // 子组件的快照 props 在父组件下一轮渲染才更新，等它落地再比对版本。
            await nextTick();
            if (options.key() !== key) return;
            if (!ok) {
                status.value = {kind: "error", message: options.errorMessage() ?? "保存失败"};
                return;
            }
            baseline = submitted;
            echoVersion = submittedBase.version + 1;
            status.value = {kind: "saved"};
            revision.value += 1;
        })();
        try {
            await saving;
        } finally {
            saving = null;
        }
        if (options.key() !== key) return;
        reconcile();
        refreshStatus();
    }

    async function flush(): Promise<boolean> {
        clearTimer();
        await attempt();
        return !dirty.value;
    }

    watch(options.key, () => reload(), {immediate: true});
    watch(options.base, () => reconcile());
    watch(options.form, () => {
        revision.value += 1;
        if (status.value.kind === "error" || status.value.kind === "invalid" || status.value.kind === "blocked") status.value = {kind: "dirty"};
        refreshStatus();
    }, {deep: true});
    onBeforeUnmount(clearTimer);

    return {status, dirty, generation, flush, reload};
}
