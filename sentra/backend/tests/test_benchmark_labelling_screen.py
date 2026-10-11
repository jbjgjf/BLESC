"""The local labelling screen (#127).

What is pinned here is what #127 and #88 make non-negotiable about a screen a
rater uses: it never offers the drafted answer, it never shows one rater
another's labels, it does not put the held-out split first, it survives being
closed halfway, and it does not listen beyond this machine.

Every selection below is invented by the test to drive the flow. None of it is,
or stands in for, a human label, and every file is written under tmp_path.
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import re
import threading
from pathlib import Path
from urllib.parse import urlencode

import pytest

from app.services.benchmark_cases import BENCHMARK_CASES, DEVELOPMENT_CASE_IDS
from app.services.benchmark_label_store import LabelStoreError, resolve_dataset
from app.services.benchmark_labelling import agreement_sample, display_ids
from app.services.benchmark_labelling_session import LabellingSession, scope_cases

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_benchmark_labelling_screen.py"


def _screen():
    spec = importlib.util.spec_from_file_location("run_benchmark_labelling_screen", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _drafted_shown(case):
    shown = display_ids(case)
    return [shown[evidence_id] for evidence_id in case.expected_evidence_ids]


# ---- nothing is offered as the answer ---------------------------------------


def test_a_fresh_session_preselects_nothing_on_any_case(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    for index in range(session.total):
        view = session.view(index)
        assert view.selected == [], f"{view.case_id} opened with {view.selected} ticked"
        assert view.state == "unlabelled"


def test_the_rendered_page_ticks_nothing_and_carries_no_key(tmp_path):
    screen = _screen()
    session = LabellingSession("rater-a", store=tmp_path)
    for index in range(session.total):
        view = session.view(index)
        page = screen.render_case(view, "token", 0).decode("utf-8")
        assert " checked" not in page, f"{view.case_id} renders a ticked box"
        case = next(case for case in BENCHMARK_CASES if case.case_id == view.case_id)
        assert case.research_note not in page
        assert "expected" not in page and "decoy" not in page.lower()
        # The case's own ids spell the drafted role; only display ids appear.
        assert not re.search(r'value="[cdf]\d+"', page)


# ---- one rater cannot see another -------------------------------------------


def test_a_rater_never_sees_another_raters_choices(tmp_path):
    other = LabellingSession("rater-b", store=tmp_path, scope="sample")
    for case in other.cases:
        other.record(case.case_id, _drafted_shown(case))
    other_file = other.path.read_bytes()

    mine = LabellingSession("rater-a", store=tmp_path)
    for case in other.cases:
        assert mine.view(mine.index_of(case.case_id)).selected == []

    first = mine.cases[0]
    mine.record(first.case_id, _drafted_shown(first)[:1])
    assert other.path.read_bytes() == other_file, "saving as one rater rewrote another rater's file"
    assert mine.path != other.path


def test_a_session_refuses_to_resume_someone_elses_file(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    session.record(session.cases[0].case_id, _drafted_shown(session.cases[0]))
    rows = json.loads(session.path.read_text(encoding="utf-8"))
    for row in rows:
        row["rater_id"] = "rater-b"
    session.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(LabelStoreError, match="belongs to rater"):
        LabellingSession("rater-a", store=tmp_path)


@pytest.mark.parametrize("rater_id", ["../escape", "a/b", "", ".hidden", "x" * 80])
def test_a_rater_id_cannot_point_the_file_somewhere_else(tmp_path, rater_id):
    with pytest.raises(ValueError, match="rater id"):
        LabellingSession(rater_id, store=tmp_path)


# ---- order and scope ---------------------------------------------------------


def test_the_held_out_split_comes_last(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    splits = [case.split for case in session.cases]
    assert splits[0] == "train"
    assert splits == sorted(splits, key=("train", "validation", "test").index)


def test_a_translation_is_not_labelled_straight_after_its_original(tmp_path):
    """Back to back, the second judgement of a matched pair is a copy."""
    session = LabellingSession("rater-a", store=tmp_path)
    adjacent = [
        (left.case_id, right.case_id)
        for left, right in zip(session.cases, session.cases[1:])
        if left.pair_id == right.pair_id
    ]
    assert not adjacent, f"matched pairs labelled back to back: {adjacent}"


def test_the_first_pass_covers_every_drafted_case_and_the_whole_agreement_sample():
    main = {case.case_id for case in scope_cases("main")}
    sample = {case.case_id for case in agreement_sample()}
    drafted = {case.case_id for case in BENCHMARK_CASES if case.labelled_by == "draft"}

    assert drafted <= main
    # Without the sample's development case, kappa would be over 19, not 20.
    assert sample <= main
    assert not (main - drafted - sample), "development cases outside the sample are not in the main pass"
    assert {case.case_id for case in scope_cases("sample")} == sample
    assert set(DEVELOPMENT_CASE_IDS) <= {case.case_id for case in scope_cases("all")}


# ---- saving, interrupting, resuming -----------------------------------------


def test_one_case_is_labelled_saved_and_resumed(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    first = session.cases[0]
    picks = _drafted_shown(first)
    session.record(first.case_id, picks)

    # A new process: nothing in memory survives, only the file.
    resumed = LabellingSession("rater-a", store=tmp_path)
    assert resumed.view(0).selected == sorted(picks)
    assert resumed.view(0).state == "labelled"
    assert resumed.next_unlabelled() == 1
    assert resumed.done() == 1

    # The file is an ordinary rater file: it reaches the dataset in the case's own ids.
    labelled = {case.case_id: case for case in resolve_dataset(tmp_path).cases}[first.case_id]
    assert labelled.labelled_by == "human"
    assert set(labelled.expected_evidence_ids) == set(first.expected_evidence_ids)


def test_nothing_helps_is_a_label_and_clearing_is_not(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    first = session.cases[0]

    session.record(first.case_id, [], nothing_helps=True)
    assert LabellingSession("rater-a", store=tmp_path).view(0).state == "none"

    session.record(first.case_id, [])
    assert LabellingSession("rater-a", store=tmp_path).view(0).state == "unlabelled"

    with pytest.raises(ValueError, match="cannot be combined"):
        session.record(first.case_id, _drafted_shown(first), nothing_helps=True)
    with pytest.raises(ValueError, match="not candidates"):
        session.record(first.case_id, ["c1"])


def test_resuming_a_file_from_another_dataset_version_is_refused(tmp_path):
    session = LabellingSession("rater-a", store=tmp_path)
    session.record(session.cases[0].case_id, _drafted_shown(session.cases[0]))
    rows = json.loads(session.path.read_text(encoding="utf-8"))
    for row in rows:
        row["dataset_version"] = "0.0.1-old"
    session.path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(LabelStoreError, match="dataset version"):
        LabellingSession("rater-a", store=tmp_path)


# ---- the HTTP surface --------------------------------------------------------


@pytest.fixture
def served(tmp_path):
    screen = _screen()
    session = LabellingSession("rater-a", store=tmp_path)
    server = screen.make_server(session, port=0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield session, server
    finally:
        server.shutdown()
        server.server_close()


def _request(server, method, path, body=None, host=None):
    port = server.server_address[1]
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    payload = response.read().decode("utf-8")
    connection.close()
    return response.status, response.getheader("Location"), payload


def _token(page: str) -> str:
    return re.search(r'name=token value="([^"]+)"', page).group(1)


def test_the_screen_listens_on_loopback_only(served):
    _, server = served
    assert server.server_address[0] == "127.0.0.1"
    # And there is no way to ask it to listen anywhere else.
    with pytest.raises(SystemExit) as refused:
        _screen().main(["--rater", "rater-a", "--host", "0.0.0.0"])
    assert refused.value.code == 2


def test_a_case_is_labelled_through_the_page_and_shown_ticked_after(served, tmp_path):
    session, server = served
    status, location, _ = _request(server, "GET", "/")
    assert (status, location) == (303, "/case/1")

    status, _, page = _request(server, "GET", "/case/1")
    assert status == 200 and " checked" not in page

    first = session.cases[0]
    picks = _drafted_shown(first)
    body = urlencode([("token", _token(page)), *[("pick", pick) for pick in picks], ("go", "next")])
    status, location, _ = _request(server, "POST", "/case/1", body)
    assert (status, location) == (303, "/case/2")

    _, _, again = _request(server, "GET", "/case/1")
    for pick in picks:
        assert f'value="{pick}" checked' in again
    assert sorted(LabellingSession("rater-a", store=tmp_path).view(0).selected) == sorted(picks)


def test_a_save_without_this_screens_token_is_refused(served):
    session, server = served
    body = urlencode([("token", "forged"), ("pick", _drafted_shown(session.cases[0])[0])])
    status, _, _ = _request(server, "POST", "/case/1", body)
    assert status == 403
    assert session.done() == 0
    assert not session.path.exists()


def test_a_request_for_another_host_is_refused(served):
    """DNS rebinding: a page on another site resolving its name to 127.0.0.1."""
    _, server = served
    status, _, _ = _request(server, "GET", "/case/1", host="labelling.example.com")
    assert status == 403
