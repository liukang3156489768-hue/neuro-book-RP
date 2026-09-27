// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {flushPromises} from "@vue/test-utils";
import {ref} from "vue";
import {useOutlineWorkbenchData} from "./useOutlineWorkbenchData";

const snapshot = {manifest: {revision: 0, totalId: null, plans: []}, entries: [], foreshadowing: [], graphs: [], lines: []};
const responses: Record<string, unknown> = {
    open: snapshot,
    snapshot,
    "library-trees": [],
    "foreshadowing-states": {parserVersion: 1, states: [], elapsed: [], markerIssues: []},
};
const fetchMock = vi.fn((url: string, _options?: Record<string, unknown>) => Promise.resolve(responses[url.split("/").pop()!]));

beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("$fetch", fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("useOutlineWorkbenchData", () => {
    it("新作品首次加载先初始化规划，再并行读取三个只读视图", async () => {
        const data = useOutlineWorkbenchData(ref("/projects/a"));
        await flushPromises();

        const calls = fetchMock.mock.calls.map(([url]) => url.split("/").pop());
        expect(calls[0]).toBe("open");
        expect(fetchMock.mock.calls[0]![1]).toMatchObject({method: "POST", query: {projectRoot: "/projects/a"}});
        expect(calls.slice(1).sort()).toEqual(["foreshadowing-states", "library-trees", "snapshot"]);
        expect(data.error.value).toBeNull();
        expect(data.snapshot.value?.manifest.revision).toBe(0);
    });

    it("同一 Project 刷新不重复初始化，切换 Project 后重新初始化", async () => {
        const root = ref("/projects/a");
        const data = useOutlineWorkbenchData(root);
        await flushPromises();
        await data.refresh();
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/open"))).toHaveLength(1);

        root.value = "/projects/b";
        await flushPromises();
        const opens = fetchMock.mock.calls.filter(([url]) => url.endsWith("/open"));
        expect(opens).toHaveLength(2);
        expect(opens[1]![1]).toMatchObject({query: {projectRoot: "/projects/b"}});
    });

    it("初始化失败时不读取视图，下一次刷新重试初始化", async () => {
        fetchMock.mockImplementationOnce(() => Promise.reject(new Error("规划 manifest 丢失，但仍存在规划对象，拒绝初始化覆盖")));
        const data = useOutlineWorkbenchData(ref("/projects/a"));
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(data.error.value).toBeTruthy();

        await data.refresh();
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/open"))).toHaveLength(2);
        expect(data.error.value).toBeNull();
    });
});
