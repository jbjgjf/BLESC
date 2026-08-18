"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./insights.module.css";

function formatRecord(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function SectionHead({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className="bl-card-head">
      <Icon name={icon} size={21} />
      <h2 className="bl-h2">{label}</h2>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className={styles.empty}>{text}</p>;
}

export default function Insights() {
  const { userId } = useAuth();
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInsights = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const currentAnomaly = await ApiClient.getAnomaly(userId);
      setAnomaly(currentAnomaly);
      if (currentAnomaly.explanation_id) {
        setExplanation(await ApiClient.getExplanation(currentAnomaly.explanation_id));
      }
    } catch (err) {
      setAnomaly(null);
      setExplanation(null);
      setError(err instanceof Error ? err.message : "内訳の読み込みに失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadInsights();
  }, [loadInsights]);

  if (isLoading) {
    return (
      <div className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </div>
    );
  }

  const zscores = Object.entries(explanation?.baseline_deviation_json?.feature_zscores ?? {});

  return (
    <div className="bl-wrap bl-wrap--wide bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">変化の内訳</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          タイムラインの値が、どんな要素から出てきたのかを分解して見られます。
        </p>
      </header>

      {error && (
        <div className="bl-notice bl-notice--watch" role="alert">
          <Icon name="warning" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {!anomaly ? (
        <div className="bl-card bl-empty">
          <Icon name="insights" size={40} />
          <p className="bl-body">まだ内訳を出せる記録がありません。日記を提出すると表示されます。</p>
        </div>
      ) : (
        <div className={styles.grid}>
          <section className="bl-stack">
            <div className={styles.score}>
              <span className="bl-eyebrow">変化の大きさ</span>
              <div className={styles.scoreValue}>{anomaly.anomaly_score.toFixed(2)}</div>
              <p className="bl-body" style={{ marginTop: 12 }}>
                ルールの反応、ふだんとの差、日ごとの移り変わりをまとめた値です。診断ではありません。
              </p>
            </div>

            <div className="bl-card">
              <SectionHead icon="monitoring" label="ふだんとの差" />
              {zscores.length === 0 ? (
                <Empty text="差を出せる項目がありません。" />
              ) : (
                <div className={styles.rows}>
                  {zscores.slice(0, 6).map(([feature, z]) => (
                    <div key={feature} className={styles.row}>
                      <span>{feature}</span>
                      <span className={styles.mono}>
                        {Number.isFinite(Number(z)) ? Number(z).toFixed(2) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="bl-stack">
            <div className="bl-card">
              <SectionHead icon="auto_awesome" label="反応したルール" />
              {!explanation || explanation.triggered_rules_json.length === 0 ? (
                <Empty text="反応したルールはありません。" />
              ) : (
                <div className={styles.rules}>
                  {explanation.triggered_rules_json.map((rule) => (
                    <div key={rule.rule} className={styles.rule}>
                      <div className="bl-row-between" style={{ flexWrap: "wrap", gap: 8 }}>
                        <span className="bl-h3">{rule.rule.replaceAll("_", " ")}</span>
                        <span className="bl-chip bl-chip--tint">重み {rule.weight.toFixed(2)}</span>
                      </div>
                      <p className="bl-body" style={{ fontSize: "0.87rem", marginTop: 5 }}>
                        {rule.evidence}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bl-grid bl-grid--2">
              <div className="bl-card">
                <SectionHead icon="timeline" label="関係の変化" />
                {!explanation || explanation.changed_relations_json.length === 0 ? (
                  <Empty text="関係の変化は検出されていません。" />
                ) : (
                  <div className={styles.rows}>
                    {explanation.changed_relations_json.map((rel, index) => (
                      <pre key={index} className={styles.code}>
                        {formatRecord(rel)}
                      </pre>
                    ))}
                  </div>
                )}
              </div>

              <div className="bl-card">
                <SectionHead icon="psychology" label="支えの変化と不確かさ" />
                <details className={styles.details} open>
                  <summary>支えになっていたものの減り方</summary>
                  <pre className={styles.code}>{formatRecord(explanation?.protective_decline_json)}</pre>
                </details>
                <details className={styles.details}>
                  <summary>どこまで確かか</summary>
                  <pre className={styles.code}>{formatRecord(explanation?.uncertainty_json)}</pre>
                </details>
              </div>
            </div>

            <div className="bl-card">
              <SectionHead icon="graphic_eq" label="主な関係" />
              {!explanation || explanation.key_relations.length === 0 ? (
                <Empty text="表示できる関係がありません。" />
              ) : (
                <div className={styles.rows}>
                  {explanation.key_relations.slice(0, 8).map((rel) => (
                    <div key={`${rel.source_id}-${rel.target_id}-${rel.type}`} className={styles.row}>
                      <span>
                        {rel.source_id} → {rel.type.replaceAll("_", " ")} → {rel.target_id}
                      </span>
                      <span className={styles.mono}>確度 {rel.confidence.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        ここに出る値と根拠は、教員や本人が状況を確認するための材料です。診断ではありません。
      </p>
    </div>
  );
}
