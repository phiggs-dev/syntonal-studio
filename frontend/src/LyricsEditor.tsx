/** Shared exact-text lyrics editor; history includes typing, imports and section insertion. */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { decodeLyrics, insertLyricSection, lyricHeadingWarnings, lyricSections, lyricSectionTags, MAX_LYRICS_LENGTH } from "./lyricsModel";
interface Props { id: string; value: string; onChange: (value: string) => void; rows?: number; required?: boolean; disabled?: boolean }
interface Snapshot { text: string; start: number; end: number }
export function LyricsEditor({ id, value, onChange, rows = 8, required = false, disabled = false }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const expected = useRef(value);
  const latest = useRef(value); latest.current = value;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const mounted = useRef(true);
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const historyRef = useRef(history); historyRef.current = history;
  const typingAt = useRef(0);
  const selection = useRef({ start: 0, end: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const composing = useRef(false);
  const statusId = useId();
  const sections = useMemo(() => lyricSections(value), [value]);
  const warnings = useMemo(() => lyricHeadingWarnings(value), [value]);
  const locked = disabled || loading;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (expected.current !== value) {
      expected.current = value; typingAt.current = 0;
      setHistory({ past: [], future: [] });
    }
  }, [value]);
  function focus(start: number, end = start, scroll = false) {
    requestAnimationFrame(() => {
      if (!mounted.current || !textarea.current) return;
      textarea.current.focus(); textarea.current.setSelectionRange(start, end);
      selection.current = { start, end };
      if (scroll) {
        // Measure wrapped text with the field's font/width so long lines do not hide the chosen heading.
        const field = textarea.current, style = getComputedStyle(field);
        const mirror = document.createElement("div"), marker = document.createElement("span");
        Object.assign(mirror.style, { position: "fixed", top: "0", left: "0", visibility: "hidden", pointerEvents: "none",
          boxSizing: "border-box", width: `${field.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word",
          font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, padding: style.padding });
        mirror.textContent = latest.current.slice(0, start); marker.textContent = "|";
        mirror.append(marker); document.body.append(mirror);
        field.scrollTop = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top - parseFloat(style.paddingTop);
        mirror.remove();
      }
    });
  }
  function commit(text: string, cursor: number, typing = false) {
    if (text === value) return;
    const now = Date.now();
    if (!typing || now - typingAt.current > 600 || historyRef.current.future.length) {
      const snapshot = { text: value, ...selection.current };
      setHistory(previous => ({ past: [...previous.past.slice(-49), snapshot], future: [] }));
    }
    typingAt.current = typing ? now : 0;
    expected.current = text; onChange(text); setError("");
    if (!typing) focus(cursor);
  }
  function travel(direction: "undo" | "redo") {
    const current = historyRef.current;
    const snapshot = direction === "undo" ? current.past.at(-1) : current.future[0];
    if (!snapshot) return;
    const present = { text: value, start: textarea.current?.selectionStart ?? 0, end: textarea.current?.selectionEnd ?? 0 };
    setHistory(direction === "undo"
      ? { past: current.past.slice(0, -1), future: [present, ...current.future] }
      : { past: [...current.past.slice(-49), present], future: current.future.slice(1) });
    typingAt.current = 0; expected.current = snapshot.text; onChange(snapshot.text);
    focus(snapshot.start, snapshot.end); setNotice(direction === "undo" ? "Undid lyrics edit." : "Redid lyrics edit.");
  }
  async function importFile(file: File) {
    if (!/\.txt$/i.test(file.name)) { setError("Choose a UTF-8 .txt lyrics file."); return; }
    setLoading(true); setError("");
    try {
      if (file.size > 400_000) throw Error("Lyrics file is too large. Maximum 100,000 characters.");
      const text = decodeLyrics(await file.arrayBuffer());
      if (!mounted.current) return;
      if (disabledRef.current || latest.current !== value) throw Error("Lyrics changed while reading the file. Import again when the current action finishes.");
      if (latest.current && !window.confirm("Replace the current lyrics with this file? Undo will restore the previous lyrics.")) return;
      commit(text, 0); setNotice("Imported lyrics. Review section headings before generating.");
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Unable to read lyrics file.");
    } finally { if (mounted.current) setLoading(false); }
  }
  return <div className="field lyrics-editor">
    <label htmlFor={id}>Lyrics</label>
    <div className="lyrics-toolbar">
      <select aria-label="Insert lyric section" value="" disabled={locked} onChange={event => {
        if (!event.target.value) return;
        try {
          const next = insertLyricSection(value, textarea.current?.selectionStart ?? value.length, event.target.value);
          commit(next.value, next.cursor); setNotice(`Inserted [${event.target.value}].`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to insert section."); }
      }}>
        <option value="">Insert section…</option>
        {lyricSectionTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
      </select>
      <select aria-label="Go to lyric section" value="" disabled={locked || !sections.length} onChange={event => {
        const section = sections.find(item => String(item.start) === event.target.value);
        if (!section || !textarea.current) return;
        typingAt.current = 0; focus(section.start, section.end, true);
        setNotice(`Selected ${section.label}.`);
      }}>
        <option value="">Go to section…</option>
        {sections.map(section => <option key={section.start} value={section.start}>{section.label}</option>)}
      </select>
      <button type="button" className="text-button" disabled={locked || !history.past.length} onClick={() => travel("undo")}>Undo lyrics</button>
      <button type="button" className="text-button" disabled={locked || !history.future.length} onClick={() => travel("redo")}>Redo</button>
      <button type="button" className="text-button" disabled={locked} onClick={() => fileInput.current?.click()}>{loading ? "Reading…" : "Import .txt"}</button>
      <input ref={fileInput} className="screen-reader-only" tabIndex={-1} type="file" accept=".txt,text/plain" aria-label="Import lyrics file" disabled={locked} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) void importFile(file);
      }} />
      <button type="button" className="text-button" disabled={locked || !value} onClick={() => {
        const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "lyrics.txt"; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Export .txt</button>
    </div>
    <textarea ref={textarea} id={id} className="lyrics-input" value={value} rows={rows} required={required} disabled={locked}
      maxLength={MAX_LYRICS_LENGTH} spellCheck={false} aria-describedby={statusId}
      placeholder={"[Verse]\nYour story starts here…\n\n[Chorus]\nThe words you want to sing"}
      onSelect={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault(); event.stopPropagation();
          travel(key === "y" || event.shiftKey ? "redo" : "undo");
        }
      }}
      onChange={event => commit(event.target.value, event.target.selectionStart, true)} />
    <p className="field-help" id={statusId}>{value.length.toLocaleString()} characters · {value ? value.split("\n").length : 0} lines · {sections.length} {sections.length === 1 ? "section" : "sections"} · Formatting preserved.</p>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {warnings.length > 0 && <details className="lyrics-guidance"><summary>Section heading guidance ({warnings.length})</summary><ul>{warnings.slice(0, 20).map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
  </div>;
}
