/**
 * Recording that someone accepted the terms or the privacy policy.
 *
 * `GET`  what this account has already accepted, and what is currently in force.
 * `POST` record an acceptance of the version this build is showing.
 *
 * The version is **not taken from the request**. A client that could name the
 * version it accepted could claim agreement to a document it never displayed,
 * which is the whole failure this record exists to rule out. The server stamps
 * what `legalEnactment.ts` says this build is serving.
 *
 * Writes go through the caller's own RLS-scoped client, so a row can only ever
 * be written for the account that is signed in — there is no service-role path
 * here, and no parameter naming a user.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import {
  currentLegalVersion,
  legalEffectiveDate,
  legalEnacted,
} from "@/lib/legalEnactment";

export const runtime = "nodejs";

const DOCUMENTS = new Set(["terms", "privacy"]);

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const result = await auth.client
    .from("legal_acceptances")
    .select("document_id, document_version, effective_date, accepted_at")
    .order("accepted_at", { ascending: false });
  if (result.error) return jsonError(result.error.message, 502);

  return NextResponse.json({
    enacted: legalEnacted(),
    current_version: currentLegalVersion(),
    effective_date: legalEffectiveDate(),
    acceptances: result.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => ({}))) as { document_id?: unknown };
  const documentId = typeof body.document_id === "string" ? body.document_id : "";
  if (!DOCUMENTS.has(documentId)) {
    return jsonError("document_id must be 'terms' or 'privacy'.", 422);
  }

  // Refused while the documents are drafts.
  //
  // A draft can be read and a reading can be recorded, but "accepted" is a word
  // about something in force. Writing an acceptance row against a document that
  // has no effective date produces a record that looks like agreement to terms
  // nobody has enacted — which is the artefact `/legal` currently avoids by
  // saying, correctly, that reading it is not agreement.
  if (!legalEnacted()) {
    return jsonError(
      "この書類はまだ施行されていないため、同意を記録できません。",
      409,
      { code: "not_enacted" },
    );
  }

  const inserted = await auth.client
    .from("legal_acceptances")
    .insert({
      user_id: auth.user.id,
      document_id: documentId,
      document_version: currentLegalVersion(),
      effective_date: legalEffectiveDate(),
    })
    .select("document_id, document_version, effective_date, accepted_at")
    .maybeSingle();

  // A second acceptance of the same version is not a new fact. The unique index
  // says so; this turns the resulting conflict into the ordinary answer rather
  // than an error the screen has to explain.
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      return NextResponse.json({ status: "already_accepted", document_id: documentId });
    }
    return jsonError(inserted.error.message, 502);
  }

  return NextResponse.json({ status: "recorded", acceptance: inserted.data });
}
