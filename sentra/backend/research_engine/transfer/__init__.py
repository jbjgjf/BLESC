"""Synthetic→real model-selection transfer study (epic #210, #211–#216).

The research question: does a model ranking chosen on frozen synthetic data,
before any real participant is seen, hold on the 50×28 pilot (#315)? This
package holds the machinery for answering it, built as far as synthetic data
alone allows:

- `preregistration` (#211) reads the pre-registration draft as structured data
  and refuses to freeze it while any decision is still open.
- `schema` and `generator` (#213) produce seeded 50×28 synthetic cohorts in the
  pilot's shape, with the generating truth kept apart from the data.
- `llm_persona` (#213) is the *interface* for an LLM persona generator. It
  ships no provider and makes no call; it exists so that the record of a
  future call (prompt, model version, cost) has a fixed shape before anyone
  spends money.
- `consent_gate` (#212) is the one door every analysis input passes through.
  It reuses the v0 refusals in `contracts/observation.py`, so real data stops
  there until a human changes that contract deliberately.
- `audit` (#214), `forecasting` / `ranking` / `seal` (#215) and `sensitivity` /
  `report` (#216) are the analyses, written before the data exists.

What this package does **not** do is decide anything the pre-registration
leaves open (P1–P14). Where an analysis needs a value to run at all, it takes
it from an `AnalysisPlan`, and the only plan in the code is a dry-run
placeholder that labels itself as such on every output. Nothing generated here
is frozen: every artifact says "candidate (not frozen)", and freezing is a
human step recorded in the pre-registration.

Nor is any synthetic distribution here a measured population prior (#62,
#99). The generator's parameters are assumptions chosen to exercise the code.
"""

from __future__ import annotations

#: Version of the transfer-study artifacts as a whole. Bumped when the shape of
#: any manifest, report or seal changes, so that an artifact written under one
#: shape is never read as if it were another.
TRANSFER_STUDY_VERSION = "transfer-study-v0"

#: Status every generated artifact carries until a human freezes it. Spelled
#: out rather than a boolean so that a reader of a JSON file does not have to
#: know which way round `frozen: false` was meant.
CANDIDATE_STATUS = "candidate_not_frozen"
CANDIDATE_STATUS_JA = "候補（未凍結）。凍結は事前登録が確定した後に人が行う。"

__all__ = ["CANDIDATE_STATUS", "CANDIDATE_STATUS_JA", "TRANSFER_STUDY_VERSION"]
