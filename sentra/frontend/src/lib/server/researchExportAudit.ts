/**
 * Who may read research output (#167).
 *
 * The two disclosure routes — `api/research/export` and
 * `api/research/identity-map` — each read their own allowlist inline. This
 * module exists for the third reader, the operations dashboard, which discloses
 * no data but does show a per-participant compliance table and so belongs
 * behind the same list rather than a wider one.
 *
 * Worth folding the routes' two private copies into this one at some point.
 * Not in this change: it would edit code that #172 just shipped, for tidiness
 * rather than for a defect.
 */

/**
 * Who may pull the pseudonymised dataset and the retained text.
 *
 * An explicit list of user ids, not a role. A role is something an account can
 * end up holding; this is something a person had to be named in. An unset or
 * empty variable means nobody, so a deployment that has not decided who may
 * export cannot export.
 */
export function authorizedExporters(): Set<string> {
  return parseIdList(process.env.RESEARCH_EXPORT_USER_IDS);
}

function parseIdList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
