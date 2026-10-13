import {cp, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {createTestTmpRoot} from "@notnotype/neuro-book-test-support/tmp";
import {seedSystemAssets} from "nbook/server/workspace-files/system-asset-installation";
import {AgentProfileCatalog} from "nbook/server/agent/profiles/catalog";
import {compileProfileArtifacts, createProfileArtifactPathContext} from "nbook/server/agent/profiles/profile-artifact-compiler";
import {resolveRuntimeArtifactCompilerContext} from "nbook/server/utils/runtime-artifact-compiler-context";

const applicationRoot = fileURLToPath(new URL("../../../", import.meta.url));
const builtinRoot = resolve(applicationRoot, "assets/workspace/.nbook/agent/profiles/builtin");
const categories = ["character", "faction", "instruction", "item", "location", "note", "system", "world"];
const profileKeys = ["inspiration", ...categories.map(category => `inspiration.${category}`)];
const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

describe("Inspiration Profile 安装后的可运行性", () => {
    it.each(["首次安装", "从缺失依赖的旧版本升级"])("%s：八个 Profile 都能编译并由 Catalog 加载", async mode => {
        const root = await createTestTmpRoot("inspiration-profiles", "profile-install-compile-load");
        roots.push(root);
        const seedApplication = join(root, "application");
        const seedBuiltin = join(seedApplication, "assets/workspace/.nbook/agent/profiles/builtin");
        const stateRoot = join(root, "state");
        const profileRoot = join(stateRoot, "workspace/.nbook/agent/profiles");
        await mkdir(seedBuiltin, {recursive: true});
        await mkdir(join(seedApplication, "assets/reference"), {recursive: true});
        const compilerContext = await resolveRuntimeArtifactCompilerContext(applicationRoot);
        const contextFor = (rootPath: string, label: string) => Promise.resolve(createProfileArtifactPathContext(rootPath, label, compilerContext));
        const compile = async () => compileProfileArtifacts({
            profileRoot,
            artifactPathContext: await contextFor(profileRoot, "workspace/.nbook/agent/profiles"),
            stagingRoot: join(root, "staging"),
            skipFresh: true,
            orphanBudgetPolicy: "product",
        });

        if (mode === "从缺失依赖的旧版本升级") {
            for (const category of categories) {
                await writeFile(join(seedBuiltin, `inspiration.${category}.profile.tsx`), [
                    'import {specialistProfile} from "./inspiration-specialist";',
                    `export const profileManifest = {key: "inspiration.${category}"};`,
                    `export default specialistProfile("${category}");`,
                ].join("\n"));
            }
            await seedSystemAssets({applicationRoot: seedApplication, stateRoot});
            const failed = await compile();
            expect(failed.manifest.entries).toHaveLength(categories.length);
            for (const entry of failed.manifest.entries) {
                expect(entry).toMatchObject({status: "compile_failed", issues: [{message: expect.stringContaining("./inspiration-specialist")}]});
            }
        }

        // 复制实际 Seed，而由真实安装器决定包单元；直接复制到 Install Root 会掩盖依赖遗漏。
        for (const fileName of (await readdir(builtinRoot)).filter(name => name.startsWith("inspiration"))) {
            await cp(join(builtinRoot, fileName), join(seedBuiltin, fileName), {recursive: true});
        }
        const installed = await seedSystemAssets({applicationRoot: seedApplication, stateRoot});
        expect(installed.manifest.assets.filter(asset => asset.state === "installed").map(asset => asset.id).sort()).toEqual([...profileKeys].sort());
        const compiled = await compile();
        expect(compiled.manifest.entries.filter(entry => entry.status === "compile_failed").map(entry => ({key: entry.profileKey, issues: entry.issues.map(issue => issue.message)}))).toEqual([]);
        expect(compiled.manifest.entries.map(entry => ({key: entry.profileKey, status: entry.status})).sort((a, b) => a.key.localeCompare(b.key)))
            .toEqual([...profileKeys].sort().map(key => ({key, status: "loaded"})));

        const catalog = new AgentProfileCatalog(profileRoot, undefined, undefined, undefined, contextFor);
        for (const key of profileKeys) {
            const profile = await catalog.get(key);
            expect(profile.manifest.key).toBe(key);
            expect(profile.rootToolKeys).toEqual(["report_result"]);
            expect(catalog.parseInitial(profile, key === "inspiration" ? {} : {fields: ["名称", "规则"]})).toBeDefined();
            expect(profile.outputSchema).toBeDefined();
        }
        expect((await seedSystemAssets({applicationRoot: seedApplication, stateRoot})).seeded).toBe(false);
    }, 120_000);
});
