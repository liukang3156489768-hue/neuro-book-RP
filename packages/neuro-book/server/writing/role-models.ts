import {readConfigEditorSnapshot, saveProjectConfig} from "nbook/server/config/config-service";
import type {ConfigWorkspaceQueryDto, ProjectConfigDto} from "nbook/shared/dto/config.dto";
import type {WritingRole, WritingRoleModelDto, WritingRoleModelsDto, WritingRoleModelSettingsDto} from "nbook/shared/dto/writing.dto";
import {WritingError} from "./prose-binding";
import {WRITING_PROFILES} from "./writing-workflow";

/**
 * 写作三个角色的模型设置，存在本作品的 Project Config（`agent.profiles.<profileKey>.model`）。
 * 写作界面只改这三个 Profile 的 modelKey、reasoningEffort 与 temperature，其他 Profile 与字段原样保留；
 * 为空表示沿用全局设置或模型默认。
 */

const ROLES: readonly {role: WritingRole; label: string}[] = [
    {role: "lead", label: "主创"},
    {role: "assistant", label: "助手"},
    {role: "writer", label: "写手"},
];

const EMPTY: WritingRoleModelSettingsDto = {modelKey: null, reasoningEffort: null, temperature: null};

type ProfileModel = Partial<Record<keyof WritingRoleModelSettingsDto, unknown>> | undefined;

function pick(model: ProfileModel): WritingRoleModelSettingsDto {
    return {
        modelKey: typeof model?.modelKey === "string" ? model.modelKey : null,
        reasoningEffort: typeof model?.reasoningEffort === "string" ? model.reasoningEffort as WritingRoleModelSettingsDto["reasoningEffort"] : null,
        temperature: typeof model?.temperature === "number" ? model.temperature : null,
    };
}

const queryOf = (projectRoot: string): ConfigWorkspaceQueryDto => ({workspaceKind: "novel", projectRoot});

export async function readWritingRoleModels(projectRoot: string): Promise<WritingRoleModelsDto> {
    const snapshot = await readConfigEditorSnapshot(queryOf(projectRoot));
    const projectProfiles = snapshot.project?.agent?.profiles ?? {};
    const effectiveAgent = snapshot.effective.agent as {profiles?: Record<string, {model?: ProfileModel}>} | undefined;
    const roles: WritingRoleModelDto[] = ROLES.map(({role, label}) => {
        const profileKey = WRITING_PROFILES[role];
        return {role, label, profileKey, override: pick(projectProfiles[profileKey]?.model),
            effective: pick(effectiveAgent?.profiles?.[profileKey]?.model)};
    });
    return {
        roles,
        models: snapshot.modelSettings.enabledModels.map(({key, label}) => ({key, label})),
        defaultModelLabel: snapshot.modelSettings.defaultModelLabel,
    };
}

/** Project Config 的 profiles 是整体替换语义，这里先读出现有项再只改目标角色。 */
export async function saveWritingRoleModel(projectRoot: string, role: WritingRole, settings: WritingRoleModelSettingsDto):
    Promise<WritingRoleModelsDto> {
    const snapshot = await readConfigEditorSnapshot(queryOf(projectRoot));
    if (settings.modelKey !== null && !snapshot.modelSettings.enabledModels.some(({key}) => key === settings.modelKey)) {
        throw new WritingError("MODEL_INVALID", `模型未启用：${settings.modelKey}`);
    }
    const profiles: NonNullable<NonNullable<ProjectConfigDto["agent"]>["profiles"]> = {...snapshot.project?.agent?.profiles};
    const profileKey = WRITING_PROFILES[role];
    const current = profiles[profileKey];
    const model = {...current?.model};
    for (const key of Object.keys(EMPTY) as (keyof WritingRoleModelSettingsDto)[]) {
        if (settings[key] === null) delete model[key];
        else Object.assign(model, {[key]: settings[key]});
    }
    profiles[profileKey] = {...current, model};
    await saveProjectConfig({agent: {profiles}}, queryOf(projectRoot));
    return readWritingRoleModels(projectRoot);
}
