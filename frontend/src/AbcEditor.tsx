/** ABC highlighting is visual only; upstream validation is performed separately. */
import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
const abcLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/%.*/)) return "comment";
    if (stream.sol() && stream.match(/[A-Za-z]:/)) return "keyword";
    if (stream.match(/"[^"\n]*"/)) return "string";
    if (stream.match(/\[[A-Za-z]:[^\]]*\]/)) return "keyword";
    if (stream.match(/[\^_=]*[A-Ga-gzZ][,']*[0-9/]*-?/)) return "variableName";
    if (stream.match(/[|:\[\]]+/)) return "punctuation";
    stream.next();
    return null;
  },
});
export function AbcEditor({
  value,
  onChange,
  onUndo,
  onRedo,
}: {
  value: string;
  onChange: (value: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const externalUpdate = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      doc: value,
      extensions: [
        basicSetup,
        abcLanguage,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "ABC score editor",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !externalUpdate.current)
            change.current(update.state.doc.toString());
        }),
      ],
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      externalUpdate.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
      externalUpdate.current = false;
    }
  }, [value]);
  return (
    <>
      <div className="job-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (onUndo) onUndo();
            else if (editor.current) undo(editor.current);
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (onRedo) onRedo();
            else if (editor.current) redo(editor.current);
          }}
        >
          Redo
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (editor.current) openSearchPanel(editor.current);
          }}
        >
          Find / replace
        </button>
      </div>
      <div className="abc-editor" ref={host} />
    </>
  );
}
export function ScorePreview({ abc }: { abc: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void import("abcjs")
        .then((module) => {
          if (!active || !host.current) return;
          try {
            host.current.replaceChildren();
            const tunes = module.renderAbc(host.current, abc, {
              responsive: "resize",
            });
            setError(tunes.length ? "" : "No notation could be displayed.");
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Preview unavailable.",
            );
          }
        })
        .catch(() => {
          if (active) setError("Notation renderer could not load.");
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [abc]);
  return (
    <>
      <p className="field-help">
        Local abcjs notation preview is advisory. It does not establish YuE2
        compatibility or guarantee rendered audio adherence.
      </p>
      {error && <p className="notice warning">{error}</p>}
      <div className="score-preview" ref={host} />
    </>
  );
}
