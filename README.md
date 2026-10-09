# Syntonal Studio

Syntonal Studio is a local composition workspace built with React/TypeScript and FastAPI around the separately maintained YuE2 runtime.

**Phase 4: symbolic composition.** Create songs, generate plans without audio, edit and version ABC, preview notation, validate symbolic changes, reuse exact saved plans, and render saved scores. Projects and History preserve recordings, lineage, artifacts and reproduction details. Settings and diagnostics remain local; inference uses a sequential queue and unchanged upstream defaults. Covers, broader editing workflows, comparison and batch tools remain later phases.


## Setup

Use Linux or Ubuntu under WSL2, Python 3.12 with venv support, and Node.js 22.12+ with npm. The official inference baseline is a BF16-capable NVIDIA GPU with 24 GB VRAM. Lower-memory hardware can be tried but is not silently given different precision, shorter context or fewer synthesis steps.

For guided installation, double-click `install-win.bat` on Windows, or run `bash install-linux.sh` on Linux. The installer can reuse or download YuE2, accept existing model/VAE folders, select a model cache location, and optionally download model files. Missing Python and Node.js are installed under ignored `.runtime/tools/` without replacing system versions. Windows uses WSL2; installing WSL or system packages requires confirmation. See [installation options](installation.md) for first-time WSL setup, authentication, unattended options, and verification limits.

For manual installation, from the Studio directory in Linux/WSL:

```bash
bash scripts/setup.sh
bash scripts/setup-inference.sh /path/to/YuE
bash launch-linux.sh
```

The foundation setup creates Studio's `.venv`, installs application/test dependencies and builds the frontend. The separate inference setup reads exact dependency requirements from upstream and installs them into **Studio's environment only**. It does not build or edit upstream, install SheetSage2, or download weights. CUDA/PyTorch dependencies can require several GB of disk space. An explicit source argument installs dependencies but does not silently change saved application settings.

Open [Syntonal Studio](http://127.0.0.1:8675). In Settings, configure the upstream repository using its backend-visible Linux/WSL path, such as `/path/to/YuE`. A Windows `D:\...` path is not interchangeable. Save, then refresh System diagnostics. If already configured, the inference setup script can be run without a path argument.

On Windows, after completing the WSL setup above, double-click `launch-win.bat` in the Studio root. It runs the existing server launcher in your default WSL distribution. To select a different distribution, run `launch-win.bat Ubuntu` (substitute its installed name). Keep the window open, visit [Syntonal Studio](http://127.0.0.1:8675), and press Ctrl+C to stop. Startup failures remain visible in the window.

For development, use `bash scripts/dev.sh`, with the UI on [port 5173](http://127.0.0.1:5173) and the API on port 8675. Both scripts bind loopback. Stop with Ctrl+C. No public tunnel or cloud infrastructure is required.

## Create a song

1. Confirm model/VAE sources in Settings. Defaults are `m-a-p/YuE2-3B` and the listening decoder `m-a-p/YuE2-Vae`. Use explicit revisions or local directories when reproducibility matters.
2. Open Create. Enter style and sectioned lyrics. The optional title is application metadata; it is not sent as a YuE2 conditioning field.
3. Choose Full (default), Melody or Off. Full/melody generate symbolic plans; Off omits the plan. Use Compose for raw ABC editing and score-conditioned generation.
4. Keep or randomize the seed. Advanced CFG can be left blank to use the native default: 1.0 for Full/Melody, 1.01 for Off. Higher CFG is not inherently better.
5. Generate. Jobs run one at a time; navigation and settings reads stay responsive. Settings changes are refused while jobs are queued/running to keep their configuration stable.
6. Inspect the completed job and any truncation warning, then play or download the original recording. Native output is 48 kHz stereo FLAC. A completed or playable file does not establish musical quality.

Lyrics and style are preserved without automatic rewriting. Seeds are decimal strings at the browser/API boundary so values through `9223372036854775807` are not rounded; the adapter sends a native Python integer to YuE2.

Cancellation removes queued jobs or asks active inference to stop at supported checkpoints. VAE decode has no mid-stage cancellation hook; a request arriving too late can finish with a retained recording. Cancellation is not resumable. Failure details and logs remain available; retry by submitting a new job.

## Storage, settings and offline use

Settings default to `data/settings.json`; `SYNTONAL_STUDIO_SETTINGS` selects another file. The legacy `YUE2_STUDIO_SETTINGS` variable remains supported when the new variable is unset; `SYNTONAL_STUDIO_SETTINGS` takes precedence when both are set. See [settings.example.json](config/settings.example.json). No credentials belong in settings/manifests; use authentication environment variables instead. Relative paths use the backend's working directory (launch scripts use the Studio root).


Each job reserves a fresh `outputs_directory/<job-id>/`. Application receipts/logs, request/settings snapshots and runtime provenance are separate from native files in `artifacts/`, including audio, ABC when present, exact plan/semantic tokens, latents, request, configuration, timings and hashes. No prior recording is overwritten. On restart, saved jobs under the currently configured output root are rediscovered; interrupted jobs are marked failed rather than resumed. Project membership, favorites and display annotations live in the separate projects library; source recordings remain unchanged.

Offline mode forwards `local_files_only=True`. Online generation can download missing official model files through the upstream loader. Diagnostics never download weights. A cached directory alone is not proof of complete or valid weights; generation's native integrity checks remain authoritative. Do not select upstream itself as a writable output/cache directory.

For a completed native artifact folder, structural verification is available:

```bash
.venv/bin/python scripts/verify-generation.py data/outputs/JOB_ID/artifacts
```

This checks hashes, audio format/finite nonzero samples, semantic tokens, latent shape and truncation. It does not claim to evaluate the music or lyric realization.

## Projects and history

Open Projects to create or rename a project and edit its notes/tags. In Create, select a project for the next generation. Existing recordings appear in History as unassigned; assign them without moving or changing their output files.

History supports text, project/unassigned, mode, seed, model, decoder, favorite and date filters. Select a recording to play it, edit its display name/notes, inspect original artifacts or download a reproduction manifest. Integrity checks compare actual bytes with the native saved hashes; missing files and mismatches are reported. Text previews are bounded; downloads retain the complete original file.

**Reuse inputs** previews the saved request for explicit loading into Create, or Compose for symbolic/score-conditioned work. Submitting creates a new generation, using current settings and preserving parent lineage. It does not load or reuse the exact symbolic plan.

**Re-run saved configuration** queues a new recording using saved inference settings. It requires a clean matching recorded upstream commit, pinned available model/decoder snapshots and compatible native effective configuration/weight identity. Missing or incompatible provenance is an error, not permission to substitute current defaults. Older Phase 2 recordings without startup provenance remain playable, downloadable and reusable through the explicit current-settings route. Hardware/runtime differences can affect reproduction; bit-identical output is not guaranteed.

The configured projects directory holds a versioned catalog with project metadata and references to known generation folders. Output-directory changes retain already cataloged history; changing the projects directory selects another library. Project export contains metadata/references, not a portable bundle of audio/model weights. No deletion or source-artifact editing is introduced in this phase.
## Compose a score

1. Open Compose, enter style and lyrics, select Full or Melody, and choose **Generate plan only**. The completed job retains a native symbolic plan without generating audio.
2. Load that plan, or choose a plan from an existing recording. Inspect the raw ABC and notation preview. The editor supports line numbers, syntax highlighting, undo/redo and search. Import/export preserves score text.
3. **Validate draft** uses upstream's bounded Vocal/Ins ABC helper. The optional synthetic preview plays local tones from its validated note events; it is not a YuE2 recording. The abcjs visual preview is advisory and may interpret notation differently.
4. Edit the score or explicitly remove chords. Compare against the loaded baseline to check selected voices' pitch, onset, duration and meter, with optional tempo changes. This does not establish unchanged harmony, lyrics, sections or generated audio.
5. **Save new version** always writes another immutable score, retaining its source links. Unsupported drafts can be saved; rendering a saved score requires supported validation. Choose **Render saved score** to use its exact text with the current style, lyrics, seed, mode and configured models.
6. To keep a native plan unchanged, use **Render original plan exactly** instead. This preserves its original request and token identity, ignoring editor changes. Current model/decoder settings are used, and identical audio is not guaranteed. The new recording has its own Studio job ID and output directory.

Score versions live under `projects_directory/scores/<version-id>/`; native plan bundles remain in their generation artifacts. Drafts survive workspace navigation but must be saved or exported before closing/reloading the browser. Playback and rendering are separate actions. No original recording or serialized plan is overwritten.


## Future workspaces

- Projects/history: implemented in Phase 3.
- Plan-only workflow, ABC editor, exact plan reuse and score conditioning: implemented in Phase 4.
- Audio covers through a separate SheetSage2 environment: Phase 5.
- Editing, comparisons, optional LLM assistance and advanced tools: later phases.

SheetSage2 requires its own Python 3.10/3.11 environment and conflicting dependency pins, plus FFmpeg 6.1 shared libraries. Never install those pins into the YuE2 environment. YuE2 has no native reference-audio, negative-prompt, BPM, singer-identity or interval-inpainting request parameter.


## Verification and troubleshooting

```bash
.venv/bin/python -m pytest
node --test frontend/tests/*.test.mjs
npm --prefix frontend run build
```

Normal tests use mocked inference and require no model downloads. API docs: [local OpenAPI UI](http://127.0.0.1:8675/docs). Core routes are health/settings/system and `/api/jobs`, per-job status/cancel/audio/log, plus `/api/jobs/events` for live updates.

Setup does not initialize Git or commit changes.

## Licenses

Syntonal Studio is licensed under the [Apache License, Version 2.0](LICENSE).

Upstream code and model weights have separate licenses. Consult [upstream code license](https://github.com/multimodal-art-projection/YuE/blob/ef1936f2ee39fe8de486a0f47a481c95f8d4da87/LICENSE) and [inspected model-weight terms](https://github.com/multimodal-art-projection/YuE/blob/ef1936f2ee39fe8de486a0f47a481c95f8d4da87/MODEL_LICENSE). These do not automatically apply to external SheetSage/MERT models. Studio bundles no weights. Third-party dependencies and separately downloaded runtimes/models retain their own licenses.
