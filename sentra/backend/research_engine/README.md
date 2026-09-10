# 研究エンジン v0

合成データで、学習する表現・記憶を持つ予測・説明グラフ・独立評価までを1コマンドで通す。

```bash
cd sentra/backend
python -m research_engine.cli smoke --config research_engine/configs/smoke.json --out /tmp/blesc-research-smoke
python -m research_engine.cli evaluate --run /tmp/blesc-research-smoke --split heldout
```

鍵もネットワークもGPUも要らない。CPUで約60秒。`smoke` は漏洩検査が1つでも赤ければ非ゼロで終了するので、CIは「漏洩したと書いてあるreport」で緑にならない。

## 何をしていて、何をしていないか

**している**: 合成観測の生成（S1〜S5）、参加者単位・時間の分割、trainのみでの正規化、GRU encoderの学習と保存・再読込、持続値／訓練平均／線形AR／記憶モデルの比較、説明射影と候補グラフ（積項込み）、paired rolloutでの忠実度、予測の封印台帳、漏洩検査、評価report。

**していない**: 実データの取込（契約が2箇所で拒否する）、現実の因果効果の推定、適応的な質問選択、較正済みの不確実性。`capability_flags` の false はそのまま「できていない」を意味する。

## 構成

| ディレクトリ | 担当 | 出力する契約 |
| --- | --- | --- |
| `contracts/` | 型・版・拒否規則。ここだけがT0の所有 | C1〜C5 |
| `data/` | 観測の読み込み、分割、train限定の正規化、既存時系列からのadapter | C1 |
| `representation/` | 学習するencoderとcheckpoint | C2 |
| `dynamics/` | baselineと記憶モデル、モデル内rollout | C3 |
| `abstraction/` | 説明射影・候補構造・忠実度 | C4 |
| `evaluation/` | 合成生成器（真値は隔離）、metric、漏洩検査、封印台帳 | C5 |
| `pipeline.py` | 上をつなぐ1本の経路 | — |
| `cli.py` / `configs/` | 入口 | — |

APIは `app/api/research_world_model.py`（C6）。既定では `RESEARCH_API_TOKEN` 未設定で503を返し、誰にも開かない。

## 読み方の注意

- `ci.json` の数値は経路確認用で、モデルの性能ではない。性能を読むのは `smoke.json` の結果。
- 3seedは再現性の初期点検であり、統計的検出力の保証ではない。
- `provider_calls: 0` は「呼び出さなかった」という実測。`null` は未計測で、別のこと。
- 記憶モデルが全体で線形ARに勝っていない結果も、そのままreportに残る。S1は「単純な線形で足りる場面で複雑なモデルが優れて見える」ことを検出するためのシナリオである。

## 次の段階

[R1](../../docs/world-model/research-r1-real-observations.md) 実観測と測定の検証 /
[R2](../../docs/world-model/research-r2-multiscale-structure.md) 多時間尺度・高次構造・部分識別 /
[R3](../../docs/world-model/research-r3-observation-selection.md) 観測選択と前向き評価
