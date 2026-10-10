/** Debounced browser snapshots flush on hiding/closing; recovery always requires an explicit action. */
import { useEffect, useRef, useState } from "react";
import { draftPrefix, readDrafts, writeDraft, type DraftScan, type DraftWorkspace, type StoredDraft } from "./draftStorage";
export function useRecoverableDraft<T>({ scope, workspace, data, validate, hasContent, onRestore }: {
  scope: string | null; workspace: DraftWorkspace; data: T; validate: (value: unknown) => value is T;
  hasContent: (value: T) => boolean; onRestore: (value: T) => Promise<void>;
}) {
  const [owner] = useState(() => crypto.randomUUID());
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [scan, setScan] = useState<DraftScan<T>>({ drafts: [], unreadable: [] });
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [restoring, setRestoring] = useState(false);
  const latest = useRef({ data, hasContent, onRestore }); latest.current = { data, hasContent, onRestore };
  const lastSaved = useRef(JSON.stringify(data));
  const serialized = JSON.stringify(data);
  function rescan(): DraftScan<T> {
    if (!scope) return { drafts: [], unreadable: [] };
    const result = readDrafts(window.localStorage, scope, workspace, validate);
    result.drafts = result.drafts.filter(item => item.key !== draftPrefix(scope, workspace) + owner);
    setScan(result); return result;
  }
  function flush(notify = true, force = false): boolean {
    if (!scope || !readyRef.current) return false;
    const current = latest.current;
    const payload = JSON.stringify(current.data);
    if (payload === lastSaved.current && !force) return true;
    try {
      if (!validate(current.data)) throw Error("Some draft fields exceed recovery limits. Save or export your work before closing.");
      const time = new Date().toISOString();
      if (current.hasContent(current.data)) writeDraft(window.localStorage, scope, workspace, owner, current.data, time);
      else window.localStorage.removeItem(draftPrefix(scope, workspace) + owner);
      lastSaved.current = payload;
      if (notify) { setSavedAt(current.hasContent(current.data) ? time : ""); setError(""); }
      return true;
    } catch (reason) {
      if (notify) setError(reason instanceof Error ? `Draft recovery could not save: ${reason.message}` : "Draft recovery could not save. Export your work before closing.");
      return false;
    }
  }
  useEffect(() => {
    if (!scope) return;
    lastSaved.current = JSON.stringify(latest.current.data);
    try {
      const result = rescan();
      readyRef.current = result.drafts.length === 0; setReady(readyRef.current);
    } catch { readyRef.current = true; setReady(true); setError("Browser storage is unavailable. Draft recovery cannot save; export your work before closing."); }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(draftPrefix(scope, workspace))) return;
      try { rescan(); } catch { setError("Cannot read browser drafts. Export your current work before closing."); }
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    const pagehide = () => { flush(false); };
    const leaving = (event: BeforeUnloadEvent) => {
      if (readyRef.current && JSON.stringify(latest.current.data) !== lastSaved.current && !flush()) event.preventDefault();
    };
    window.addEventListener("storage", storageChanged);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("beforeunload", leaving);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flush(false);
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("beforeunload", leaving);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [scope, workspace, owner, validate]);
  useEffect(() => {
    if (!ready || !scope || serialized === lastSaved.current) return;
    const timer = window.setTimeout(() => flush(), 450);
    return () => clearTimeout(timer);
  }, [serialized, ready, scope]);
  return { ready, savedAt, error, restoring, scan,
    pending: !ready && Boolean(scope),
    saving: ready && serialized !== lastSaved.current,
    async restore(candidate: StoredDraft<T>) {
      if (restoring) return;
      if (ready && latest.current.hasContent(latest.current.data) && !window.confirm("Replace the current draft with this recovery snapshot? Save or export current work first.")) return;
      if (readyRef.current && !flush()) return;
      setRestoring(true);
      try {
        // Re-read the selected immutable slot: another tab may have updated or discarded it.
        const stored = scope ? readDrafts(window.localStorage, scope, workspace, validate).drafts.find(item => item.key === candidate.key) : undefined;
        if (!stored) throw Error("That draft is no longer available. Choose another recovery snapshot.");
        await latest.current.onRestore(stored.data);
        lastSaved.current = JSON.stringify(stored.data); setSavedAt(stored.updatedAt); setError("");
        readyRef.current = true; setReady(true);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to restore draft."); }
      finally { setRestoring(false); }
    },
    startFresh() { readyRef.current = true; setReady(true); },
    discard(keys: string[]) {
      if (!scope || !window.confirm("Discard these browser recovery snapshots? Saved projects, scores and recordings will not be changed.")) return;
      try {
        for (const key of keys) if (key.startsWith(draftPrefix(scope, workspace)) && key !== draftPrefix(scope, workspace) + owner) window.localStorage.removeItem(key);
        const result = rescan();
        if (!result.drafts.length) { readyRef.current = true; setReady(true); }
      } catch { setError("Unable to discard browser drafts."); }
    },
    retry() { flush(true, true); },
  };
}
