"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import { GraphSnapshot } from "@/api/models";
import { GraphViewer3D } from "@/components/graph/GraphViewer3D";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";

export default function GraphPage() {
  const { userId } = useAuth();
  const [snapshots, setSnapshots] = useState<GraphSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setSnapshots(await ApiClient.getGraphSnapshots(userId));
    } catch (err) {
      setSnapshots([]);
      setError(err instanceof Error ? err.message : "グラフの読み込みに失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const currentSnapshot = snapshots.at(-1) ?? null;

  return (
    <div className="bl-wrap bl-wrap--wide bl-stack">
      <header className="bl-row-between" style={{ padding: "2px 2px 0", flexWrap: "wrap" }}>
        <div>
          <h1 className="bl-h1">関係グラフ</h1>
          <p className="bl-meta" style={{ marginTop: 3 }}>
            日記から抽出された出来事・気持ち・支えの関係と、その移り変わりを立体的に見られます。
          </p>
        </div>
        <span className="bl-chip bl-chip--tint">
          {isLoading ? "読み込み中…" : `${snapshots.length}件の記録`}
        </span>
      </header>

      {error && (
        <div className="bl-notice bl-notice--watch" role="alert">
          <Icon name="warning" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {isLoading ? (
        <div className="bl-card" style={{ display: "grid", placeItems: "center", minHeight: "20rem" }}>
          <span className="bl-loader" aria-label="読み込み中" />
        </div>
      ) : snapshots.length === 0 ? (
        <div className="bl-card bl-empty">
          <Icon name="graphic_eq" size={40} />
          <p className="bl-body">まだグラフを作れる記録がありません。日記を提出すると表示されます。</p>
        </div>
      ) : (
        <GraphViewer3D
          snapshots={snapshots}
          currentSnapshot={currentSnapshot}
          explanation={null}
          title="関係グラフ"
        />
      )}

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        これは日記から抽出した関係の可視化です。診断ではありません。
      </p>
    </div>
  );
}
