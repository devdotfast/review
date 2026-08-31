import type {
  ReviewCanvasSettingsContent,
  ReviewCliInstallStatus,
  ReviewKeymapChoice,
  ReviewThemeChoice,
} from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useState } from "react";

import { AgentSetupCard } from "./agent-setup-card";
import { TraceCaptureSection } from "./trace-capture-section";

const THEME_LABELS: Record<ReviewThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const KEYMAP_LABELS: Record<ReviewKeymapChoice, string> = {
  none: "Default",
  vim: "Vim",
  emacs: "Emacs",
};

/**
 * The retention window, keyed by its wire value. `<select>` carries strings
 * only, so "never" stands for the `null` that turns reaping off.
 */
const RETENTION_LABELS = {
  "7": "After 7 days",
  "30": "After 30 days",
  "90": "After 90 days",
  never: "Never",
} as const;

type RetentionChoice = keyof typeof RETENTION_LABELS;

function retentionChoice(days: number | null): RetentionChoice {
  if (days === null) return "never";
  const choice = String(days);
  return choice in RETENTION_LABELS ? (choice as RetentionChoice) : "30";
}

function retentionDays(choice: RetentionChoice): number | null {
  return choice === "never" ? null : Number(choice);
}

/**
 * The Settings page. It opens from the application menu (Preferences →
 * Settings...), the command palette, or ⌘,. Reuses the Home page shell so the
 * surfaces read as one app.
 *
 * The workbench owns every value here. Each setter resolves with the value that
 * landed, so a row shows the real state rather than an optimistic one.
 */
export function SettingsPage({
  settings,
}: {
  settings: ReviewCanvasSettingsContent;
}) {
  const [telemetryEnabled, setTelemetryEnabled] = useState(
    settings.telemetryEnabled,
  );
  const [theme, setTheme] = useState(settings.theme);
  const [keymap, setKeymap] = useState(settings.keymap);
  const [retention, setRetention] = useState(
    retentionChoice(settings.dismissedRetentionDays),
  );
  const [softwareMapEnabled, setSoftwareMapEnabled] = useState(
    settings.softwareMapEnabled,
  );
  const [installStatus, setInstallStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(settings.install?.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => setInstallStatus(settings.install?.status),
    [settings.install?.status],
  );

  const install =
    settings.install && installStatus
      ? { ...settings.install, status: installStatus }
      : settings.install;

  const run = async <T,>(
    key: string,
    action: () => Promise<T>,
    adopt: (value: T) => void,
  ) => {
    setBusy(key);
    setError(null);
    try {
      adopt(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content review-settings-page">
          <div className="review-home-page-header">
            <h1>Settings</h1>
          </div>
          <p className="review-settings-lede">
            Settings apply to Review Desktop on this machine.
          </p>

          {install ? (
            <Section label="Agents">
              <AgentSetupCard
                install={install}
                onStatusChange={setInstallStatus}
              />
            </Section>
          ) : null}

          <Section label="Privacy">
            <Row
              label="Share anonymous usage data"
              description="Counts and timings only. Never code, file paths, or repository names."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  checked={telemetryEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "telemetry",
                      () => settings.setTelemetryEnabled(enabled),
                      setTelemetryEnabled,
                    );
                  }}
                />
                <span>{telemetryEnabled ? "On" : "Off"}</span>
              </label>
            </Row>
          </Section>

          <Section label="Editor">
            <Row label="Theme" description="How Review Desktop looks.">
              <Choice
                label="Theme"
                value={theme}
                labels={THEME_LABELS}
                disabled={busy !== null}
                onChange={(choice) =>
                  void run("theme", () => settings.setTheme(choice), setTheme)
                }
              />
            </Row>
            <Row
              label="Keymap"
              description="Vim and Emacs keys come from a bundled extension. A change needs a reload."
            >
              <Choice
                label="Keymap"
                value={keymap}
                labels={KEYMAP_LABELS}
                disabled={busy !== null}
                onChange={(choice) => {
                  void run(
                    "keymap",
                    () => settings.setKeymap(choice),
                    setKeymap,
                  );
                }}
              />
            </Row>
          </Section>

          <Section label="Reviews">
            <Row
              label="Delete dismissed reviews"
              description="A dismissed review waits this long, then it is deleted. Deletion is permanent. Undo a dismissal from Home before the wait ends."
            >
              <Choice
                label="Delete dismissed reviews"
                value={retention}
                labels={RETENTION_LABELS}
                disabled={busy !== null}
                onChange={(choice) => {
                  void run(
                    "retention",
                    async () =>
                      retentionChoice(
                        await settings.setDismissedRetentionDays(
                          retentionDays(choice),
                        ),
                      ),
                    setRetention,
                  );
                }}
              />
            </Row>
          </Section>

          <Section label="Tools">
            <Row
              label="Extensions"
              description="Install or turn on language extensions."
            >
              <button
                type="button"
                className="review-settings-button"
                onClick={settings.manageExtensions}
              >
                Manage…
              </button>
            </Row>
          </Section>

          <Section label="Experimental Features">
            <Row
              label="Software Map"
              description="Show the experimental Software Map view in reviews."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  checked={softwareMapEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "software-map",
                      () => settings.setSoftwareMapEnabled(enabled),
                      setSoftwareMapEnabled,
                    );
                  }}
                />
                <span>{softwareMapEnabled ? "On" : "Off"}</span>
              </label>
            </Row>
            {install ? (
              <TraceCaptureSection
                install={install}
                onStatusChange={setInstallStatus}
              />
            ) : null}
          </Section>

          {error ? <p className="review-settings-error">{error}</p> : null}
        </div>
      </div>
    </main>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="review-settings-section" aria-label={label}>
      <h2 className="review-settings-section-label">{label}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="review-settings-row">
      <div className="review-settings-row-text">
        <span className="review-settings-row-label">{label}</span>
        <span className="review-settings-row-description">{description}</span>
      </div>
      <div className="review-settings-row-control">{children}</div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  labels,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, string>;
  disabled: boolean;
  onChange: (choice: T) => void;
}) {
  return (
    <select
      className="review-settings-select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {(Object.keys(labels) as T[]).map((choice) => (
        <option key={choice} value={choice}>
          {labels[choice]}
        </option>
      ))}
    </select>
  );
}
