"use client";

/**
 * The numeric half of the research screen: metrics, scenarios, checks, usage.
 *
 * The rule these components exist to enforce is that a metric with no value
 * renders as "算出せず" plus its reason, never as a number and never as a blank
 * cell. A blank reads as a rendering bug and a zero reads as a measured
 * failure; both are wrong about the same thing, which is that the evaluator
 * declined to score it.
 */

import { t } from "@/lib/i18n";
import {
  type EvaluationReport,
  type LeakageCheck,
  type Metric,
  formatNumber,
  metricInterval,
  metricValue,
} from "@/lib/research/worldModel";

const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid var(--limestone)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid rgba(0,0,0,0.06)",
  verticalAlign: "top",
};
const numeric: React.CSSProperties = { ...td, fontVariantNumeric: "tabular-nums" };

function MetricRow({ metric }: { metric: Metric }) {
  const value = metricValue(metric);
  const interval = metricInterval(metric);
  const formatted = formatNumber(value);

  return (
    <tr>
      <td style={td}>{metric.name}</td>
      <td style={td}>{metric.model_id ?? t.worldModel.unmeasured}</td>
      <td style={numeric}>{formatted ?? t.worldModel.notComputed}</td>
      <td style={numeric}>
        {interval
          ? `${formatNumber(interval[0], 3)} – ${formatNumber(interval[1], 3)}`
          : t.worldModel.noInterval}
      </td>
      <td style={numeric}>{metric.n_participants ?? t.worldModel.unmeasured}</td>
      <td style={numeric}>{metric.n_predictions ?? t.worldModel.unmeasured}</td>
      <td style={td}>{metric.status === "ok" ? "" : (metric.reason_ja ?? metric.status)}</td>
    </tr>
  );
}

export function OverallMetrics({ report }: { report: EvaluationReport }) {
  return (
    <div>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{t.worldModel.table.metric}</th>
            <th style={th}>{t.worldModel.table.model}</th>
            <th style={th}>{t.worldModel.table.value}</th>
            <th style={th}>{t.worldModel.table.interval}</th>
            <th style={th}>{t.worldModel.table.participants}</th>
            <th style={th}>{t.worldModel.table.predictions}</th>
            <th style={th}>{t.worldModel.table.reason}</th>
          </tr>
        </thead>
        <tbody>
          {report.metrics.map((metric, index) => (
            <MetricRow key={`${metric.name}-${metric.model_id}-${index}`} metric={metric} />
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
        {t.worldModel.intervalNote}
      </p>
    </div>
  );
}

export function ScenarioMetrics({ report }: { report: EvaluationReport }) {
  return (
    <div>
      {Object.entries(report.metrics_by_scenario).map(([scenario, metrics]) => (
        <section key={scenario} style={{ marginBottom: "1.25rem" }}>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>{scenario}</h3>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>{t.worldModel.table.metric}</th>
                <th style={th}>{t.worldModel.table.model}</th>
                <th style={th}>{t.worldModel.table.value}</th>
                <th style={th}>{t.worldModel.table.status}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric, index) => (
                <tr key={`${scenario}-${metric.name}-${index}`}>
                  <td style={td}>{metric.name}</td>
                  <td style={td}>{metric.model_id ?? t.worldModel.unmeasured}</td>
                  <td style={numeric}>
                    {formatNumber(metricValue(metric)) ?? t.worldModel.notComputed}
                  </td>
                  <td style={td}>{metric.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export function UnsupportedMetrics({ report }: { report: EvaluationReport }) {
  if (report.unsupported_metrics.length === 0) return null;
  return (
    <table style={table}>
      <thead>
        <tr>
          <th style={th}>{t.worldModel.table.metric}</th>
          <th style={th}>{t.worldModel.table.model}</th>
          <th style={th}>{t.worldModel.table.reason}</th>
        </tr>
      </thead>
      <tbody>
        {report.unsupported_metrics.map((metric, index) => (
          <tr key={`${metric.name}-${index}`}>
            <td style={td}>{metric.name}</td>
            <td style={td}>{metric.model_id ?? t.worldModel.unmeasured}</td>
            <td style={td}>{metric.reason_ja ?? metric.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LeakageChecks({ checks }: { checks: LeakageCheck[] }) {
  return (
    <table style={table}>
      <thead>
        <tr>
          <th style={th}>{t.worldModel.table.status}</th>
          <th style={th}>{t.worldModel.table.check}</th>
          <th style={th}>{t.worldModel.table.detail}</th>
        </tr>
      </thead>
      <tbody>
        {checks.map((check) => (
          <tr key={check.name}>
            <td
              style={{
                ...td,
                color: check.passed ? "hsl(160, 60%, 30%)" : "hsl(0, 70%, 42%)",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {check.passed ? t.worldModel.checkPassed : t.worldModel.checkFailed}
            </td>
            <td style={td}>{check.name}</td>
            <td style={td}>{check.detail_ja}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MeasuredUsageTable({ report }: { report: EvaluationReport }) {
  const usage = report.measured_usage;
  const rows: [string, string][] = [
    [
      t.worldModel.usageLabels.provider_calls,
      usage.provider_calls === null ? t.worldModel.unmeasured : String(usage.provider_calls),
    ],
    [
      t.worldModel.usageLabels.input_tokens,
      usage.input_tokens === null ? t.worldModel.unmeasured : String(usage.input_tokens),
    ],
    [
      t.worldModel.usageLabels.output_tokens,
      usage.output_tokens === null ? t.worldModel.unmeasured : String(usage.output_tokens),
    ],
    [
      t.worldModel.usageLabels.elapsed_seconds,
      usage.elapsed_seconds === null
        ? t.worldModel.unmeasured
        : (formatNumber(usage.elapsed_seconds, 1) ?? t.worldModel.unmeasured),
    ],
    [t.worldModel.usageLabels.compute_environment, usage.compute_environment],
  ];

  return (
    <div>
      <table style={table}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th style={{ ...th, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{label}</th>
              <td style={numeric}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
        {t.worldModel.usageZeroNote}
      </p>
    </div>
  );
}
