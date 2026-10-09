/** Web Audio oscillators preview validated notes locally without remote soundfonts. */
import { useEffect, useRef, useState } from "react";
import type { ValidationReport } from "./composition";
import { previewNotes } from "./scoreTiming";
export function ScorePlayback({
  validation,
  active,
  abc,
}: {
  validation: ValidationReport | null;
  active: boolean;
  abc: string;
}) {
  const context = useRef<AudioContext | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  function stop() {
    window.clearTimeout(timer.current);
    const current = context.current;
    context.current = null;
    if (current) void current.close();
    setPlaying(false);
  }
  useEffect(() => {
    stop();
    setError("");
    return stop;
  }, [abc, active]);
  async function play() {
    stop();
    setError("");
    try {
      if (!validation?.valid) throw Error("Validate the current draft first.");
      const notes = previewNotes(validation.report);
      const audio = new AudioContext();
      context.current = audio;
      await audio.resume();
      if (context.current !== audio) return;
      const start = audio.currentTime + 0.08;
      let end = 0;
      for (const note of notes) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
        gain.gain.setValueAtTime(0, start + note.onset);
        gain.gain.linearRampToValueAtTime(
          0.035,
          start + note.onset + Math.min(0.01, note.duration / 4),
        );
        gain.gain.setValueAtTime(
          0.035,
          start + note.onset + note.duration * 0.8,
        );
        gain.gain.linearRampToValueAtTime(
          0,
          start + note.onset + note.duration,
        );
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(start + note.onset);
        oscillator.stop(start + note.onset + note.duration);
        end = Math.max(end, note.onset + note.duration);
      }
      setPlaying(true);
      timer.current = window.setTimeout(stop, (end + 0.2) * 1000);
    } catch (error) {
      stop();
      setError(
        error instanceof Error
          ? error.message
          : "Synthetic preview unavailable.",
      );
    }
  }
  return (
    <>
      <div className="job-actions">
        <button
          className="secondary-button"
          disabled={!validation?.valid || !active}
          onClick={() => void play()}
        >
          Play synthetic score
        </button>
        <button className="text-button" disabled={!playing} onClick={stop}>
          Stop score preview
        </button>
      </div>
      <p className="field-help">
        Simple local tones preview validated note timing and pitch. This is not
        YuE2 audio or a vocal performance.
      </p>
      {error && <p className="notice warning">{error}</p>}
    </>
  );
}

