import {describe, expect, it} from "vitest";
import {parseForeshadowMarkers} from "./format";

describe("伏笔标记格式", () => {
    it("解析 plant 标记", () => {
        const body = `第一章正文开始。

<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->她注意到桌上那条银纹项链<!-- /nb:foreshadow marker="fm-01" -->，闪烁着微弱的光芒。

第一章正文结束。`;

        const markers = parseForeshadowMarkers(body, new Set(["fo-001"]));

        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({
            marker: "fm-01",
            foreshadowId: "fo-001",
            action: "plant",
            content: "她注意到桌上那条银纹项链"
        });
    });

    it("解析 reinforce 标记", () => {
        const body = `第三章正文开始。

<!-- nb:foreshadow marker="fm-02" foreshadow="fo-001" action="reinforce" -->那条银纹项链又一次出现在她的视线中<!-- /nb:foreshadow marker="fm-02" -->。

第三章正文结束。`;

        const markers = parseForeshadowMarkers(body, new Set(["fo-001"]));

        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({
            marker: "fm-02",
            foreshadowId: "fo-001",
            action: "reinforce",
            content: "那条银纹项链又一次出现在她的视线中"
        });
    });

    it("解析 recover 标记", () => {
        const body = `第九章正文开始。

<!-- nb:foreshadow marker="fm-03" foreshadow="fo-001" action="recover" -->原来那条银纹项链是她母亲留下的唯一遗物<!-- /nb:foreshadow marker="fm-03" -->，真相终于揭晓。

第九章正文结束。`;

        const markers = parseForeshadowMarkers(body, new Set(["fo-001"]));

        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({
            marker: "fm-03",
            foreshadowId: "fo-001",
            action: "recover",
            content: "原来那条银纹项链是她母亲留下的唯一遗物"
        });
    });

    it("解析多个标记", () => {
        const body = `第五章正文。

<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="reinforce" -->银纹项链再次闪光<!-- /nb:foreshadow marker="fm-01" -->。

中间段落。

<!-- nb:foreshadow marker="fm-02" foreshadow="fo-002" action="plant" -->她发现了一个神秘的盒子<!-- /nb:foreshadow marker="fm-02" -->。`;

        const markers = parseForeshadowMarkers(body, new Set(["fo-001", "fo-002"]));

        expect(markers).toHaveLength(2);
        expect(markers[0].marker).toBe("fm-01");
        expect(markers[1].marker).toBe("fm-02");
    });

    it("拒绝未知伏笔 ID", () => {
        const body = `<!-- nb:foreshadow marker="fm-01" foreshadow="fo-999" action="plant" -->文本<!-- /nb:foreshadow marker="fm-01" -->`;

        expect(() => parseForeshadowMarkers(body, new Set(["fo-001"])))
            .toThrow("未知伏笔 ID");
    });

    it("拒绝未配对标记", () => {
        const body = `<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->文本`;

        expect(() => parseForeshadowMarkers(body, new Set(["fo-001"])))
            .toThrow("未闭合");
    });

    it("拒绝嵌套标记", () => {
        const body = `<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->外层<!-- nb:foreshadow marker="fm-02" foreshadow="fo-002" action="plant" -->内层<!-- /nb:foreshadow marker="fm-02" --><!-- /nb:foreshadow marker="fm-01" -->`;

        expect(() => parseForeshadowMarkers(body, new Set(["fo-001", "fo-002"])))
            .toThrow("嵌套");
    });

    it("拒绝重复 marker ID", () => {
        const body = `<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->第一次<!-- /nb:foreshadow marker="fm-01" -->
<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="reinforce" -->第二次<!-- /nb:foreshadow marker="fm-01" -->`;

        expect(() => parseForeshadowMarkers(body, new Set(["fo-001"])))
            .toThrow("不唯一");
    });

    it("标记内容可以包含换行", () => {
        const body = `<!-- nb:foreshadow marker="fm-01" foreshadow="fo-001" action="plant" -->第一行
第二行
第三行<!-- /nb:foreshadow marker="fm-01" -->`;

        const markers = parseForeshadowMarkers(body, new Set(["fo-001"]));

        expect(markers[0].content).toBe("第一行\n第二行\n第三行");
    });
});
