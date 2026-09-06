# benchmark_labels

The answer key for the #88 retrieval benchmark, and who produced it.

```
raters/<rater_id>.json   one returned labelling file, exactly as the rater sent it back
adjudication.json        resolutions for cases the raters disagreed on, and the reviewer's name
```

Written and read by `scripts/run_benchmark_labelling.py`; assembled into a case
set by `app/services/benchmark_label_store.py`. Nothing here is edited by hand
in normal use — a label is changed by re-importing a corrected rater file or by
recording a resolution, so the change is attributable.

## Why this is in the repository

It is the answer key to a **synthetic** benchmark. There is no user content in
it — the cases are authored fixtures, and `privacy_class` on the dataset says
so. A retrieval result that cannot be regenerated from the repository is not
reproducible, and the key is half of what a run needs.

It sits beside `app/`, not inside `app/services/benchmark_cases/`, so that data
and code stay separable: a label is never changed by editing a case file, and a
case is never changed by editing a label.

## State

Empty. The 82 cases currently carry drafted keys (`labelled_by="draft"`), so
every retrieval number the benchmark reports is PRELIMINARY. The labelling work
is #127; the pre-registration in `docs/benchmark_preregistration.md` is what to
read before starting it.

Once a rater file lands here, `run_hf_research_benchmark()` picks it up on its
next run and reports `label_provenance.source = "store"`.
