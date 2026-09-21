import type {
  ReviewCanvasSettingsContent,
  ReviewCliInstallStatus,
  ReviewDiffrConfig,
  ReviewDiffrConfigActions,
  ReviewKeymapChoice,
  ReviewThemeChoice,
} from "@dev.fast/review-protocol";
import { isStringValue } from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useState } from "react";

import { AgentSetupCard } from "./agent-setup-card";
import {
  type DiffrConfigField,
  diffrConfigDefaultText,
  diffrConfigFields,
  diffrConfigInputValue,
} from "./diffr-config-form";
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

  const [softwareMapEnabled, setSoftwareMapEnabled] = useState(
    settings.softwareMapEnabled,
  );

  const [structuralDiffEnabled, setStructuralDiffEnabled] = useState(
    settings.structuralDiffEnabled,
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
              <label
                className="review-settings-toggle"
                aria-label="Share anonymous usage data"
              >
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
              label="Structural Diffs"
              description="Replace the standard diff view with syntax-aware diffs and linked folds."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Structural Diffs"
                  checked={structuralDiffEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "structural-diff",
                      () => settings.setStructuralDiffEnabled(enabled),
                      setStructuralDiffEnabled,
                    );
                  }}
                />
              </label>
            </Row>
            {structuralDiffEnabled ? (
              <DiffrConfigSection actions={settings.diffrConfig} />
            ) : null}
            <Row
              label="Software Map"
              description="Show the experimental Software Map view in reviews."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Software Map"
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

/**
 * diffr's own settings, one row per key the CLI's schema describes. The
 * same file the diffr TUI edits, so a change here shows up there and back.
 * Reads happen when the section mounts; a missing executable is shown in
 * place, not thrown at the page.
 */
function DiffrConfigSection({
  actions,
}: {
  actions: ReviewDiffrConfigActions;
}) {
  const [config, setConfig] = useState<ReviewDiffrConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setError(null);
    actions.read().then(
      (loaded) => {
        if (!cancelled) setConfig(loaded);
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [actions]);

  const write = async (field: DiffrConfigField, text: string) => {
    setBusy(field.key);
    setError(null);

    try {
      setConfig(
        await actions.set(field.key, diffrConfigInputValue(field, text)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const fields = config ? diffrConfigFields(config.schema, config.values) : [];

  return (
    <div className="review-settings-diffr" aria-label="diffr settings">
      <p className="review-settings-row-description review-settings-diffr-lede">
        These settings belong to diffr and are shared with its terminal UI.
      </p>
      {config === null && error === null ? (
        <p className="review-settings-unavailable">Reading diffr settings…</p>
      ) : null}
      {fields.map((field) => (
        <Row
          key={field.key}
          label={field.group ? `${field.group}: ${field.label}` : field.label}
          description={
            diffrConfigDefaultText(field)
              ? `${field.description} Default: ${diffrConfigDefaultText(field)}.`
              : field.description
          }
        >
          <DiffrConfigControl
            field={field}
            disabled={busy !== null}
            onCommit={(text) => void write(field, text)}
          />
        </Row>
      ))}
      {error ? <p className="review-settings-error">{error}</p> : null}
    </div>
  );
}

function DiffrConfigControl({
  field,
  disabled,
  onCommit,
}: {
  field: DiffrConfigField;
  disabled: boolean;
  onCommit: (text: string) => void;
}) {
  const current =
    field.value === undefined || field.value === null
      ? ""
      : isStringValue(field.value)
        ? field.value
        : JSON.stringify(field.value);

  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  if (field.kind === "boolean") {
    return (
      <label
        className="review-settings-toggle"
        aria-label={
          field.group ? `${field.group}: ${field.label}` : field.label
        }
      >
        <input
          type="checkbox"
          aria-label={
            field.group ? `${field.group}: ${field.label}` : field.label
          }
          checked={field.value === true}
          disabled={disabled}
          onChange={(event) => onCommit(String(event.target.checked))}
        />
      </label>
    );
  }

  if (field.kind === "enum") {
    return (
      <select
        className="review-settings-select"
        aria-label={
          field.group ? `${field.group}: ${field.label}` : field.label
        }
        value={current}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.value)}
      >
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="review-settings-input"
      aria-label={field.group ? `${field.group}: ${field.label}` : field.label}
      type={
        field.secret ? "password" : field.kind === "number" ? "number" : "text"
      }
      autoComplete={field.secret ? "off" : undefined}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== current) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && draft !== current) onCommit(draft);
      }}
    />
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
  // SAFETY: `labels` is declared as Record<T, string>, so its own keys are
  // exactly the T choices this control offers.
  const choices = Object.keys(labels) as T[];

  return (
    <div className="review-segmented" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={choice === value}
          disabled={disabled}
          className={
            choice === value
              ? "review-segment review-segment--active"
              : "review-segment"
          }
          onClick={() => onChange(choice)}
        >
          {labels[choice]}
        </button>
      ))}
    </div>
  );
}
