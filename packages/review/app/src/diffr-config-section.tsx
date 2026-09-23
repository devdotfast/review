import {
  type JsonValue,
  type ReviewDiffrConfig,
  type ReviewDiffrConfigActions,
  type ReviewDiffrSummarizerInput,
  isJsonObject,
} from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";

const displaySettings = [
  ["context.enabled", "Collapse unchanged lines"],
  ["test-bodies.enabled", "Collapse test bodies"],
  ["deleted-bodies.enabled", "Collapse deleted function bodies"],
  ["removed-runs.enabled", "Collapse long removed stretches"],
  ["group.enabled", "Group adjacent folds"],
  ["hide-files.enabled", "Hide files by tag"],
  ["hide-files.deleted", "Hide deleted files"],
] as const;

function setting(
  config: ReviewDiffrConfig,
  key: string,
): JsonValue | undefined {
  let value: JsonValue | undefined = config.values;

  for (const part of `plugins.bundled.${key}`.split("."))
    value = isJsonObject(value) ? value[part] : undefined;

  return value;
}

function summaryDraft(config: ReviewDiffrConfig): ReviewDiffrSummarizerInput {
  return {
    enabled: setting(config, "summarize.enabled") === true,
    model: String(setting(config, "summarize.model") ?? ""),
    tests: setting(config, "summarize.tests") === true,
    apiKey: "",
  };
}

export function DiffrConfigSection({
  actions,
  reloadWindow,
}: {
  actions: ReviewDiffrConfigActions;
  reloadWindow(): Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const [config, setConfig] = useState<ReviewDiffrConfig>();
  const [draft, setDraft] = useState<ReviewDiffrSummarizerInput>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<string>();
  const [changed, setChanged] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    actions.read().then(
      (result) => {
        if (cancelled) return;
        setConfig(result);
        setDraft(summaryDraft(result));
      },
      () => {
        if (!cancelled)
          setError(
            "Could not read diffr settings. Reopen Settings to try again.",
          );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [actions, opened]);

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);

    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update diffr settings.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function saved(result: ReviewDiffrConfig) {
    setConfig(result);

    if (result.changed) setChanged(true);
    setError(result.error);
  }

  const dirty =
    config &&
    draft &&
    JSON.stringify(draft) !== JSON.stringify(summaryDraft(config));

  const unavailable =
    !config || setting(config, "summarize.enabled") === undefined;

  const summaryValid = !!draft?.model.trim();
  const hiddenTags = config ? setting(config, "hide-files.tags") : undefined;

  return (
    <div className="review-settings-diffr">
      <details>
        <summary onClick={() => setOpened(true)}>
          Diff display and AI summaries
        </summary>
        {opened && (
          <>
            <p className="review-settings-row-description">
              Shared with the diffr CLI. Applies to all repositories.
            </p>
            {!config && !error && <p role="status">Reading diffr settings…</p>}
            {config && (
              <>
                <h3>Display</h3>
                {displaySettings.map(([key, label]) => (
                  <div key={key}>
                    <SettingRow label={label}>
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={setting(config, key) === true}
                        disabled={busy || setting(config, key) === undefined}
                        onChange={(event) => {
                          const value = event.target.checked;
                          void run(async () =>
                            saved(
                              await actions.set(
                                `plugins.bundled.${key}`,
                                value,
                              ),
                            ),
                          );
                        }}
                      />
                    </SettingRow>
                    {setting(config, key) === undefined && (
                      <p className="review-settings-unavailable">
                        Not available in this configuration.
                      </p>
                    )}
                    {key === "context.enabled" && (
                      <SettingRow label="Context lines">
                        <ContextLines
                          value={setting(config, "context.lines")}
                          disabled={busy || setting(config, key) !== true}
                          commit={(value) =>
                            void run(async () =>
                              saved(
                                await actions.set(
                                  "plugins.bundled.context.lines",
                                  value,
                                ),
                              ),
                            )
                          }
                        />
                      </SettingRow>
                    )}
                    {key === "hide-files.enabled" &&
                      Array.isArray(hiddenTags) && (
                        <p className="review-settings-row-description">
                          Tags: {hiddenTags.join(", ")}
                        </p>
                      )}
                  </div>
                ))}
                <h3>AI summaries</h3>
                <p className="review-settings-row-description">
                  Sends source-file contents to Gemini to summarize large new
                  functions and tests.
                </p>
                {unavailable && (
                  <p className="review-settings-unavailable">
                    The summarizer is not available in this configuration.
                  </p>
                )}
                {draft && (
                  <fieldset
                    disabled={busy || unavailable}
                    className="review-settings-summary-fields"
                  >
                    <SettingRow label="Enable summaries">
                      <input
                        aria-label="Enable summaries"
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          setDraft({ ...draft, enabled: event.target.checked })
                        }
                      />
                    </SettingRow>
                    <SettingRow label="API key">
                      <input
                        className="review-settings-input"
                        aria-label="API key"
                        type="password"
                        autoComplete="off"
                        placeholder="Enter replacement key"
                        value={draft.apiKey}
                        onChange={(event) =>
                          setDraft({ ...draft, apiKey: event.target.value })
                        }
                      />
                    </SettingRow>
                    <p className="review-settings-row-description">
                      {config.credentialSource === "config"
                        ? "Saved key"
                        : config.credentialSource === "environment"
                          ? "Environment key available"
                          : "Not configured"}
                      . Replacement keys are stored in diffr’s config. Leave
                      blank to keep the current key.
                    </p>
                    <SettingRow label="Model">
                      <input
                        className="review-settings-input"
                        aria-label="Model"
                        value={draft.model}
                        onChange={(event) =>
                          setDraft({ ...draft, model: event.target.value })
                        }
                      />
                    </SettingRow>
                    <SettingRow label="Include tests">
                      <input
                        type="checkbox"
                        aria-label="Include tests"
                        checked={draft.tests}
                        onChange={(event) =>
                          setDraft({ ...draft, tests: event.target.checked })
                        }
                      />
                    </SettingRow>
                    <div className="review-settings-summary-actions">
                      <button
                        type="button"
                        className="review-settings-button"
                        disabled={!summaryValid}
                        onClick={() =>
                          void run(async () => {
                            setSummary(undefined);
                            setSummary(await actions.testSummarizer(draft));
                          })
                        }
                      >
                        Test setup
                      </button>
                      <button
                        type="button"
                        className="review-settings-button"
                        disabled={!summaryValid || !dirty}
                        onClick={() =>
                          void run(async () => {
                            const result = await actions.saveSummarizer(draft);
                            saved(result);

                            if (!result.error || result.changed)
                              setDraft(summaryDraft(result));
                          })
                        }
                      >
                        Save summaries
                      </button>
                    </div>
                    <p className="review-settings-row-description">
                      Test setup sends synthetic code without saving your
                      settings.
                    </p>
                  </fieldset>
                )}
                {summary && (
                  <pre
                    className="review-settings-summary-result"
                    aria-label="Sample summary"
                  >
                    {summary}
                  </pre>
                )}
              </>
            )}
          </>
        )}
      </details>
      {busy && <p role="status">Working…</p>}
      {error && (
        <p role="alert" className="review-settings-error">
          {error}
        </p>
      )}
      {changed && (
        <p role="status">
          Reload the window to see changes.{" "}
          <button
            className="review-settings-button"
            disabled={busy}
            onClick={() => {
              if (dirty) setConfirmReload(true);
              else void run(reloadWindow);
            }}
          >
            Reload window
          </button>
        </p>
      )}
      {confirmReload && (
        <div role="alertdialog" aria-label="Discard summary changes?">
          <p>Discard unsaved summary settings and reload?</p>
          <button
            className="review-settings-button"
            disabled={busy}
            onClick={() => void run(reloadWindow)}
          >
            Discard and reload
          </button>{" "}
          <button
            className="review-settings-button"
            onClick={() => setConfirmReload(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="review-settings-row">
      <span className="review-settings-row-label">{label}</span>
      {children}
    </div>
  );
}

function ContextLines({
  value,
  disabled,
  commit,
}: {
  value: JsonValue | undefined;
  disabled: boolean;
  commit(value: number): void;
}) {
  const [text, setText] = useState(String(value ?? ""));
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(String(value ?? ""));
  }, [value]);

  function save() {
    if (text === String(value ?? "")) return;
    const number = Number(text);

    if (
      !text.trim() ||
      !Number.isInteger(number) ||
      number < 0 ||
      number > 0xffff_ffff
    ) {
      setError(true);

      return;
    }

    setError(false);
    commit(number);
  }

  return (
    <div>
      <input
        className="review-settings-input"
        aria-label="Context lines"
        type="number"
        min={0}
        max={0xffff_ffff}
        step={1}
        value={text}
        disabled={disabled || value === undefined}
        aria-invalid={error}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      {error && <p role="alert">Enter a nonnegative whole number.</p>}
    </div>
  );
}
