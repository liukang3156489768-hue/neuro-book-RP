import {onBeforeUnmount, onMounted, watch, type WatchStopHandle} from "vue";

type DialogKeyboardLayer = (event: KeyboardEvent) => void;
const stacks = new WeakMap<Document, DialogKeyboardLayer[]>();

/** 新旧模态宿主共用键盘栈；一次事件只能交给最后打开的对话框。 */
export function useDialogKeyboardStack(active: () => boolean, handleKeydown: DialogKeyboardLayer): void {
    let stop: WatchStopHandle | undefined;
    let release: (() => void) | undefined;

    onMounted(() => {
        const owner = document;
        stop = watch(active, (visible) => {
            release?.();
            release = undefined;
            if (!visible) return;

            let stack = stacks.get(owner);
            if (!stack) {
                stack = [];
                stacks.set(owner, stack);
            }
            const layers = stack;
            const dispatch = (event: KeyboardEvent): void => {
                if (!event.defaultPrevented && layers.at(-1) === handleKeydown) {
                    handleKeydown(event);
                }
            };
            layers.push(handleKeydown);
            owner.addEventListener("keydown", dispatch);
            release = () => {
                owner.removeEventListener("keydown", dispatch);
                const index = layers.indexOf(handleKeydown);
                if (index >= 0) layers.splice(index, 1);
                if (!layers.length) stacks.delete(owner);
            };
        }, {immediate: true, flush: "sync"});
    });

    onBeforeUnmount(() => {
        stop?.();
        release?.();
    });
}
