import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

// 聚焦规划和文件权限测试，不启动与本模块无关的 Agent workspace 快照。
export default defineConfig({
    root: rootDir,
    resolve: {alias: {nbook: rootDir}},
    test: {
        environment: "node",
        globalSetup: ["@notnotype/neuro-book-test-support/vitest"],
        setupFiles: ["@notnotype/neuro-book-test-support/vitest"],
        include: ["server/outline/*.test.ts", "server/api/projects/outline/*.test.ts", "server/agent/tools/file-tools.test.ts", "server/agent/tools/planning-specialist-tool.test.ts", "server/agent/tools/specialist-write-tools.test.ts", "server/agent/profiles/outline-specialist-profiles.test.ts"],
    },
});
