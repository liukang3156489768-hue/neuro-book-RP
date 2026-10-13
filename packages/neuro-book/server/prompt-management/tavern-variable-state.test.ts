import {mkdirSync, renameSync} from "node:fs";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {absoluteFsPath} from "nbook/server/runtime/paths/file-path";
import {createRuntimePaths} from "nbook/server/runtime/paths/runtime-paths";
import type {FrozenWriterPromptSchema} from "nbook/shared/dto/tavern-preset.dto";
import {PromptManagementService} from "./service";

type Frozen = ReturnType<typeof FrozenWriterPromptSchema.parse>;
type Scope = NonNullable<Frozen["variableScope"]>;
type Variables = NonNullable<Frozen["tavernState"]>;
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
const initial: Variables = {local: {}, global: {}};
const scope = (attemptKey: string, ownerKey = "owner"): Scope => ({projectRoot: "book", purposeId: "writing.writer.scene", presetId: "preset", ownerKey, attemptKey});
const frozen = (variables: Variables): Frozen => ({snapshotId: "snapshot", systemPrompt: "", orderedMessages: [], tavernState: variables});
async function setup() {
    const root = await mkdtemp(join(tmpdir(), "tavern-variable-state-")); roots.push(root);
    const paths = createRuntimePaths({applicationRoot: absoluteFsPath(fileURLToPath(new URL("../../", import.meta.url))), stateRoot: absoluteFsPath(root)});
    return {root, service: new PromptManagementService(paths, []), restore: () => new PromptManagementService(paths, [])};
}

describe("酒馆变量持久化收据", () => {
    it("恢复同一attempt只读取冻结收据；编译失败不推进状态", async () => {
        const {service, restore} = await setup();
        await expect(service.compileWriter(scope("failed"), {local: {}, global: {x: "initial"}}, () => {throw new Error("compile failed");})).rejects.toThrow("compile failed");
        const result = await service.compileWriter(scope("one"), {local: {}, global: {x: "initial"}}, variables => {
            expect(variables.global.x).toBe("initial");
            return frozen({local: {y: "saved"}, global: {x: "saved"}});
        });
        expect(await restore().compileWriter(scope("one"), initial, () => {throw new Error("must not recompile");})).toEqual(result);
        const next = await restore().compileWriter(scope("two"), initial, frozen);
        expect(next.tavernState).toEqual({local: {y: "saved"}, global: {x: "saved"}});
    });
    it("多实例并发编译保持global增量，local按owner隔离，purpose与preset隔离", async () => {
        const {service, restore} = await setup();
        const results = await Promise.all(Array.from({length: 8}, (_, index) => restore().compileWriter(scope(`a-${index}`, `owner-${index}`),
            {local: {label: `owner-${index}`}, global: {}}, variables => frozen({...variables, global: {n: String(Number(variables.global.n ?? 0) + 1)}}))));
        expect(results.map(result => Number(result.tavernState!.global.n))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        const owner = await service.compileWriter(scope("owner-next", "owner-3"), initial, frozen);
        expect(owner.tavernState).toEqual({local: {label: "owner-3"}, global: {n: "8"}});
        const other = await service.compileWriter({...scope("other"), purposeId: "writing.writer.rewrite"}, initial, frozen);
        expect(other.tavernState).toEqual(initial);
    });
    it("并发输出仅提交变化字段，重复提交幂等；冲突不部分提交", async () => {
        const {service, restore} = await setup();
        const one = await service.compileWriter(scope("one"), {local: {}, global: {x: "0", y: "0"}}, frozen);
        await service.compileWriter(scope("two", "other"), initial, frozen);
        await Promise.all([
            service.applyWriterOutput(scope("one"), {local: {}, global: {x: "1", y: "0"}}),
            restore().applyWriterOutput(scope("two", "other"), {local: {}, global: {x: "0", y: "2"}}),
        ]);
        await service.applyWriterOutput(scope("one"), {local: {}, global: {x: "999"}});
        await expect(service.compileWriter(scope("conflict"), initial, frozen)).resolves.toMatchObject({tavernState: {global: {x: "1", y: "2"}}});
        await service.compileWriter(scope("advance"), initial, variables => frozen({...variables, global: {...variables.global, x: "3"}}));
        await expect(service.applyWriterOutput(scope("conflict"), {local: {new: "must not persist"}, global: {x: "4", y: "2"}})).rejects.toThrow("并发冲突");
        const final = await restore().compileWriter(scope("final"), initial, frozen);
        expect(final.tavernState).toEqual({local: {}, global: {x: "3", y: "2"}});
        expect(one.tavernState!.global.x).toBe("0");
    });
    it("收据的owner必须与请求scope一致，不能从其他owner重放或提交输出", async () => {
        const {service} = await setup();
        await service.compileWriter(scope("same", "one"), initial, frozen);
        await expect(service.compileWriter(scope("same", "two"), initial, frozen)).rejects.toThrow("作用域");
        await expect(service.applyWriterOutput(scope("same", "two"), {local: {other: "value"}, global: {}})).rejects.toThrow("作用域");
    });
    it("输出删除只提交before到after的差异，重复提交和同值并发删除幂等", async () => {
        const {service, restore} = await setup();
        const local: Record<string, string> = JSON.parse('{"remove":"local","keep":"kept","__proto__":"own"}');
        const first = await service.compileWriter(scope("one"), {local, global: {remove: "global", keep: "kept"}}, frozen);
        await service.compileWriter(scope("two"), initial, frozen);
        const after = {local: {keep: "kept"}, global: {keep: "kept"}};
        await Promise.all([service.applyWriterOutput(scope("one"), after), restore().applyWriterOutput(scope("two"), after)]);
        await service.applyWriterOutput(scope("one"), {local, global: {remove: "must not restore"}});
        const next = await restore().compileWriter(scope("next"), initial, frozen);
        expect(next.tavernState).toEqual(after);
        expect(Object.hasOwn(next.tavernState!.local, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(next.tavernState!.local)).toBe(Object.prototype);
        expect(first.tavernState!.local.remove).toBe("local");
        expect(Object.hasOwn(first.tavernState!.local, "__proto__")).toBe(true);
    });
    it("删除与并发改值冲突，不部分提交其他删除或新增，未变化字段不覆盖新值", async () => {
        const {service, restore} = await setup();
        await service.compileWriter(scope("stale"), {local: {remove: "L"}, global: {changed: "0", remove: "G"}}, frozen);
        await service.compileWriter(scope("concurrent"), initial, variables => frozen({...variables, global: {...variables.global, changed: "1", added: "new"}}));
        await expect(service.applyWriterOutput(scope("stale"), {local: {newLocal: "not saved"}, global: {remove: "G"}})).rejects.toThrow("并发冲突");
        const unchanged = await restore().compileWriter(scope("check"), initial, frozen);
        expect(unchanged.tavernState).toEqual({local: {remove: "L"}, global: {changed: "1", remove: "G", added: "new"}});
        await service.applyWriterOutput(scope("stale"), {local: {}, global: {changed: "0"}});
        const next = await restore().compileWriter(scope("next"), initial, frozen);
        expect(next.tavernState).toEqual({local: {}, global: {changed: "1", added: "new"}});
    });
    it("scope标识与变量使用prototype名称时不读取继承属性，也不污染其他对象", async () => {
        const {service, restore} = await setup();
        const values: Variables = {local: {constructor: "author", toString: "writer"}, global: {constructor: "global"}};
        for (const id of ["constructor", "toString", "__proto__"]) {
            const receipt = await service.compileWriter(scope(id, id), values, frozen);
            expect(receipt.tavernState).toEqual(values);
            expect(await restore().compileWriter(scope(id, id), initial, () => {throw new Error("must not recompile");})).toEqual(receipt);
        }
        expect(Object.hasOwn({}, "author")).toBe(false);
    });
    it("用户自定义__proto__变量不得在schema解析或持久化时静默丢失", async () => {
        const {service, restore} = await setup();
        const local: Record<string, string> = JSON.parse('{"__proto__":"plain text","constructor":"writer"}');
        const result = await service.compileWriter(scope("one"), {local, global: {}}, frozen);
        expect(Object.getOwnPropertyDescriptor(result.tavernState!.local, "__proto__")?.value).toBe("plain text");
        const next = await restore().compileWriter(scope("two"), initial, frozen);
        expect(Object.getOwnPropertyDescriptor(next.tavernState!.local, "__proto__")?.value).toBe("plain text");
    });
    it("大型编译结果独立存储，变量索引只记录owner和指纹", async () => {
        const {root, service} = await setup();
        const large = "long writing preset".repeat(15000);
        const receipt = await service.compileWriter(scope("one"), initial, variables => ({...frozen(variables), orderedMessages: [{role: "system", content: large}]}));
        const directory = join(root, "prompt-management", "tavern-variables");
        const content = await readFile(join(directory, (await readdir(directory))[0]!), "utf8");
        const index = JSON.parse(content);
        expect(content.length).toBeLessThan(1000);
        expect(Object.keys(index.attempts.one).sort()).toEqual(["ownerKey", "sha256"]);
        const receiptDirectory = join(root, "prompt-management", "tavern-compilations");
        expect(JSON.parse(await readFile(join(receiptDirectory, (await readdir(receiptDirectory))[0]!), "utf8"))).toEqual(receipt);
    });
    it("已引用收据丢失或损坏时明确失败，不重新编译或提交输出", async () => {
        const {root, service, restore} = await setup();
        await service.compileWriter(scope("one"), initial, frozen);
        const directory = join(root, "prompt-management", "tavern-compilations");
        const receiptPath = join(directory, (await readdir(directory))[0]!);
        const bytes = await readFile(receiptPath);
        await writeFile(receiptPath, "corrupted");
        await expect(restore().compileWriter(scope("one"), initial, () => {throw new Error("must not recompile");})).rejects.toThrow("校验失败");
        await expect(service.applyWriterOutput(scope("one"), initial)).rejects.toThrow("校验失败");
        await rm(receiptPath);
        await expect(restore().compileWriter(scope("one"), initial, frozen)).rejects.toThrow("收据缺失");
        await writeFile(receiptPath, bytes);
        expect((await restore().compileWriter(scope("one"), initial, frozen)).tavernState).toEqual(initial);
    });
    it("收据已写但状态替换失败时孤立收据不算提交，恢复从旧变量重新编译", async () => {
        const {root, service, restore} = await setup();
        const advance = (variables: Variables) => frozen({...variables, global: {n: String(Number(variables.global.n ?? 0) + 1)}});
        await service.compileWriter(scope("seed"), initial, advance);
        const stateDirectory = join(root, "prompt-management", "tavern-variables");
        const statePath = join(stateDirectory, (await readdir(stateDirectory))[0]!);
        const backupPath = `${statePath}.original`;
        // Replace the destination after its read to exercise a real failed atomic rename, without mocking filesystem semantics.
        await expect(service.compileWriter(scope("one"), initial, variables => {
            renameSync(statePath, backupPath);
            mkdirSync(statePath);
            return advance(variables);
        })).rejects.toThrow();
        await rm(statePath, {recursive: true});
        renameSync(backupPath, statePath);
        await expect(service.applyWriterOutput(scope("one"), initial)).rejects.toThrow("缺少对应");
        expect(await readdir(join(root, "prompt-management", "tavern-compilations"))).toHaveLength(2);
        const receipt = await restore().compileWriter(scope("one"), initial, advance);
        expect(receipt.tavernState!.global.n).toBe("2");
        expect((await restore().compileWriter(scope("two"), initial, advance)).tavernState!.global.n).toBe("3");
    });
});
