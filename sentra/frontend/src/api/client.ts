import { Entry, AnomalyResult, ExplanationPayload, DailyFeatureAggregation, EntrySubmissionResponse, GraphSnapshotResponse } from './models';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

export class ApiClient {
  static async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`API Error: ${res.statusText}`);
    }
    return res.json();
  }

  static getEntries(userId: string): Promise<Entry[]> {
    return this.fetch<Entry[]>(`/entries?user_id=${encodeURIComponent(userId)}`);
  }

  static createEntry(userId: string, text: string): Promise<EntrySubmissionResponse> {
    return this.fetch<EntrySubmissionResponse>(`/entries?user_id=${encodeURIComponent(userId)}`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  static getTimeline(userId: string): Promise<AnomalyResult[]> {
    return this.fetch<AnomalyResult[]>(`/timeline?user_id=${encodeURIComponent(userId)}`);
  }

  static getExplanation(explanationId: number): Promise<ExplanationPayload> {
    return this.fetch<ExplanationPayload>(`/explanations/${explanationId}`);
  }

  static getFeatures(userId: string): Promise<DailyFeatureAggregation[]> {
    return this.fetch<DailyFeatureAggregation[]>(`/features?user_id=${encodeURIComponent(userId)}`);
  }

  static getAnomaly(userId: string): Promise<AnomalyResult> {
    return this.fetch<AnomalyResult>(`/anomaly?user_id=${encodeURIComponent(userId)}`);
  }

  static getGraphSnapshots(userId: string, limit = 12): Promise<GraphSnapshotResponse[]> {
    return this.fetch<GraphSnapshotResponse[]>(`/graph-snapshots?user_id=${encodeURIComponent(userId)}&limit=${limit}`);
  }
}
