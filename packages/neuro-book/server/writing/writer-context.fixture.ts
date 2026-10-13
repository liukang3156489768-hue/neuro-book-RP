import type {OutlineId} from "nbook/server/outline/format";
import type {WriterChapterContext, WriterOutlineEntry} from "nbook/server/outline/writer-context";
import {allEntryReferences} from "nbook/server/outline/format";

export {detailBody, type FixtureScene} from "nbook/server/outline/detail.fixture";

export function outlineEntry(input: Readonly<{
    entryId: OutlineId;
    kind?: WriterOutlineEntry["kind"];
    title?: string;
    body: string;
    writingGuidance?: string;
    targetWords?: number;
}>): WriterOutlineEntry {
    const kind = input.kind ?? "detail";
    return {entryId: input.entryId, kind, title: input.title ?? input.entryId, body: input.body,
        path: `outline/entries/${input.entryId}.md`, version: 1, contentHash: `hash-${input.entryId}`, materialRefs: [],
        references: allEntryReferences({kind, body: input.body}),
        ...(input.writingGuidance === undefined ? {} : {writingGuidance: input.writingGuidance}),
        ...(input.targetWords === undefined ? {} : {targetWords: input.targetWords})};
}

export function chapterContext(input: Readonly<{
    chapter?: WriterOutlineEntry;
    details: readonly WriterOutlineEntry[];
    foreshadowing?: WriterChapterContext["foreshadowing"];
    warnings?: WriterChapterContext["warnings"];
}>): WriterChapterContext {
    const chapter = input.chapter ?? outlineEntry({entryId: "ol-chapter", kind: "chapter", title: "第一章", body: "章节大纲"});
    return {planId: "plan-main", revision: 3,
        basis: {chapterVersion: chapter.version, chapterContentHash: chapter.contentHash,
            details: input.details.map(({entryId, version, contentHash}) => ({entryId, version, contentHash}))},
        volume: null, chapter, details: input.details, foreshadowing: input.foreshadowing ?? [], warnings: input.warnings ?? []};
}
