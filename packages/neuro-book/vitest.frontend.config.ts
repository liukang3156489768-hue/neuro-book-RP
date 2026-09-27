import {fileURLToPath} from "node:url";
import vue from "@vitejs/plugin-vue";
import {defineConfig} from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

// UI 回归不启动 Agent artifact 快照；它的 symlink 权限与浏览器组件无关。
export default defineConfig({
    root: rootDir,
    plugins: [vue()],
    define: {"import.meta.client": "true"},
    resolve: {alias: {nbook: rootDir}},
    test: {
        environment: "jsdom",
        maxWorkers: 2,
        globalSetup: ["@notnotype/neuro-book-test-support/vitest"],
        setupFiles: ["@notnotype/neuro-book-test-support/vitest"],
        include: ["app/components/**/*.test.ts", "app/utils/world-engine-*.test.ts", "app/utils/outline/**/*.test.ts"],
    },
});

