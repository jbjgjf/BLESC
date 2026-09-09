/**
 * The PII review queue (#167).
 *
 * `GET` lists what is waiting. `POST` records a decision. Neither one returns
 * journal text, a matched substring, or an offset into one — a queue row
 * carries counts per detector kind and nothing else, so the reviewer's screen
 * says "this entry contains something that looks like a phone number" without
 * showing it to them or to anyone else who can reach the surface.
 *
 * Reading the text is a separate, separately-audited act: it goes through
 * `GET /api/research/export?kind=entries&include_raw_text=1`, which is behind
 * the export allowlist and writes a `research_exports` row.
 *
 * The scanner cannot anonymise, and a `cleared` row does not say the text is
 * safe. `piiScan.ts` documents what it cannot see — names without honorifics,
 * places, and identification by combination, which is the category that
 * matters most and the one no pattern will ever catch.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import { PII_SCANNER_LIMITS } from "@/lib/piiScan";

export const runtime = "nodejs";

const RESOLUTIONS = new Set(["cleared", "redaction_requested", "redacted"]);

export async function GET(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100) || 100, 500);

  const result = await operator.service
    .from("research_pii_reviews")
    .select(
      "id, entry_id, findings_json, scanner_version, status, reviewed_at, note, created_at, " +
        "pilot_enrollments:participant_id(research_code)",
    )
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (result.error) {
    // The join above is best-effort: a participant with no enrollment has no
    // research code, and the queue is still readable without one.
    const plain = await operator.service
      .from("research_pii_reviews")
      .select("id, entry_id, findings_json, scanner_version, status, reviewed_at, note, created_at")
      .eq("status", status)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (plain.error) return jsonError(plain.error.message, 502);
    return NextResponse.json({
      rows: plain.data ?? [],
      count: (plain.data ?? []).length,
      scanner_limits: PII_SCANNER_LIMITS,
    });
  }

  return NextResponse.json({
    rows: result.data ?? [],
    count: (result.data ?? []).length,
    // Returned with every listing, so the limits travel with the queue rather
    // than living in a document the reviewer read once.
    scanner_limits: PII_SCANNER_LIMITS,
  });
}

type ResolveBody = { review_id?: string; status?: string; note?: string };

export async function POST(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const body = (await request.json().catch(() => ({}))) as ResolveBody;
  const reviewId = typeof body.review_id === "string" ? body.review_id : "";
  const status = typeof body.status === "string" && RESOLUTIONS.has(body.status) ? body.status : null;

  if (!reviewId || !status) {
    return jsonError("review_id and a valid status are required.", 422);
  }

  const result = await operator.service
    .from("research_pii_reviews")
    .update({
      status,
      reviewed_by: operator.userId,
      reviewed_at: new Date().toISOString(),
      // The reviewer's own note about their decision. Truncated rather than
      // rejected: a long note is a reviewer being thorough, not an error, and
      // losing the decision because the note ran long would be the wrong trade.
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    })
    .eq("id", reviewId)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle();

  if (result.error) return jsonError(result.error.message, 502);
  if (!result.data) {
    // Already resolved, or no such row. One answer for both: an operator
    // mistyping an id learns nothing about which.
    return jsonError("This review cannot be resolved.", 409, { code: "not_resolvable" });
  }

  return NextResponse.json({ status: "resolved", review: result.data });
}
