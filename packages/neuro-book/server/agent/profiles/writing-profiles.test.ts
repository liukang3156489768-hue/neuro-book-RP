import {describe, expect, it} from "vitest";
import {Value} from "typebox/value";
import leadDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/writing.lead.profile";
import assistantDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/writing.assistant.profile";
import writerDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/writing.writer.profile";
import reviewerDefinition from "../../../assets/workspace/.nbook/agent/profiles/builtin/writing.material-review.profile";
import {normalizeAgentProfile} from "nbook/server/agent/profiles/define-agent-profile";
import {createTestRuntimeSession} from "nbook/server/agent/profiles/test/runtime-session";
import {createTestVariableAccessor} from "nbook/server/agent/variables/test-utils";
import type {AgentProfile} from "nbook/server/agent/profiles/types";
import {WRITING_PROFILES} from "nbook/server/writing/writing-workflow";
import {isReportResultBinding, reportResultSchemaForProfile} from "nbook/server/agent/profiles/report-result-schema";

const lead = normalizeAgentProfile(leadDefinition);
const assistant = normalizeAgentProfile(assistantDefinition);
const writer = normalizeAgentProfile(writerDefinition);
const reviewer = normalizeAgentProfile(reviewerDefinition);

// 三个角色都不能写文件；通用读取工具没有路径范围，会绕过助手的资料边界和主创“不读原始资料”的约束。
const FILE_TOOLS = ["read", "write", "edit", "apply_patch", "bash"];
const PLANNING_TOOLS = ["get_planning_context", "get_foreshadowing_context", "apply_planning_change", "commit_planning_change", "write_lorebook", "edit_lorebook"];

describe("写作角色 Profile 合同", () => {
    it("Profile key 与写作工作流使用的角色键一致", () => {
        expect([lead, assistant, writer, reviewer].map(({manifest}) => manifest.key)).toEqual(Object.values(WRITING_PROFILES));
    });

    it("主创持有发起、续写、停止、核对与查询工具，不读资料、不写文件", () => {
        const toolKeys: readonly string[] = lead.rootToolKeys;
        expect([...toolKeys].sort()).toEqual([
            "answer_rewrite", "answer_scene_plan", "continue_writing", "edit_chapter_prose", "get_writing_status", "read_chapter_prose", "request_user_input", "start_rewrite",
            "start_writing", "stop_writing",
        ]);
        expect(Value.Check(lead.initialSchema!, {})).toBe(true);
        expect(Value.Check(lead.initialSchema!, {chapterEntryId: "ol-ch1"})).toBe(true);
        expect(Value.Check(lead.initialSchema!, {chapterEntryId: "../ch1"})).toBe(false);
        expect(Value.Check(lead.initialSchema!, {projectRoot: "demo"})).toBe(false);
    });

    it("助手只持有限定范围的资料工具与结构化提交", () => {
        const toolKeys: readonly string[] = assistant.rootToolKeys;
        expect([...toolKeys].sort()).toEqual(["list_writing_materials", "read_writing_material", "report_result"]);
        for (const forbidden of [...FILE_TOOLS, ...PLANNING_TOOLS]) expect(toolKeys).not.toContain(forbidden);
    });

    it("独立审核只读取章节资料并提交审核结果，不能写正文或文件", async () => {
        expect([...reviewer.rootToolKeys].sort()).toEqual(["list_writing_materials", "read_writing_material", "report_result"]);
        expect(Value.Check(reviewer.initialSchema!, {chapterEntryId: "ol-ch1"})).toBe(true);
        expect(Value.Check(reviewer.outputSchema!, {materialReview: {passed: true, problems: []}})).toBe(true);
        expect(Value.Check(reviewer.outputSchema!, {plan: {scenes: []}})).toBe(false);
        expect((await prepare(reviewer, {chapterEntryId: "ol-ch1"})).systemPrompt).toContain("独立写作资料审核助手");
    });

    it("助手初始值只接受合法章节 id，调用输入区分规划与审阅，提交外壳为 plan 或 review", () => {
        expect(Value.Check(assistant.initialSchema!, {chapterEntryId: "ol-ch1"})).toBe(true);
        expect(Value.Check(assistant.initialSchema!, {chapterEntryId: "../ch1"})).toBe(false);
        expect(Value.Check(assistant.initialSchema!, {chapterEntryId: "ol-ch1", projectRoot: "demo"})).toBe(false);
        expect(Value.Check(assistant.payloadSchema!, {kind: "plan-scenes", chapterEntryId: "ol-ch1", materials: {}, feedback: {}})).toBe(true);
        expect(Value.Check(assistant.payloadSchema!, {kind: "review-scene", sceneIndex: 1, prompt: {system: "s", user: "u"}, output: "正文"})).toBe(true);
        expect(Value.Check(assistant.payloadSchema!, {kind: "rewrite"})).toBe(false);
        // 结构的严格校验在工作流侧，外壳只拦截字段名写错，让工作流能带着原因退回。
        expect(Value.Check(assistant.outputSchema!, {plan: {scenes: []}, issues: []})).toBe(true);
        expect(Value.Check(assistant.outputSchema!, {review: {passed: true, elements: [], problems: []}})).toBe(true);
        expect(Value.Check(assistant.outputSchema!, {scenes: []})).toBe(false);
    });

    it("助手的 report_result 必须带 data，结构不能只写进 result 字符串", () => {
        const binding = assistant.tools.report_result;
        expect(isReportResultBinding(binding)).toBe(true);
        const dataSchema = isReportResultBinding(binding) ? binding.dataSchemaFromInitial?.({chapterEntryId: "ol-ch1"}) : undefined;
        expect(dataSchema).toBe(assistant.outputSchema);
        const parameters = reportResultSchemaForProfile(assistant, dataSchema);
        expect(Value.Check(parameters, {result: "{\"plan\":{\"scenes\":[]}}"})).toBe(false);
        expect(Value.Check(parameters, {result: "完成", data: "{\"plan\":{}}"})).toBe(false);
        expect(Value.Check(parameters, {result: "完成", data: {plan: {scenes: []}}})).toBe(true);
    });

    it("写手没有任何工具，系统提示就是工作流渲染的那份", async () => {
        expect(writer.rootToolKeys).toEqual([]);
        expect(Value.Check(writer.initialSchema!, {system: ""})).toBe(false);
        const system = "你是写手。\n\n## 文风要求\n- 冷峻";
        const plan = await prepare(writer, {system});
        expect(plan.systemPrompt).toBe(system);
        expect(plan.historyInitMessages ?? []).toEqual([]);
    });

    it("主创与助手的系统提示写明边界", async () => {
        const leadPlan = await prepare(lead, {});
        expect(leadPlan.systemPrompt).toContain("不使用通用文件写入");
        expect(leadPlan.systemPrompt).toContain("edit_chapter_prose");
        expect(leadPlan.systemPrompt).toContain("只按用户明确的决定调用 answer_scene_plan");
        expect(leadPlan.systemPrompt).not.toContain("本会话是章节");
        expect((await prepare(lead, {chapterEntryId: "ol-ch1"})).systemPrompt).toContain("本会话是章节 ol-ch1 的写作会话");
        const assistantPlan = await prepare(assistant, {chapterEntryId: "ol-ch1"});
        expect(assistantPlan.systemPrompt).toContain("ol-ch1");
        expect(assistantPlan.systemPrompt).toContain("不读取伏笔定义");
        expect(assistantPlan.systemPrompt).toContain("report_result");
    });

    // 同一助手会话会先规划再审阅；每次调用按 payload.kind 只载入对应模式，避免规划时看到审阅规则或反之。
    it("助手系统提示按调用种类只载入对应模式", async () => {
        const modes = {"plan-scenes": "场景规划（输入 kind 为 plan-scenes）", "review-scene": "审阅（输入 kind 为 review-scene）",
            "plan-rewrite": "改写规划（输入 kind 为 plan-rewrite）", "review-rewrite": "改写审阅（输入 kind 为 review-rewrite）"};
        for (const [kind, heading] of Object.entries(modes)) {
            const {systemPrompt} = await prepare(assistant, {chapterEntryId: "ol-ch1"}, {kind});
            expect(systemPrompt).toContain(heading);
            for (const other of Object.values(modes)) if (other !== heading) expect(systemPrompt).not.toContain(other);
            expect(systemPrompt).toContain("问题登记");
        }
        const review = (await prepare(assistant, {chapterEntryId: "ol-ch1"}, {kind: "review-scene"})).systemPrompt;
        expect(review).toContain("严禁提前展开下一场景的剧情");
        expect(review).toContain("{review: {passed, elements, forbidden, problems}, issues?}");
        expect(review).toContain("没有点明作用（purpose）");
        const plan = (await prepare(assistant, {chapterEntryId: "ol-ch1"}, {kind: "plan-scenes"})).systemPrompt;
        expect(plan).toContain("细纲的写作指导原文会直接传给写手，你不要复述");
        expect(plan).not.toContain("effect");
        expect(Value.Check(assistant.payloadSchema!, {kind: "plan-chapter"})).toBe(true);
    });
});

async function prepare(profile: AgentProfile<any>, initial: object, payload?: object) {
    return profile.prepare!({
        session: createTestRuntimeSession({profileKey: profile.manifest.key, currentProjectRoot: "demo"}),
        initial,
        ...(payload ? {invocation: {payload, caller: {kind: "user"}}} : {}),
        vars: createTestVariableAccessor(),
        catalog: {profiles: [], issues: []},
        skills: [],
        settings: {},
    });
}
