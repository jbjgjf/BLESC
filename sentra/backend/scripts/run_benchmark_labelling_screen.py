"""A local labelling screen for the #88 benchmark (#127).

    # first rater: every drafted case (plus the agreement sample), test split last
    python scripts/run_benchmark_labelling_screen.py --rater ayaka

    # second rater: only the 20 pre-drawn agreement cases
    python scripts/run_benchmark_labelling_screen.py --rater kenji --sample

Then open the address it prints (http://127.0.0.1:8765/ by default). Stop with
Ctrl-C at any point; every click on 保存 is already on disk, and starting the
same command again resumes where the rater left off.

Why a page and not a terminal UI: a rater reads 26-40 Japanese and English
diary lines per case and ticks the ones that help. A browser renders and wraps
both scripts properly and checkboxes are the task's natural shape; a curses UI
would fight both. Why the standard library and not the FastAPI app: this must
never be deployed, needs no account, and should not be one import away from
the product's routes. It is a separate process that only listens on 127.0.0.1.

What it will not do — each pinned by `tests/test_benchmark_labelling_screen.py`:

- listen on anything but 127.0.0.1 (there is no --host option);
- answer a request whose Host header is not this machine (a page on another
  site cannot drive it through DNS rebinding);
- accept a save without the form token this process issued;
- show a drafted answer, as a default selection or at all;
- read or show any other rater's file.

The file it writes is `benchmark_labels/raters/<rater>.json`, the same format
`run_benchmark_labelling.py export` produces, in display ids. `status`,
`agreement`, `adjudicate` and `apply` work on it unchanged.
"""

from __future__ import annotations

import argparse
import html
import secrets
import socketserver
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.benchmark_label_store import DEFAULT_STORE, LabelStoreError  # noqa: E402
from app.services.benchmark_labelling_session import CaseView, LabellingSession  # noqa: E402

#: Loopback only. Deliberately not configurable.
BIND_ADDRESS = "127.0.0.1"
DEFAULT_PORT = 8765

#: The instruction `labelling_task` carries, in Japanese, shown above it.
INSTRUCTION_JA = (
    "このクエリに答える助けになる日を、すべて選んでください。同じことを別の言葉で書いている日や、"
    "そこへつながる連鎖の一部になっている日も含みます。どの日も助けにならないと判断したら"
    "「該当なし」を選んでください。何も選ばずに次へ進むと「未ラベル」のまま残ります（「該当なし」とは別です）。"
)

STYLE = """
body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;background:#f7f6f2;color:#222}
main{max-width:860px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:14px;color:#555}
.query{font-size:20px;background:#fff;border:1px solid #ddd;border-radius:8px;padding:14px;margin:12px 0}
.note{font-size:14px;color:#444;line-height:1.6}
ol{list-style:none;padding:0}
li{background:#fff;border:1px solid #ddd;border-radius:8px;margin:8px 0;padding:10px}
label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
input[type=checkbox]{width:20px;height:20px;margin-top:2px;flex:none}
.day{font-size:12px;color:#777}
.motif{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#666;word-break:break-word}
.text{font-size:16px;line-height:1.5}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
button,a.btn{font-size:15px;padding:10px 14px;border-radius:6px;border:1px solid #888;background:#fff;color:#222;text-decoration:none}
button.primary{background:#2d4a7a;color:#fff;border-color:#2d4a7a}
.none{background:#fff8e6}
.state{font-weight:600}
"""


def _page(title: str, body: str) -> bytes:
    return (
        "<!doctype html><html lang=ja><head><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title><style>{STYLE}</style></head>"
        f"<body><main>{body}</main></body></html>"
    ).encode("utf-8")


STATE_LABEL = {"unlabelled": "未ラベル", "labelled": "ラベル済み", "none": "該当なし（ラベル済み）"}


def render_case(view: CaseView, token: str, done: int) -> bytes:
    """One case. Only this rater's own saved ticks are ever `checked`."""
    chosen = set(view.selected)
    items: List[str] = []
    for candidate in view.candidates:
        shown = str(candidate["evidence_id"])
        motifs = "<br>".join(html.escape(str(motif)) for motif in candidate["graph_motifs"])
        checked = " checked" if shown in chosen else ""
        items.append(
            "<li><label>"
            f'<input type=checkbox name=pick value="{html.escape(shown)}"{checked}>'
            f'<span><span class=day>{html.escape(shown)} · {html.escape(str(candidate["day"]))}</span><br>'
            f'<span class=text>{html.escape(str(candidate["text"]))}</span><br>'
            f"<span class=motif>{motifs}</span></span>"
            "</label></li>"
        )
    none_checked = " checked" if view.state == "none" else ""
    number = view.index + 1
    previous = f'<a class=btn href="/case/{number - 1}">← 前へ</a>' if view.index > 0 else ""
    following = f'<a class=btn href="/case/{number + 1}">次へ（保存しない）→</a>' if number < view.total else ""
    body = (
        f"<header><span>レーター用画面 · {number} / {view.total} 件目 · ラベル済み {done} 件</span>"
        f'<span class=state>このケース: {STATE_LABEL[view.state]}</span></header>'
        f'<div class=query lang="{html.escape(view.lang)}">{html.escape(view.query)}</div>'
        f"<p class=note>{html.escape(INSTRUCTION_JA)}</p>"
        f'<p class=note lang=en>{html.escape(view.instruction)}</p>'
        f'<form method=post action="/case/{number}">'
        f'<input type=hidden name=token value="{html.escape(token)}">'
        f"<ol>{''.join(items)}</ol>"
        f'<p class="none"><label><input type=checkbox name=nothing value=1{none_checked}>'
        "<span>該当なし — どの日もこのクエリに答える助けにならない</span></label></p>"
        '<div class=bar><button class=primary name=go value=next>保存して次へ</button>'
        "<button name=go value=stay>保存</button></div>"
        "</form>"
        f"<div class=bar>{previous}{following}"
        '<a class=btn href="/next">次の未ラベルへ</a></div>'
    )
    return _page(f"{number}/{view.total}", body)


def render_done(session: LabellingSession) -> bytes:
    summary = session.summary()
    body = (
        "<h1>このセッションのケースはすべてラベル済みです</h1>"
        f"<p class=note>{summary['labelled']} / {summary['cases']} 件。保存先: "
        f"<code>{html.escape(str(summary['file']))}</code></p>"
        '<p class=note>見直す場合は <a href="/case/1">1 件目</a> から。'
        "終了するにはターミナルで Ctrl-C。</p>"
    )
    return _page("完了", body)


class _LoopbackServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` without the reverse-DNS lookup in `server_bind`.

    `HTTPServer.server_bind` calls `socket.getfqdn()` on the bind address,
    which can stall for tens of seconds on a machine whose resolver times out
    on reverse lookups. A server that only ever answers 127.0.0.1 has no use
    for a fully qualified name.
    """

    daemon_threads = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


def make_server(session: LabellingSession, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """The screen for one session. `port=0` picks a free port (tests)."""
    token = secrets.token_urlsafe(24)

    class Handler(BaseHTTPRequestHandler):
        server_version = "BenchmarkLabelling/1"

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
            # Request lines would print case positions to the terminal; nothing
            # in them is useful to the rater.
            return

        # ---- guards ---------------------------------------------------------

        def _host_ok(self) -> bool:
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            return host in {"127.0.0.1", "localhost"}

        def _send(self, status: HTTPStatus, body: bytes = b"", location: Optional[str] = None) -> None:
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def _case_number(self, path: str) -> Optional[int]:
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "case" and parts[1].isdigit():
                number = int(parts[1])
                if 1 <= number <= session.total:
                    return number
            return None

        def _next_location(self, after: int = -1) -> str:
            index = session.next_unlabelled(after)
            return "/done" if index is None else f"/case/{index + 1}"

        # ---- routes ---------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if not self._host_ok():
                self._send(HTTPStatus.FORBIDDEN, b"forbidden")
                return
            path = urlsplit(self.path).path
            if path in ("/", "/next"):
                self._send(HTTPStatus.SEE_OTHER, location=self._next_location())
                return
            if path == "/done":
                self._send(HTTPStatus.OK, render_done(session))
                return
            number = self._case_number(path)
            if number is None:
                self._send(HTTPStatus.NOT_FOUND, _page("not found", "<p>not found</p>"))
                return
            self._send(HTTPStatus.OK, render_case(session.view(number - 1), token, session.done()))

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            if not self._host_ok():
                self._send(HTTPStatus.FORBIDDEN, b"forbidden")
                return
            number = self._case_number(urlsplit(self.path).path)
            if number is None:
                self._send(HTTPStatus.NOT_FOUND, _page("not found", "<p>not found</p>"))
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > 64_000:
                self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"too large")
                return
            form: Dict[str, List[str]] = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
            if not secrets.compare_digest((form.get("token") or [""])[0], token):
                self._send(HTTPStatus.FORBIDDEN, _page("forbidden", "<p>この画面から送信してください。</p>"))
                return
            view = session.view(number - 1)
            try:
                session.record(view.case_id, form.get("pick", []), nothing_helps=bool(form.get("nothing")))
            except ValueError as error:
                message = (
                    "<p>保存できませんでした: 「該当なし」と日の選択は同時にできません。</p>"
                    if "cannot be combined" in str(error)
                    else f"<p>保存できませんでした: {html.escape(str(error))}</p>"
                )
                self._send(
                    HTTPStatus.BAD_REQUEST,
                    _page("error", f'{message}<p><a href="/case/{number}">戻る</a></p>'),
                )
                return
            go = (form.get("go") or ["next"])[0]
            location = f"/case/{number}" if go == "stay" else self._next_location(number - 1)
            self._send(HTTPStatus.SEE_OTHER, location=location)

    return _LoopbackServer((BIND_ADDRESS, port), Handler)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rater", required=True, help="Rater id. The file is benchmark_labels/raters/<rater>.json.")
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE, help="Label store directory.")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--sample", action="store_true", help="Only the 20 pre-drawn agreement cases (second rater).")
    scope.add_argument(
        "--all",
        action="store_true",
        help="Include the development cases, which the pre-registration excludes from analysis.",
    )
    parser.add_argument("--split", choices=("train", "validation", "test"), default=None)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)

    try:
        session = LabellingSession(
            args.rater,
            store=args.store,
            scope="sample" if args.sample else ("all" if args.all else "main"),
            split=args.split,
        )
    except (LabelStoreError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1

    server = make_server(session, args.port)
    summary = session.summary()
    print(f"rater      {summary['rater_id']}")
    print(f"file       {summary['file']}")
    print(f"progress   {summary['labelled']}/{summary['cases']} cases ({summary['judgements']} candidates in scope)")
    print(f"open       http://{BIND_ADDRESS}:{server.server_address[1]}/")
    print("stop       Ctrl-C (every 保存 is already written)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
