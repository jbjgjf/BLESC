/**
 * Browser-side client for the world-model run API.
 *
 * Every call goes through the Next.js route, which holds the research
 * credential; nothing here knows the backend's token. The functions return
 * discriminated results rather than throwing, because the states this screen
 * has to render — not configured, forbidden, not found, still running — are
 * outcomes to display, not exceptions to swallow.
 */

import { supabase } from "@/lib/supabase/client";
import type {
  EvaluationReport,
  ExplanationBundle,
  ForecastPreview,
  RunStatus,
} from "./worldModel";

export type ClientFailure =
  | "not_configured"
  | "forbidden"
  | "not_found"
  | "still_running"
  | "request_failed";

export type ClientResult<T> = { ok: true; value: T } | { ok: false; failure: ClientFailure };

export interface ExplanationsResponse {
  run_id: string;
  status: string;
  reason_ja?: string;
  explanations: ExplanationBundle[];
  forecast_previews: ForecastPreview[];
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function call<T>(
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<ClientResult<T>> {
  const token = await accessToken();
  if (!token) return { ok: false, failure: "forbidden" };

  let response: Response;
  try {
    response = await fetch(`/api/research/world-model?path=${encodeURIComponent(path)}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    return { ok: false, failure: "request_failed" };
  }

  if (response.status === 503) return { ok: false, failure: "not_configured" };
  if (response.status === 401 || response.status === 403) return { ok: false, failure: "forbidden" };
  if (response.status === 404) return { ok: false, failure: "not_found" };
  if (response.status === 409) return { ok: false, failure: "still_running" };
  if (!response.ok) return { ok: false, failure: "request_failed" };

  return { ok: true, value: (await response.json()) as T };
}

export function fetchRunStatus(runId: string): Promise<ClientResult<RunStatus>> {
  return call<RunStatus>(`runs/${runId}`);
}

export function fetchReport(runId: string): Promise<ClientResult<EvaluationReport>> {
  return call<EvaluationReport>(`runs/${runId}/report`);
}

export function fetchExplanations(runId: string): Promise<ClientResult<ExplanationsResponse>> {
  return call<ExplanationsResponse>(`runs/${runId}/explanations`);
}

export function startRun(
  datasetId: string,
  configId: string,
  idempotencyKey: string,
): Promise<ClientResult<{ run_id: string; state: string }>> {
  return call<{ run_id: string; state: string }>("runs", {
    method: "POST",
    body: { dataset_id: datasetId, config_id: configId, idempotency_key: idempotencyKey },
  });
}
