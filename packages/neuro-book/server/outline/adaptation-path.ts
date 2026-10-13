/** 规划只拥有已有素材下的方案计划文件，不能借事务接口扩展为通用 lorebook 写入。 */
export function isAdaptationRecordPath(relativePath: string): boolean {
    const parts = relativePath.split("/");
    if (parts.length !== 6 || parts[0] !== "lorebook" || !safeSegment(parts[2]!)
        || !/^[a-z0-9_-]+$/iu.test(parts[4]!) || !/^ol-[a-z0-9-]+\.md$/iu.test(parts[5]!)) return false;
    return parts[1] === "character"
        ? parts[3] === "改编中的新经历" || parts[3] === "改编中的新人际关系"
        : (parts[1] === "item" || parts[1] === "location") && parts[3] === "改编中的内容";
}

export function isMaterialBasePath(relativePath: string): boolean {
    const parts = relativePath.split("/");
    return parts.length === 4 && parts[0] === "lorebook"
        && ["character", "item", "location"].includes(parts[1]!) && safeSegment(parts[2]!) && parts[3] === "index.md";
}

function safeSegment(value: string): boolean {
    return value !== "" && value !== "." && value !== ".." && !/[\\<>:"|?*\x00-\x1f]/u.test(value)
        && !/[. ]$/u.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}
