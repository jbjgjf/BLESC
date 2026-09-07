"""Render docs/pilot/data-dictionary.md from the JSON source.

The JSON is the source the app and the export read. The Markdown exists so a
reviewer who is not going to open a JSON file can still check the scales and
the anchors — which is most of the people who have to approve this. Generating
one from the other keeps them from disagreeing, which is the failure mode a
hand-maintained pair of documents always reaches.

    python3 docs/pilot/render_dictionary.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def render() -> str:
    data = json.loads((HERE / "data-dictionary.json").read_text(encoding="utf-8"))
    lines: list[str] = []
    add = lines.append

    add("# データ辞書（人が読む版）")
    add("")
    add("> 正本は [data-dictionary.json](data-dictionary.json)。**この .md は生成物**で、JSONを変えたら")
    add("> `python3 docs/pilot/render_dictionary.py` で作り直す。手で編集しない。")
    add("")
    add(f"版 `{data['version']}` / 状態 **{data['status']}**")
    add("")
    add(data["purpose"])
    add("")
    for note in data["notes"]:
        add(f"- {note}")
    add("")

    add("## 識別子")
    add("")
    add("| id | 型 | export | 実装 | 説明 |")
    add("| --- | --- | --- | --- | --- |")
    for key, field in data["identity"].items():
        add(
            f"| `{key}` | {field['type']} | {field['in_export']} | "
            f"{field['implementation']} | {field['description']} |"
        )
    add("")

    add("## 日次の固定自己評定")
    add("")
    add(f"schema id `{data['daily_self_report']['schema_id']}` / 提示順は固定")
    add("")
    add("| 順 | id | 項目 | 尺度 | 必須 | 実装 |")
    add("| --- | --- | --- | --- | --- | --- |")
    for item in data["daily_self_report"]["items"]:
        add(
            f"| {item['order']} | `{item['id']}` | {item['label_ja']} | {item.get('scale', item.get('type'))} | "
            f"{'必須' if item['required'] else '任意'} | {item['implementation']} |"
        )
    add("")
    for item in data["daily_self_report"]["items"]:
        if "description" in item:
            add(f"- `{item['id']}`: {item['description']}")
    add("")

    add("## 自由記述")
    add("")
    add("| id | 型 | export | 実装 | 説明 |")
    add("| --- | --- | --- | --- | --- |")
    for key, field in data["journal"].items():
        add(
            f"| `{key}` | {field['type']} | {field['in_export']} | "
            f"{field['implementation']} | {field.get('description', '')} |"
        )
    add("")

    add("## 記録の過程")
    add("")
    add(f"{data['process_telemetry']['description']}（`{data['process_telemetry']['code_ref']}`）")
    add("")
    add("| id | 型 | export | 実装 |")
    add("| --- | --- | --- | --- |")
    for field in data["process_telemetry"]["fields"]:
        add(f"| `{field['id']}` | {field['type']} | {field['in_export']} | {field['implementation']} |")
    add("")

    add("## 同意")
    add("")
    add("| id | 既定 | 実装 | 保存先 |")
    add("| --- | --- | --- | --- |")
    for key, field in data["consent"].items():
        add(f"| `{key}` | {field.get('default')} | {field['implementation']} | {field.get('code_ref', '—')} |")
    add("")
    for key, field in data["consent"].items():
        if "description" in field:
            add(f"- `{key}`: {field['description']}")
    add("")

    add("## 運用の記録")
    add("")
    add("| id | 実装 | 保存先 | 説明 |")
    add("| --- | --- | --- | --- |")
    for key, field in data["operations"].items():
        add(f"| `{key}` | {field['implementation']} | {field['code_ref']} | {field['description']} |")
    add("")

    add("## 収集しないもの")
    add("")
    for item in data["never_collected"]:
        add(f"- {item}")
    add("")
    return "\n".join(lines)


if __name__ == "__main__":
    (HERE / "data-dictionary.md").write_text(render(), encoding="utf-8")
    print("wrote docs/pilot/data-dictionary.md")
