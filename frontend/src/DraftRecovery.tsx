/** Recovery snapshots are browser safety copies, separate from saved score versions. */
import { useState } from "react";
import type { InputDraft, StoredDraft } from "./draftStorage";
interface RecoveryState<T> {
  ready: boolean; savedAt: string; error: string; restoring: boolean; pending: boolean; saving: boolean;
  scan: { drafts: StoredDraft<T>[]; unreadable: string[] };
  restore: (draft: StoredDraft<T>) => Promise<void>; startFresh: () => void; discard: (keys: string[]) => void; retry: () => void;
}
export function DraftRecovery<T extends InputDraft>({ recovery, disabled = false }: { recovery: RecoveryState<T>; disabled?: boolean }) {
  const [selected, setSelected] = useState("");
  const candidate = recovery.scan.drafts.find(item => item.key === selected) ?? recovery.scan.drafts[0];
  const controls = <div className="draft-recovery-actions">
    <select aria-label="Recoverable draft" value={candidate?.key ?? ""} onChange={event => setSelected(event.target.value)} disabled={disabled || recovery.restoring}>
      {recovery.scan.drafts.map(item => <option key={item.key} value={item.key}>{item.data.title || "Untitled draft"} · {new Date(item.updatedAt).toLocaleString()}</option>)}
    </select>
    <button type="button" className="secondary-button" disabled={disabled || recovery.restoring || !candidate} onClick={() => candidate && void recovery.restore(candidate)}>{recovery.restoring ? "Restoring…" : "Restore draft"}</button>
    {recovery.pending && <button type="button" className="text-button" disabled={disabled || recovery.restoring} onClick={recovery.startFresh}>Start fresh</button>}
    <button type="button" className="text-button" disabled={disabled || recovery.restoring || !candidate} onClick={() => candidate && recovery.discard([candidate.key])}>Discard snapshot</button>
  </div>;
  if (recovery.ready && !recovery.error && recovery.scan.drafts.length === 0 && recovery.scan.unreadable.length === 0) return null;
  return <div className="draft-recovery">
    {!recovery.ready && <p className="field-help" role="status">{recovery.pending ? "A recoverable draft is available. Restore it or start fresh." : "Waiting for saved library settings…"}</p>}
    {recovery.pending ? controls : recovery.scan.drafts.length > 0 && <details><summary>Recoverable snapshots ({recovery.scan.drafts.length})</summary>{controls}</details>}
    {recovery.scan.unreadable.length > 0 && <div className="notice warning">{recovery.scan.unreadable.length} unreadable or unsupported recovery snapshots were left unchanged. <button type="button" className="text-button" disabled={disabled || recovery.restoring} onClick={() => recovery.discard(recovery.scan.unreadable)}>Discard unreadable snapshots</button></div>}
    {recovery.error && <div className="notice warning" role="alert">{recovery.error} <button type="button" className="text-button" disabled={disabled || recovery.restoring || !recovery.ready} onClick={recovery.retry}>Retry saving</button></div>}
  </div>;
}
