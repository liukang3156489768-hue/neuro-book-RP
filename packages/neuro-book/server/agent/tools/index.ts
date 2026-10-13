import {createFileTools} from "nbook/server/agent/tools/file-tools";
import {createPlanningMaterialTools} from "nbook/server/agent/tools/planning-material-tools";
import {createPlanningTools, createSpecialistPlanningTools} from "nbook/server/agent/tools/planning-tools";
import {createPlanningDelegationTool, createPlanningSpecialistTool} from "nbook/server/agent/tools/planning-specialist-tool";
import {createLorebookFileTools} from "nbook/server/agent/tools/lorebook-file-tools";
import {createPlotTools} from "nbook/server/agent/tools/plot-tools";
import {createSqlTool} from "nbook/server/agent/tools/sql-tool";
import {createSubjectMemoryTools} from "nbook/server/agent/tools/subject-memory-tools";
import {createTaskTools} from "nbook/server/agent/tools/task-tools";
import {createWebTools} from "nbook/server/agent/tools/web-tools";
import {createWorldEngineTools} from "nbook/server/agent/tools/world-engine-tools";
import {createWorkflowTools} from "nbook/server/agent/tools/workflow-tools";
import {createExtractionTools} from "nbook/server/agent/tools/extraction-tools";
import {createWritingAssistantTools, createWritingLeadTools} from "nbook/server/agent/tools/writing-tools";
import {createJobTools} from "nbook/server/agent/tools/job-tools";
import {agentCollaborationTools} from "nbook/server/agent/tools/agent-collaboration-tools";
import {controlTools} from "nbook/server/agent/tools/control-tools";
import {createVariableTools} from "nbook/server/agent/variables/tools";
import {defineAgentToolFromRuntime} from "nbook/server/agent/tools/types";
import type {AgentToolDefinition, NeuroAgentTool} from "nbook/server/agent/tools/types";

export {agentCollaborationTools} from "nbook/server/agent/tools/agent-collaboration-tools";
export {controlTools, createReportResultTool, ReportResultSchema} from "nbook/server/agent/tools/control-tools";

function buildAgentTools() {
    const planningTools = definitionsByKey(createPlanningTools());
    const planningMaterialTools = definitionsByKey(createPlanningMaterialTools());
    const specialistPlanningTools = definitionsByKey(createSpecialistPlanningTools());
    const lorebookFileTools = definitionsByKey(createLorebookFileTools());
    const fileTools = definitionsByKey(createFileTools());
    const taskTools = definitionsByKey(createTaskTools());
    const plotTools = definitionsByKey(createPlotTools());
    const variableTools = definitionsByKey(createVariableTools());
    const webTools = definitionsByKey(createWebTools());
    const worldEngineTools = definitionsByKey(createWorldEngineTools());
    const subjectMemoryTools = definitionsByKey(createSubjectMemoryTools());
    const sqlTool = defineAgentToolFromRuntime(createSqlTool());
    const workflowTools = createWorkflowTools();
    const jobTools = createJobTools();
    const writingLeadTools = createWritingLeadTools();
    const writingAssistantTools = createWritingAssistantTools();
    const extractionTools = createExtractionTools();
    return {
        read: requireDefinition(fileTools, "read"),
        write: requireDefinition(fileTools, "write"),
        edit: requireDefinition(fileTools, "edit"),
        applyPatch: requireDefinition(fileTools, "apply_patch"),
        bash: requireDefinition(fileTools, "bash"),
        taskCreate: requireDefinition(taskTools, "task_create"),
        taskSetStatus: requireDefinition(taskTools, "task_set_status"),
        getStoryTree: requireDefinition(plotTools, "get_story_tree"),
        getStoryThread: requireDefinition(plotTools, "get_story_thread"),
        getStorySceneContext: requireDefinition(plotTools, "get_story_scene_context"),
        getSceneWorldContext: requireDefinition(plotTools, "get_scene_world_context"),
        getStoryChapter: requireDefinition(plotTools, "get_story_chapter"),
        getChapterWriterBrief: requireDefinition(plotTools, "get_chapter_writer_brief"),
        getPlanningContext: requireDefinition(planningTools, "get_planning_context"),
        listPlanningMaterials: requireDefinition(planningMaterialTools, "list_planning_materials"),
        readPlanningMaterial: requireDefinition(planningMaterialTools, "read_planning_material"),
        getForeshadowingContext: requireDefinition(planningTools, "get_foreshadowing_context"),
        suggestForeshadowingMarker: requireDefinition(planningTools, "suggest_foreshadowing_marker"),
        previewPlanningChange: requireDefinition(planningTools, "preview_planning_change"),
        applyPlanningChange: requireDefinition(planningTools, "apply_planning_change"),
        undoPlanningChange: requireDefinition(planningTools, "undo_planning_change"),
        consultPlanningSpecialist: defineAgentToolFromRuntime(createPlanningSpecialistTool()),
        delegatePlanningTask: defineAgentToolFromRuntime(createPlanningDelegationTool()),
        commitPlanningChange: requireDefinition(specialistPlanningTools, "commit_planning_change"),
        writeLorebook: requireDefinition(lorebookFileTools, "write_lorebook"),
        editLorebook: requireDefinition(lorebookFileTools, "edit_lorebook"),
        getStoryPromise: requireDefinition(plotTools, "get_story_promise"),
        getStoryDecision: requireDefinition(plotTools, "get_story_decision"),
        saveStoryAct: requireDefinition(plotTools, "save_story_act"),
        saveStoryChapter: requireDefinition(plotTools, "save_story_chapter"),
        saveStoryThread: requireDefinition(plotTools, "save_story_thread"),
        saveStoryScene: requireDefinition(plotTools, "save_story_scene"),
        saveStoryPromise: requireDefinition(plotTools, "save_story_promise"),
        savePromiseBeat: requireDefinition(plotTools, "save_promise_beat"),
        saveStoryDecision: requireDefinition(plotTools, "save_story_decision"),
        getWritingStatus: writingLeadTools.getWritingStatus,
        startWriting: writingLeadTools.startWriting,
        continueWriting: writingLeadTools.continueWriting,
        stopWriting: writingLeadTools.stopWriting,
        answerScenePlan: writingLeadTools.answerScenePlan,
        startRewrite: writingLeadTools.startRewrite,
        answerRewrite: writingLeadTools.answerRewrite,
        readChapterProse: writingLeadTools.readChapterProse,
        editChapterProse: writingLeadTools.editChapterProse,
        listWritingMaterials: writingAssistantTools.listWritingMaterials,
        readWritingMaterial: writingAssistantTools.readWritingMaterial,
        startInspirationExtraction: extractionTools.startExtraction,
        getInspirationExtractionProgress: extractionTools.getProgress,
        confirmInspirationMaterialWrite: extractionTools.confirmMaterialWrite,
        getInspirationExtractionFailures: extractionTools.getFailures,
        executeSql: sqlTool,
        runWorkflow: workflowTools.runWorkflow,
        listWorkflows: workflowTools.listWorkflows,
        listJobs: jobTools.listJobs,
        getJob: jobTools.getJob,
        cancelJob: jobTools.cancelJob,
        variableSchema: requireDefinition(variableTools, "variable_schema"),
        variableRead: requireDefinition(variableTools, "variable_read"),
        variablePatch: requireDefinition(variableTools, "variable_patch"),
        subjectRagSearch: requireDefinition(subjectMemoryTools, "subject_rag_search"),
        subjectEventAppend: requireDefinition(subjectMemoryTools, "subject_event_append"),
        subjectMemoryUpdate: requireDefinition(subjectMemoryTools, "subject_memory_update"),
        executeWorld: requireDefinition(worldEngineTools, "execute_world"),
        webSearch: requireDefinition(webTools, "web_search"),
        webFetch: requireDefinition(webTools, "web_fetch"),
        ...controlTools,
        ...agentCollaborationTools,
    } as const;
}

export function createAgentToolRuntimes(): NeuroAgentTool[] {
    return Object.values(buildAgentTools()).map((definition) => definition.runtime());
}

/**
 * 构造 v3 内置工具 runtime。profile 自带工具不进入全局 registry。
 */
export function createBuiltinTools(): NeuroAgentTool[] {
    return createAgentToolRuntimes();
}

function definitionsByKey(tools: NeuroAgentTool[]): Record<string, AgentToolDefinition> {
    return Object.fromEntries(tools.map((tool) => [tool.key, defineAgentToolFromRuntime(tool)]));
}

function requireDefinition<const TKey extends string>(definitions: Record<string, AgentToolDefinition>, key: TKey): AgentToolDefinition<TKey> {
    const definition = definitions[key];
    if (!definition) {
        throw new Error(`内置工具定义缺失：${key}`);
    }
    return definition as AgentToolDefinition<TKey>;
}

