/**
 * Which graph-derived themes may reach an educator (#100, #102).
 *
 * The invariant is "an output without an attributable observation path is not
 * shown to an educator". There is no learned model yet, so it is applied here to
 * the deterministic output that does reach educators today:
 * `/educator/student/[participantId]` lists 繰り返し見られる話題, node labels
 * counted across the student's `insights.graph_summary_json.key_nodes`. Until
 * this module, every label was counted whether or not it traced back to
 * anything the student wrote. Three kinds did not:
 *
 * - **The fallback template.** When the extraction model cannot run — a
 *   timeout, an API error, an exhausted budget — `fallbackExtraction`
 *   (`extraction.ts`) stores the same nodes for every submission: いまの気持ち,
 *   日記を書いた, 最初に思い出したこと, そのほかの記述 N, and two signals set by a
 *   keyword match that records nothing about which word matched. They
 *   describe the act of submitting, not what was submitted. Counted, they become
 *   this student's "recurring themes" on every fallback day — and, on a day the
 *   provider is down, every student's.
 * - **The `Observation N` placeholder** that `normalizeExtraction` gives a node
 *   the model returned without a label.
 * - **An insight row that names no entry or no day.** It has no path back to an
 *   observation at all.
 *
 * Template nodes are recognised by id, not label. A model may write いまの気持ち
 * as a genuine label; its id is then derived from the label by
 * `canonicalNodeId` and is never `current_reflection`. The id list is pinned
 * against the real `fallbackExtraction` in `tests/educator-themes.test.mjs`, so a
 * new template id fails a test instead of reaching a screen.
 *
 * Withheld occurrences are returned with a reason rather than dropped, so a
 * caller can say that something was left out.
 */

/** Node ids `fallbackExtraction` emits. Plus `context_signal_<n>`, below. */
export const FALLBACK_TEMPLATE_NODE_IDS: readonly string[] = [
  "current_reflection",
  "written_journal",
  "first_recall",
  "protective_signal",
  "stress_signal",
];

const FALLBACK_CONTEXT_NODE_ID = /^context_signal_\d+$/;

/** `normalizeExtraction`'s label for a node the model sent without one. */
const PLACEHOLDER_LABEL = /^Observation \d+$/;

export type ThemeSourceRow = {
  day: string | null;
  entry_id: string | null;
  graph_summary_json: Record<string, unknown> | null;
};

export type WithheldThemeReason = "no_source_observation" | "fallback_template" | "placeholder_label";

export type WithheldTheme = { label: string; day: string | null; reason: WithheldThemeReason };

export type EducatorThemes = {
  themes: Array<{ label: string; count: number }>;
  withheld: WithheldTheme[];
};

export function isFallbackTemplateNodeId(id: string): boolean {
  return FALLBACK_TEMPLATE_NODE_IDS.includes(id) || FALLBACK_CONTEXT_NODE_ID.test(id);
}

function withheldReason(row: ThemeSourceRow, node: Record<string, unknown>, label: string): WithheldThemeReason | null {
  if (!row.entry_id || !row.day) return "no_source_observation";
  if (typeof node.id === "string" && isFallbackTemplateNodeId(node.id)) return "fallback_template";
  if (PLACEHOLDER_LABEL.test(label)) return "placeholder_label";
  return null;
}

/**
 * The top `limit` themes counted only from attributable occurrences, and every
 * occurrence that was not counted. Ordering is unchanged from before: most
 * frequent first, ties by label.
 */
export function attributableThemes(rows: readonly ThemeSourceRow[], limit = 5): EducatorThemes {
  const counts = new Map<string, number>();
  const withheld: WithheldTheme[] = [];

  for (const row of rows) {
    const keyNodes = row.graph_summary_json?.key_nodes;
    if (!Array.isArray(keyNodes)) continue;
    for (const raw of keyNodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as Record<string, unknown>;
      const label = typeof node.label === "string" ? node.label : null;
      // A node without a label was never a theme; that is not a withholding.
      if (!label) continue;
      const reason = withheldReason(row, node, label);
      if (reason) {
        withheld.push({ label, day: row.day, reason });
        continue;
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  const themes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));

  return { themes, withheld };
}
