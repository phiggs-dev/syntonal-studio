/** API payloads describe the application service, not additional YuE2 model parameters. */
export interface Settings {
  upstream_repository: string | null;
  projects_directory: string;
  outputs_directory: string;
  huggingface_cache: string | null;
  model: string;
  vae: string;
  model_revision: string | null;
  vae_revision: string | null;
  offline: boolean;
  sheetsage_python: string | null;
  sheetsage_model: string | null;
  ffmpeg: string;
}
export interface SystemCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}
export interface SystemReport {
  collected_at: string;
  checks: SystemCheck[];
}
export interface Health {
  status: "ok";
  phase: 4;
}

function describeError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("detail" in payload))
    return null;
  const detail: unknown = payload.detail;
  if (typeof detail === "string") return detail;
  if (!Array.isArray(detail)) return null;
  return detail
    .map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return "Invalid request";
      const location =
        "loc" in entry && Array.isArray(entry.loc)
          ? entry.loc.filter((part: unknown) => part !== "body").join(".")
          : "";
      const message =
        "msg" in entry && typeof entry.msg === "string"
          ? entry.msg
          : "Invalid value";
      return location ? `${location}: ${message}` : message;
    })
    .join("; ");
}

export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        "The backend did not respond within two minutes. Check its logs, then retry.",
      );
    }
    throw new Error(
      "Cannot reach the local backend. Check that Syntonal Studio is running, then retry.",
    );
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(
      describeError(payload) ?? `Request failed (${response.status}).`,
    );
  }
  return response.json() as Promise<T>;
}

export const getSettings = () => apiRequest<Settings>("/api/settings");
export const getSystem = () => apiRequest<SystemReport>("/api/system");
export const getHealth = () => apiRequest<Health>("/api/health");
export const saveSettings = (settings: Settings) =>
  apiRequest<Settings>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
