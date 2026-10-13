import {spawnSync} from "node:child_process";
import {rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {runTavernPresetSmoke} from "./tavern-preset";

const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});

describe("酒馆兼容对照 CLI", () => {
    it("只读报告不输出正文，参数错误以非零退出", async () => {
        const root = await createTestTmpRoot("tavern-smoke", "cli-contract"); roots.push(root);
        const preset = join(root, "preset.json"), bindings = join(root, "bindings.json");
        await writeFile(preset, JSON.stringify({prompts: [{identifier: "a", role: "user", content: "PRIVATE_FIXTURE_BODY"}],
            prompt_order: [{character_id: 100001, order: [{identifier: "a", enabled: true}]}]}));
        await writeFile(bindings, JSON.stringify({user: "作者", char: "写手", slots: {}}));
        const report = await runTavernPresetSmoke(["--preset", preset, "--bindings", bindings]);
        expect(report).toMatchObject({compilation: {messages: 1}, upstreamComparison: "not-run"});
        expect(JSON.stringify(report)).not.toContain("PRIVATE_FIXTURE_BODY");
        await expect(runTavernPresetSmoke(["--preset", preset, "--reference", "missing.txt"])).rejects.toThrow("--bindings");
        const cli = fileURLToPath(new URL("./tavern-preset.ts", import.meta.url));
        const success = spawnSync("bun", [cli, "--preset", preset, "--bindings", bindings], {encoding: "utf8"});
        expect(success.status, success.stderr).toBe(0);
        expect(JSON.parse(success.stdout)).toMatchObject({compilation: {messages: 1}});
        const failure = spawnSync("bun", [cli, "--unknown"], {encoding: "utf8"});
        expect(failure.status).toBe(1);
    });
});
