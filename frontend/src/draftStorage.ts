/** Versioned browser-only snapshots. Each mounted workspace writes its own slot, never another tab's. */
import type { EditorMetadata } from "./visualScore";
export type DraftWorkspace = "create" | "compose";
export interface InputDraft {
  title: string; style: string; lyrics: string; mode: "full" | "melody" | "off";
  seed: string; guidance: string; projectId: string; parentId: string | null;
}
export interface CompositionDraft extends InputDraft {
  abc: string; scoreTitle: string; editorMetadata: EditorMetadata | null;
  planId: string | null; scoreId: string | null;
  parentScoreId: string | null; sourceGenerationId: string | null;
}
export interface StoredDraft<T> { key: string; updatedAt: string; data: T }
export interface DraftScan<T> { drafts: StoredDraft<T>[]; unreadable: string[] }
const MAX_SNAPSHOT_LENGTH = 2_000_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum;
const id = (value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{32}$/.test(value));
export function isInputDraft(value: unknown): value is InputDraft {
  return record(value) && text(value.title, 200) && text(value.style, 100_000) && text(value.lyrics, 100_000)
    && ["full", "melody", "off"].includes(String(value.mode)) && text(value.seed, 100) && text(value.guidance, 100)
    && (value.projectId === "" || id(value.projectId) && value.projectId !== null) && id(value.parentId);
}
function isEditorMetadata(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !text(value.lyrics, 100_000) || !Array.isArray(value.phrases) || value.phrases.length > 2000) return false;
  if (value.working_lyrics !== undefined && value.working_lyrics !== null && !text(value.working_lyrics, 100_000)) return false;
  if (value.alignment !== undefined && value.alignment !== null) {
    const alignment = value.alignment;
    if (!record(alignment) || !text(alignment.abc, 100_000) || !text(alignment.lyrics, 100_000) || !Array.isArray(alignment.lines) || alignment.lines.length > 500) return false;
    const positions = new Set<string>();
    for (const line of alignment.lines) {
      if (!record(line) || !text(line.text, 10_000) || !line.text.length || ![line.section, line.line].every(item => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 100_000) || !Array.isArray(line.syllables) || !line.syllables.length || line.syllables.length > 500) return false;
      const position = `${line.section}:${line.line}`;
      if (positions.has(position)) return false;
      positions.add(position);
      if (!line.syllables.every(item => record(item) && text(item.text, 200) && item.text.length > 0 && (item.first_note === null && item.last_note === null || [item.first_note, item.last_note].every(note => Number.isInteger(note) && Number(note) >= 0 && Number(note) <= 100_000) && Number(item.last_note) >= Number(item.first_note)))) return false;
    }
  }
  return value.phrases.every(phrase => record(phrase) && text(phrase.text, 10_000)
    && ["section", "line", "first_bar", "last_bar"].every(key => Number.isInteger(phrase[key]) && Number(phrase[key]) >= (key.endsWith("bar") ? 1 : 0) && Number(phrase[key]) <= 100_000)
    && Number(phrase.last_bar) >= Number(phrase.first_bar));
}
export function isCompositionDraft(value: unknown): value is CompositionDraft {
  return isInputDraft(value) && record(value) && value.mode !== "off" && text(value.abc, 100_000) && text(value.scoreTitle, 200)
    && isEditorMetadata(value.editorMetadata) && [value.planId, value.scoreId, value.parentScoreId, value.sourceGenerationId].every(id);
}
export function inputDraftHasContent(value: InputDraft): boolean {
  return Boolean(value.title || value.style || value.lyrics || value.guidance || value.projectId || value.parentId || value.seed !== "831001" || value.mode !== "full");
}
export function draftPrefix(scope: string, workspace: DraftWorkspace): string {
  return `syntonal-studio:drafts:v1:${encodeURIComponent(scope)}:${workspace}:`;
}
export function readDrafts<T>(storage: Storage, scope: string, workspace: DraftWorkspace, validate: (value: unknown) => value is T): DraftScan<T> {
  const prefix = draftPrefix(scope, workspace);
  const result: DraftScan<T> = { drafts: [], unreadable: [] };
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    try {
      if (!raw || raw.length > MAX_SNAPSHOT_LENGTH) throw Error("Oversized or missing snapshot");
      const envelope: unknown = JSON.parse(raw);
      if (!record(envelope) || envelope.version !== 1 || envelope.scope !== scope || envelope.workspace !== workspace
        || typeof envelope.updatedAt !== "string" || !Number.isFinite(Date.parse(envelope.updatedAt)) || !validate(envelope.data)) throw Error("Unsupported snapshot");
      result.drafts.push({ key, updatedAt: envelope.updatedAt, data: envelope.data });
    } catch { result.unreadable.push(key); }
  }
  result.drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}
export function writeDraft<T>(storage: Storage, scope: string, workspace: DraftWorkspace, owner: string, data: T, updatedAt: string): string {
  const key = draftPrefix(scope, workspace) + owner;
  const serialized = JSON.stringify({ version: 1, scope, workspace, updatedAt, data });
  if (serialized.length > MAX_SNAPSHOT_LENGTH) throw Error("This draft is too large for browser recovery. Save a score version or export your work.");
  storage.setItem(key, serialized);
  return key;
}
