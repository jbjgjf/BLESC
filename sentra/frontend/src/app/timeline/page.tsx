"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ApiClient } from "@/api/client";
import type { AnomalyResult } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";

/** 2.0 を超えた日は、教員が内容を確認する目安になる。 */
const REVIEW_THRESHOLD = 2.0;

export default function TimelinePage() {
  const { userId } = useAuth();
  const [data, setData] = useState<AnomalyResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setData(await ApiClient.getTimeline(userId));
    } catch (err) {
      setData([]);
      setError(err instanceof Error ? err.message : "タイムラインの読み込みに失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const latest = data.at(-1);
  const highSignalDays = useMemo(
    () => data.filter((day) => day.anomaly_score >= REVIEW_THRESHOLD).length,
    [data],
  );
  const needsReview = Boolean(latest && latest.anomaly_score >= REVIEW_THRESHOLD);

  if (isLoading) {
    return (
      <div className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </div>
    );
  }

  return (
    <div className="bl-wrap bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">変化のタイムライン</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          その人自身のふだんの状態と比べて、どれくらい変化があったかを日ごとに表しています。
        </p>
      </header>

      {error && (
        <div className="bl-notice bl-notice--watch" role="alert">
          <Icon name="warning" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {data.length === 0 ? (
        <div className="bl-card bl-empty">
          <Icon name="timeline" size={40} />
          <p className="bl-body">
            グラフを作るにはまだ記録が足りません。日記を続けると表示されます。
          </p>
        </div>
      ) : (
        <>
          <section className="bl-grid bl-grid--3">
            <div className="bl-card">
              <span className={`bl-chip ${needsReview ? "bl-chip--watch" : "bl-chip--calm"}`}>
                <Icon name={needsReview ? "warning" : "check_circle"} size={15} fill />
                {needsReview ? "確認をおすすめします" : "ふだんの範囲です"}
              </span>
              <p className="bl-meta" style={{ marginTop: 10 }}>
                直近の値{" "}
                {Number.isFinite(latest?.anomaly_score) ? latest!.anomaly_score.toFixed(2) : "—"}
              </p>
            </div>

            <div className="bl-card">
              <span className="bl-num">
                {highSignalDays}
                <span style={{ fontSize: "0.9rem", fontWeight: 600, marginLeft: 3 }}>日</span>
              </span>
              <p className="bl-meta">目安の {REVIEW_THRESHOLD.toFixed(1)} を超えた日</p>
            </div>

            <Link href="/insights" className="bl-card bl-card--link" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Icon name="insights" size={24} style={{ color: "var(--bl-blue)" }} />
              <span style={{ flex: 1 }}>
                <span className="bl-h3">内訳を見る</span>
                <span className="bl-micro" style={{ display: "block", marginTop: 2 }}>
                  何がこの値につながったか
                </span>
              </span>
              <Icon name="chevron_right" size={20} style={{ color: "var(--bl-ink-3)" }} />
            </Link>
          </section>

          <section className="bl-card">
            <div className="bl-card-head">
              <Icon name="monitoring" size={21} />
              <h2 className="bl-h2">日ごとの変化</h2>
            </div>

            <div style={{ height: "22rem", width: "100%", fontSize: "0.75rem" }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 16, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--bl-line-soft)" />
                  <XAxis
                    dataKey="day"
                    stroke="var(--bl-ink-3)"
                    tickLine={false}
                    tick={{ fontFamily: "var(--bl-font)", fontSize: 11 }}
                  />
                  <YAxis
                    stroke="var(--bl-ink-3)"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontFamily: "var(--bl-font)", fontSize: 11 }}
                  />
                  <Tooltip
                    contentStyle={{
                      border: "1px solid var(--bl-line)",
                      backgroundColor: "#ffffff",
                      fontFamily: "var(--bl-font)",
                      fontSize: "13px",
                      color: "var(--bl-ink)",
                      borderRadius: "var(--bl-radius-sm)",
                    }}
                    labelStyle={{
                      fontFamily: "var(--bl-font)",
                      fontSize: "11px",
                      color: "var(--bl-ink-3)",
                      fontWeight: 700,
                    }}
                  />
                  <ReferenceLine
                    y={REVIEW_THRESHOLD}
                    label={{
                      value: "確認の目安",
                      fill: "var(--bl-watch-ink)",
                      fontSize: 11,
                      fontFamily: "var(--bl-font)",
                    }}
                    stroke="var(--bl-watch)"
                    strokeDasharray="5 5"
                    opacity={0.7}
                  />
                  <Line
                    type="monotone"
                    dataKey="anomaly_score"
                    stroke="var(--bl-blue)"
                    strokeWidth={2.5}
                    dot={{ r: 3.5, fill: "var(--bl-blue)", strokeWidth: 2, stroke: "#ffffff" }}
                    activeDot={{ r: 6, strokeWidth: 0, fill: "var(--bl-blue)" }}
                    name="変化の大きさ"
                    animationDuration={900}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      )}

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        この値は日記の書き方の変化をまとめたものです。診断ではありません。
      </p>
    </div>
  );
}
