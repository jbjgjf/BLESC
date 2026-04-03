import { Entry, AnomalyResult, ExplanationPayload, DailyFeatureAggregation, EntrySubmissionResponse } from './models';

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
    return this.fetch<Entry[]>(`/entries?user_id=${userId}`);
  }

  static createEntry(userId: string, text: string): Promise<EntrySubmissionResponse> {
    return this.fetch<EntrySubmissionResponse>(`/entries?user_id=${userId}&text=${encodeURIComponent(text)}`, {
      method: 'POST',
    });
  }

  static getTimeline(userId: string): Promise<AnomalyResult[]> {
    return this.fetch<AnomalyResult[]>(`/timeline?user_id=${userId}`);
  }

  static getExplanation(explanationId: number): Promise<ExplanationPayload> {
    return this.fetch<ExplanationPayload>(`/explanations/${explanationId}`);
  }

  static getFeatures(userId: string): Promise<DailyFeatureAggregation[]> {
    return this.fetch<DailyFeatureAggregation[]>(`/features?user_id=${userId}`);
  }

  static getAnomaly(userId: string): Promise<AnomalyResult> {
    return this.fetch<AnomalyResult>(`/anomaly?user_id=${userId}`);
  }
}
