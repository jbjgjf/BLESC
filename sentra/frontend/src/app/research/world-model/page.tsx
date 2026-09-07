"use client";

/**
 * The world-model research screen (#151, #152).
 *
 * It renders a run, and it renders every state a run can be in — including the
 * ones nobody demonstrates: queued, running, failed, and a completed run whose
 * leakage check went red. Those states are the reason the screen exists: a
 * research UI that can only draw a successful run hides the results that should
 * stop a claim.
 *
 * The banner is not decoration. Everything here comes from synthetic data, and
 * a screen full of confident-looking metrics is exactly the artefact that gets
 * screenshotted into a slide without it.
 */

import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import {
  type EvaluationReport,
  type ForecastPreview,
  type ExplanationBundle,
  type RunState,
  failedChecks,
  toRunState,
} from "@/lib/research/worldModel";
import {
  type ClientFailure,
  fetchExplanations,
  fetchReport,
  fetchRunStatus,
  startRun,
} from "@/lib/research/worldModelClient";
import {
  CapabilityList,
  ExplanationGraph,
} from "@/components/research-world-model/ExplanationGraph";
import { ForecastChart } from "@/components/research-world-model/ForecastChart";
import {
  LeakageChecks,
  MeasuredUsageTable,
  OverallMetrics,
  ScenarioMetrics,
  UnsupportedMetrics,
} from "@/components/research-world-model/ReportTables";

const page: React.CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
  padding: "1.5rem 1rem 4rem",
  fontFamily: "var(--font-sans), sans-serif",
};
const panel: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid var(--limestone)",
  borderRadius: "var(--radius)",
  padding: "1rem 1.15rem",
  marginBottom: "1.25rem",
};
const banner: React.CSSProperties = {
  ...panel,
  backgroundColor: "hsla(38, 90%, 50%, 0.10)",
  borderColor: "hsla(38, 90%, 40%, 0.35)",
};
const alarm: React.CSSProperties = {
  ...panel,
  backgroundColor: "hsla(0, 70%, 50%, 0.08)",
  borderColor: "hsla(0, 70%, 45%, 0.35)",
};

function failureMessage(failure: ClientFailure): string {
  switch (failure) {
    case "not_configured":
      return t.worldModel.notConfigured;
    case "forbidden":
      return t.worldModel.unauthorized;
    case "not_found":
      return t.worldModel.notFound;
    case "still_running":
      return t.worldModel.stillRunning;
    default:
      return t.worldModel.loadFailed;
  }
}

export default function WorldModelResearchPage() {
  const [runId, setRunId] = useState("");
  const [state, setState] = useState<RunState>("idle");
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [explanations, setExplanations] = useState<ExplanationBundle[]>([]);
  const [previews, setPreviews] = useState<ForecastPreview[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setBusy(true);
    setNotice(null);

    const status = await fetchRunStatus(id.trim());
    if (!status.ok) {
      setState("unknown");
      setNotice(failureMessage(status.failure));
      setBusy(false);
      return;
    }

    const runState = toRunState(status.value.state);
    setState(runState);

    if (runState !== "succeeded" && runState !== "failed") {
      setReport(null);
      setExplanations([]);
      setPreviews([]);
      setBusy(false);
      return;
    }

    const reportResult = await fetchReport(id.trim());
    if (reportResult.ok) {
      setReport(reportResult.value);
    } else {
      setReport(null);
      setNotice(failureMessage(reportResult.failure));
    }

    const explanationResult = await fetchExplanations(id.trim());
    if (explanationResult.ok) {
      setExplanations(explanationResult.value.explanations ?? []);
      setPreviews(explanationResult.value.forecast_previews ?? []);
    } else {
      setExplanations([]);
      setPreviews([]);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    // A queued or running run finishes on its own; poll gently rather than
    // asking the reader to press a button to find out.
    if (state !== "queued" && state !== "running") return;
    const timer = setTimeout(() => void load(runId), 4000);
    return () => clearTimeout(timer);
  }, [state, runId, load]);

  const begin = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const key = `ui-${Date.now()}`;
    const started = await startRun("synthetic-dev-v0", "research-smoke-v0", key);
    if (!started.ok) {
      setNotice(failureMessage(started.failure));
      setBusy(false);
      return;
    }
    setRunId(started.value.run_id);
    setState(toRunState(started.value.state));
    setBusy(false);
  }, []);

  const red = failedChecks(report);
  const firstExplanation = explanations[0] ?? null;
  const firstPreview = previews[0] ?? null;

  return (
    <main style={page}>
      <h1 style={{ fontSize: "1.4rem", margin: "0 0 0.25rem" }}>{t.worldModel.title}</h1>
      <p style={{ margin: "0 0 1rem", opacity: 0.8 }}>{t.worldModel.subtitle}</p>

      <div style={banner}>{t.worldModel.syntheticOnlyBanner}</div>

      <div style={panel}>
        <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}>
          {t.worldModel.runIdLabel}
        </label>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder={t.worldModel.runIdPlaceholder}
            style={{
              flex: "1 1 260px",
              padding: "0.45rem 0.6rem",
              border: "1px solid var(--limestone)",
              borderRadius: "8px",
              fontFamily: "var(--font-mono, monospace)",
            }}
          />
          <button type="button" onClick={() => void load(runId)} disabled={busy}>
            {t.worldModel.load}
          </button>
          <button type="button" onClick={() => void begin()} disabled={busy}>
            {t.worldModel.start}
          </button>
        </div>
        <p style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          <strong>{t.worldModel.state[state] ?? t.worldModel.state.unknown}</strong>
          {" — "}
          {t.worldModel.stateNote[state] ?? t.worldModel.stateNote.unknown}
        </p>
        {notice ? <p style={{ marginBottom: 0, color: "hsl(0, 70%, 38%)" }}>{notice}</p> : null}
      </div>

      {red.length > 0 ? (
        <div style={alarm}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>{t.worldModel.sections.leakage}</h2>
          <LeakageChecks checks={red} />
        </div>
      ) : null}

      {report ? (
        <>
          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.overall}
            </h2>
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              {t.worldModel.seeds}: {report.seed_list.join(", ")} — {t.worldModel.seedNote}
            </p>
            <OverallMetrics report={report} />
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.byScenario}
            </h2>
            <ScenarioMetrics report={report} />
          </section>

          {report.unsupported_metrics.length > 0 ? (
            <section style={panel}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
                {t.worldModel.sections.unsupported}
              </h2>
              <UnsupportedMetrics report={report} />
            </section>
          ) : null}

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.leakage}
            </h2>
            <LeakageChecks checks={report.leakage_checks} />
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.usage}
            </h2>
            <MeasuredUsageTable report={report} />
            <p style={{ fontSize: "0.85rem", marginBottom: 0 }}>
              {t.worldModel.reproduce}: <code>{report.reproducibility_command}</code>
            </p>
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.limitations}
            </h2>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
              {report.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.artifacts}
            </h2>
            <ul
              style={{
                margin: 0,
                paddingLeft: "1.1rem",
                fontSize: "0.8rem",
                fontFamily: "var(--font-mono, monospace)",
                wordBreak: "break-all",
              }}
            >
              {Object.entries(report.artifact_hashes).map(([key, value]) => (
                <li key={key}>
                  {key}: {value}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {firstPreview ? (
        <section style={panel}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
            {t.worldModel.sections.timeseries}
          </h2>
          <ForecastChart preview={firstPreview} featureIndex={0} />
        </section>
      ) : null}

      {firstExplanation ? (
        <>
          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.capabilities}
            </h2>
            <CapabilityList flags={firstExplanation.capability_flags} />
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
              {t.worldModel.sections.explanation}
            </h2>
            <ExplanationGraph bundle={firstExplanation} />
          </section>
        </>
      ) : null}
    </main>
  );
}
