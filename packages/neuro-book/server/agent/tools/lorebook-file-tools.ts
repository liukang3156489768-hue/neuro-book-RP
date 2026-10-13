import {Type} from "typebox";
import {assertPlanningWriteGrant} from "nbook/server/agent/tools/planning-delegation";
import type {NeuroAgentTool} from "nbook/server/agent/tools/types";

/** 旧会话仍可能引用这些工具名；明确拒绝旧入口，避免绕过规划与改编记录的同批提交。 */
export function createLorebookFileTools(): NeuroAgentTool[] {
    return ["write_lorebook", "edit_lorebook"].map(key => ({
        key, name: key, label: "素材写入入口已更新",
        description: "规划 Agent 不再直接写 lorebook。基础素材只读，新信息通过 create-entry/edit-entry 的 materialUpdates 与规划同时提交。缺少对象时请用户先到设计工作台创建。",
        parameters: Type.Object({}, {additionalProperties: true}),
        mutatesWorkspace: true, executionMode: "sequential" as const,
        async executeWithContext(context) {
            assertPlanningWriteGrant(context.sessionId);
            throw new Error("规划模块不能新建素材或修改基础信息；请通过规划条目的 materialUpdates 保存当前方案的新信息");
        },
    }));
}
