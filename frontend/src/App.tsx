/** Studio navigation preserves creation inputs and audio playback between workspaces. */
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import {
  getHealth,
  getSettings,
  getSystem,
  saveSettings,
  type Settings,
  type SystemReport,
} from "./api";

import { CreateWorkspace, GenerationPlayer } from "./CreateWorkspace";
import { ProjectsWorkspace } from "./ProjectsWorkspace";
import { HistoryWorkspace } from "./HistoryWorkspace";
import { getProjects, type Project, type ReuseDraft } from "./library";
import { useGenerationJobs, type GenerationJob } from "./generation";
import { needsComposition } from "./composition";
const ComposeWorkspace = lazy(() => import("./ComposeWorkspace"));
type Page =
  "Compose" | "Create" | "Projects" | "History" | "System" | "Settings";
type TextSetting = Exclude<keyof Settings, "offline">;
const optionalFields = new Set<TextSetting>([
  "upstream_repository",
  "huggingface_cache",
  "model_revision",
  "vae_revision",
  "sheetsage_python",
  "sheetsage_model",
]);
const groups: {
  title: string;
  description: string;
  fields: [TextSetting, string][];
}[] = [
  {
    title: "Workspace",
    description:
      "Use paths as seen by the backend. In WSL, use /mnt/d/... paths. Leave optional fields blank to use defaults.",
    fields: [
      ["upstream_repository", "YuE repository (optional)"],
      ["projects_directory", "Projects directory"],
      ["outputs_directory", "Outputs directory"],
      ["huggingface_cache", "Hugging Face cache (optional)"],
    ],
  },
  {
    title: "Generation models",
    description:
      "Use repository IDs or local directories. Saving does not download or load model weights. VAE is the audio decoder.",
    fields: [
      ["model", "YuE2 model"],
      ["model_revision", "Model revision (optional)"],
      ["vae", "Audio decoder"],
      ["vae_revision", "Decoder revision (optional)"],
    ],
  },
  {
    title: "External tools",
    description:
      "SheetSage2 transcription will use a separate Python environment in a later phase.",
    fields: [
      ["sheetsage_python", "SheetSage2 Python interpreter (optional)"],
      ["sheetsage_model", "SheetSage2 model (optional)"],
      ["ffmpeg", "FFmpeg executable"],
    ],
  },
];
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error.";

export default function App() {
  const [page, setPage] = useState<Page>("Create");
  const generation = useGenerationJobs();
  const [listeningJob, setListeningJob] = useState<GenerationJob | undefined>();
  const [listeningDecoder, setListeningDecoder] = useState<string | null>(null);
  function listen(job: GenerationJob, decoder?: string | null) {
    setListeningJob(job);
    setListeningDecoder(decoder ?? null);
  }
  const [projects, setProjects] = useState<Project[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [historyProject, setHistoryProject] = useState("");
  const [composeDraft, setComposeDraft] = useState<ReuseDraft | null>(null);
  const [composeOpened, setComposeOpened] = useState(false);
  const [openPlanNonce, setOpenPlanNonce] = useState(0);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReuseDraft | null>(null);
  async function loadProjects() {
    try {
      setProjects((await getProjects()).projects);
      setLibraryError("");
    } catch (error) {
      setLibraryError(message(error));
    }
  }
  function reuseInputs(value: ReuseDraft) {
    if (needsComposition(value.request)) {
      setComposeDraft({ ...value, nonce: Date.now() });
      setComposeOpened(true);
      setPage("Compose");
      return;
    }
    setDraft({ ...value, nonce: Date.now() });
    setPage("Create");
  }
  useEffect(() => {
    void loadProjects();
  }, [libraryRevision]);
  const [connected, setConnected] = useState("Checking backend");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [report, setReport] = useState<SystemReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [systemError, setSystemError] = useState("");

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsError("");
    try {
      setSettings(await getSettings());
      setDirty(false);
    } catch (error) {
      setSettingsError(message(error));
    } finally {
      setSettingsLoading(false);
    }
  }
  async function refresh() {
    setChecking(true);
    setSystemError("");
    try {
      setReport(await getSystem());
    } catch (error) {
      setSystemError(message(error));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void getHealth()
      .then(() => setConnected("Backend connected"))
      .catch(() => setConnected("Backend unavailable"));
    void loadSettings();
    void refresh();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setSettingsError("");
    setSaved("");
    try {
      setSettings(await saveSettings(settings));
      setDirty(false);
      setLibraryRevision((value) => value + 1);
      setSaved("Settings saved. Refresh System to check this configuration.");
    } catch (error) {
      setSettingsError(message(error));
    } finally {
      setSaving(false);
    }
  }
  function edit(key: TextSetting, value: string) {
    if (!settings) return;
    setSettings({
      ...settings,
      [key]: value === "" && optionalFields.has(key) ? null : value,
    });
    setDirty(true);
    setSaved("");
  }
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>
            Syntonal<small>STUDIO</small>
          </span>
        </div>
        <div className="nav-label">YOUR STUDIO</div>
        <nav aria-label="Main navigation">
          {(
            [
              "Create",
              "Compose",
              "Projects",
              "History",
              "System",
              "Settings",
            ] as Page[]
          ).map((item, index) => (
            <button
              key={item}
              className={`nav-item ${page === item ? "active" : ""}`}
              onClick={() => {
                if (item === "Compose") setComposeOpened(true);
                if (item === "History") setHistoryProject("");
                setPage(item);
              }}
              aria-current={page === item ? "page" : undefined}
            >
              <span aria-hidden="true">
                {["◈", "♬", "▣", "♫", "◉", "⚙"][index]}
              </span>
              {item}
              {item === "Settings" && dirty && (
                <span title="Unsaved changes">•</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label future-label">COMING NEXT</div>
        {["Cover"].map((item) => (
          <div className="future-item" key={item}>
            {item}
            <span>Planned</span>
          </div>
        ))}
        <div className="sidebar-footer">
          ● Local workspace
          <p>
            Your models. Your files.
            <br />
            Your creative space.
          </p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            Workspace <span className="muted">/ {page}</span>
          </span>
          <span className="connection">{connected}</span>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">LOCAL AI MUSIC WORKSPACE</div>
              <h1>
                {page === "Create"
                  ? "Bring your next idea to life."
                  : page === "Compose"
                    ? "Shape the score behind your song."
                    : page === "Projects"
                      ? "Your music projects"
                      : page === "History"
                        ? "Every take, preserved."
                        : page === "System"
                          ? "System diagnostics"
                          : "Studio settings"}
              </h1>
              <p>
                {page === "Create"
                  ? "Describe your sound, add your lyrics, and create a recording with YuE2."
                  : page === "Compose"
                    ? "Plan, edit and preserve symbolic compositions before rendering audio."
                    : page === "Projects"
                      ? "Organize recordings, notes, and related ideas."
                      : page === "History"
                        ? "Find recordings, inspect artifacts, and revisit the inputs behind each take."
                        : page === "System"
                          ? "Inspect the backend environment without loading generation models."
                          : "Configure local paths, model sources, and external tools."}
              </p>
            </div>
            <span className="phase-badge">PHASE 04 · SYMBOLIC COMPOSITION</span>
          </div>
          {libraryError && (
            <p className="notice error" role="alert">
              {libraryError}{" "}
              <button
                className="text-button"
                onClick={() => void loadProjects()}
              >
                Retry project library
              </button>
            </p>
          )}
          <div hidden={page !== "Create"}>
            <CreateWorkspace
              jobs={generation.jobs}
              connection={generation.connection}
              settingsDirty={dirty}
              rememberJob={generation.rememberJob}
              onListen={listen}
              projects={projects}
              draft={draft}
            />
          </div>
          {composeOpened && (
            <div hidden={page !== "Compose"}>
              <Suspense fallback={<p>Loading composition tools…</p>}>
                <ComposeWorkspace
                  projects={projects}
                  jobs={generation.jobs}
                  rememberJob={generation.rememberJob}
                  settingsDirty={dirty}
                  draft={composeDraft}
                  openPlanId={openPlanId}
                  openPlanNonce={openPlanNonce}
                  active={page === "Compose"}
                />
              </Suspense>
            </div>
          )}
          {page === "Projects" && (
            <ProjectsWorkspace
              projects={projects}
              onSaved={() => void loadProjects()}
              onOpen={(id) => {
                setHistoryProject(id);
                setPage("History");
              }}
            />
          )}
          {page === "History" && (
            <HistoryWorkspace
              key={`${libraryRevision}:${historyProject}`}
              projects={projects}
              initialProject={historyProject}
              onListen={listen}
              onReuse={reuseInputs}
              onOpenPlan={(id) => {
                setOpenPlanId(id);
                setOpenPlanNonce((value) => value + 1);
                setComposeOpened(true);
                setPage("Compose");
              }}
              onQueued={generation.rememberJob}
            />
          )}
          {page === "System" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Environment checks</h2>
                  <p>
                    {report
                      ? `Collected ${new Date(report.collected_at).toLocaleString()}`
                      : "Collect a fresh snapshot."}
                  </p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => void refresh()}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Refresh checks"}
                </button>
              </div>
              {systemError && (
                <div role="alert" className="notice error">
                  {systemError}
                  {report && " Previous results remain below."}
                </div>
              )}
              {checking && <p role="status">Checking your environment…</p>}
              <div aria-busy={checking}>
                {report?.checks.map((check) => (
                  <article className="check-row" key={check.id}>
                    <span className={`check-status ${check.status}`}>
                      {check.status}
                    </span>
                    <div>
                      <h3>{check.label}</h3>
                      <p>{check.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
              <p className="footnote">
                Diagnostics describe availability. They do not verify audio
                generation or musical quality.
              </p>
            </section>
          )}
          {page === "Settings" && (
            <form onSubmit={(event) => void submit(event)}>
              {settingsError && (
                <div role="alert" className="notice error">
                  {settingsError}
                </div>
              )}
              {saved && (
                <div role="status" className="notice success">
                  {saved}
                </div>
              )}
              {settingsLoading && <p role="status">Loading settings…</p>}
              {!settings && !settingsLoading && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void loadSettings()}
                >
                  Retry loading settings
                </button>
              )}
              {settings && (
                <fieldset disabled={saving} className="settings-fieldset">
                  {groups.map((group) => (
                    <section className="panel settings-panel" key={group.title}>
                      <h2>{group.title}</h2>
                      <p>{group.description}</p>
                      <div className="fields-grid">
                        {group.fields.map(([key, label]) => (
                          <div className="field" key={key}>
                            <label htmlFor={key}>{label}</label>
                            <input
                              id={key}
                              value={settings[key] ?? ""}
                              onChange={(event) =>
                                edit(key, event.target.value)
                              }
                              required={!optionalFields.has(key)}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                        ))}
                      </div>
                      {group.title === "Generation models" && (
                        <label className="toggle-row">
                          <input
                            type="checkbox"
                            checked={settings.offline}
                            onChange={(event) => {
                              setSettings({
                                ...settings,
                                offline: event.target.checked,
                              });
                              setDirty(true);
                              setSaved("");
                            }}
                          />
                          <span>
                            <strong>Offline mode</strong>
                            <span>
                              Use local model files and cache only. Missing
                              models must be downloaded separately.
                            </span>
                          </span>
                        </label>
                      )}
                    </section>
                  ))}
                  <div className="save-bar">
                    <span>
                      {dirty
                        ? "You have unsaved changes."
                        : "Configuration is up to date."}
                    </span>
                    <button
                      className="primary-button"
                      disabled={!dirty || saving}
                    >
                      {saving ? "Saving…" : "Save settings"}
                    </button>
                  </div>
                </fieldset>
              )}
            </form>
          )}
        </main>
        <GenerationPlayer job={listeningJob} decoder={listeningDecoder} />
        <footer className="workspace-footer">
          <span>Syntonal Studio / Symbolic composition</span>
          <span>Original audio · Local storage · Sequential generation</span>
        </footer>
      </div>
    </div>
  );
}
