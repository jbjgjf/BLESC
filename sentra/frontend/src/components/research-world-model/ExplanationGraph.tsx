"use client";

/**
 * The candidate explanation graph (C4), rendered as what it is.
 *
 * Three renderings here are deliberate rather than stylistic. Every axis shows
 * its `semantic_status`, so a synthetic coordinate cannot be read as a measured
 * construct. Every edge shows its `evidence_scope`, so a model's guess is not
 * displayed next to a citation as though they were the same kind of thing. And
 * the number beside an edge is labelled as a bootstrap selection frequency,
 * because rendering it as a bare percentage invites reading it as a probability
 * that the relationship is real.
 *
 * The residual and the fidelity numbers sit next to the graph rather than
 * behind a toggle: an explanation shown without how much it fails to explain is
 * the presentation this project is trying not to ship.
 */

import { t } from "@/lib/i18n";
import {
  type ExplanationBundle,
  formatNumber,
  sortedEdges,
} from "@/lib/research/worldModel";

const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" };
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
};
const numeric: React.CSSProperties = { ...td, fontVariantNumeric: "tabular-nums" };
const chip: React.CSSProperties = {
  display: "inline-block",
  padding: "0.1rem 0.4rem",
  borderRadius: "999px",
  fontSize: "0.75rem",
  backgroundColor: "hsla(38, 90%, 50%, 0.12)",
  border: "1px solid hsla(38, 90%, 40%, 0.35)",
};

export function ExplanationGraph({ bundle }: { bundle: ExplanationBundle | null }) {
  if (!bundle || bundle.status !== "ok") {
    return <p>{t.worldModel.explanationUnavailable}</p>;
  }

  const edges = sortedEdges(bundle.candidate_edges);

  return (
    <div>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{t.worldModel.edgeColumns.source}</th>
            <th style={th}>{t.worldModel.edgeColumns.target}</th>
            <th style={th}>{t.worldModel.edgeColumns.order}</th>
            <th style={th}>{t.worldModel.edgeColumns.lag}</th>
            <th style={th}>{t.worldModel.edgeColumns.coefficient}</th>
            <th style={th}>{t.worldModel.edgeColumns.frequency}</th>
            <th style={th}>{t.worldModel.edgeColumns.scope}</th>
          </tr>
        </thead>
        <tbody>
          {edges.length === 0 ? (
            <tr>
              <td style={td} colSpan={7}>
                {t.worldModel.noEdges}
              </td>
            </tr>
          ) : (
            edges.map((edge, index) => (
              <tr key={`${edge.source_ids.join("+")}-${edge.target_id}-${index}`}>
                <td style={td}>{edge.source_ids.join(" × ")}</td>
                <td style={td}>{edge.target_id}</td>
                <td style={td}>{t.worldModel.edgeOrder(edge.interaction_order)}</td>
                <td style={numeric}>{t.worldModel.edgeLag(edge.lag_days)}</td>
                <td style={numeric}>{formatNumber(edge.coefficient, 3)}</td>
                <td style={numeric}>
                  {edge.uncertainty === null
                    ? t.worldModel.unmeasured
                    : `${formatNumber(edge.uncertainty, 2)} · ${
                        t.worldModel.uncertaintyMethod[edge.uncertainty_method ?? ""] ??
                        (edge.uncertainty_method ?? "")
                      }`}
                </td>
                <td style={td}>
                  {t.worldModel.evidenceScope[edge.evidence_scope] ?? edge.evidence_scope}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.35rem" }}>
        {t.worldModel.semanticStatusNote}
      </h3>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
        {bundle.states.map((node) => (
          <li key={node.id} style={{ marginBottom: "0.2rem" }}>
            {node.label}{" "}
            <span style={chip}>
              {t.worldModel.semanticStatus[node.semantic_status] ?? node.semantic_status}
            </span>{" "}
            {node.value === null ? "" : formatNumber(node.value, 3)}
          </li>
        ))}
      </ul>

      <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.35rem" }}>{t.worldModel.residual}</h3>
      <table style={table}>
        <tbody>
          {Object.entries(bundle.residual_summary).map(([key, value]) => (
            <tr key={key}>
              <th style={{ ...th, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{key}</th>
              <td style={numeric}>
                {value === null ? t.worldModel.unmeasured : formatNumber(value, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
        {t.worldModel.residualNote}
      </p>

      <h3 style={{ fontSize: "0.95rem", margin: "1.25rem 0 0.35rem" }}>{t.worldModel.fidelity}</h3>
      <table style={table}>
        <tbody>
          {Object.entries(bundle.fidelity_metrics).map(([key, value]) => (
            <tr key={key}>
              <th style={{ ...th, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{key}</th>
              <td style={numeric}>
                {value === null ? t.worldModel.unmeasured : formatNumber(value, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
        {t.worldModel.fidelityNote}
      </p>

      <ul style={{ marginTop: "1rem", paddingLeft: "1.1rem", fontSize: "0.85rem", opacity: 0.85 }}>
        {bundle.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </div>
  );
}

export function CapabilityList({ flags }: { flags: Record<string, boolean> }) {
  return (
    <div>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
        {Object.entries(flags).map(([name, enabled]) => (
          <li key={name} style={{ opacity: enabled ? 1 : 0.6 }}>
            {t.worldModel.capability[name] ?? name}:{" "}
            <strong>{enabled ? t.worldModel.capabilityOn : t.worldModel.capabilityOff}</strong>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: "0.5rem" }}>
        {t.worldModel.capabilityOffNote}
      </p>
    </div>
  );
}
