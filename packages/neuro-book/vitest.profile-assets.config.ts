import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

// 资产编译与安装不依赖数据库或 Project fixture；隔离执行避免触碰用户运行态。
export default defineConfig({
    root: fileURLToPath(new URL("./", import.meta.url)),
    resolve: {alias: {nbook: fileURLToPath(new URL("./", import.meta.url))}},
    oxc: false,
    esbuild: {tsconfigRaw: {compilerOptions: {target: "ESNext", jsx: "automatic", jsxImportSource: "nbook/profile-sdk"}}},
    test: {
        environment: "node",
        maxWorkers: 1,
        globalSetup: ["@notnotype/neuro-book-test-support/vitest"],
        setupFiles: ["@notnotype/neuro-book-test-support/vitest"],
        include: [
            "server/agent/profiles/inspiration-profiles.test.ts",
            "server/agent/profiles/profile-sdk-contract.test.ts",
            "server/agent/profiles/docs-tsx-examples.test.ts",
            "server/workspace-files/system-assets-preflight*.test.ts",
            "server/workspace-files/system-asset-installation.test.ts",
        ],
    },
});
