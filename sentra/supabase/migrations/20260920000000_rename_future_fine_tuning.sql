-- `future_fine_tuning` → `model_training_use`.
--
-- ===========================================================================
-- One column rename. No data is written, dropped or reinterpreted: every
-- existing value carries over unchanged, and the default (`false`) is the same
-- before and after.
-- ===========================================================================
--
-- ## Why rename at all
--
-- The column names a consent item, and consent items are read by participants
-- and by whoever audits what was asked. `future_fine_tuning` is wrong on both
-- counts.
--
--   - **"future"** says the use is not happening yet. That is a fact about the
--     implementation on the day the column was created, not a property of the
--     permission, and it stops being true the moment training runs. A consent
--     record whose column name will quietly become a lie is not one that can be
--     shown to a review board.
--   - **"fine_tuning"** names one technique. `consent-pack.md` 第15条 asks about
--     「将来のモデルの学習に用いること」 — model training, of any shape. Pre-training,
--     RLHF, an embedding model, a distillation set: all of them are what the
--     participant was asked about and none of them are fine-tuning. A narrow
--     column name invites the reading that a broader use was never refused.
--
-- `model_training_use` says what it permits and stays true whether or not the
-- pipeline exists.
--
-- ## Why `alter … rename` and not add-copy-drop
--
-- A rename is atomic and keeps every row, index, constraint and policy attached
-- to the same column. The usual argument for the add/backfill/drop dance is
-- zero-downtime deploys where old and new code run together; this column is
-- read by one application and by the export path, and the pilot has not started
-- collecting. Paying for a compatibility window nobody is in would leave two
-- columns that can disagree, which is worse for a consent record than a
-- moment's coupling between this migration and the deploy.
--
-- **Deploy order, therefore: this migration, then the application.** Code that
-- still selects `future_fine_tuning` errors rather than silently reading false,
-- which is the right direction for a permission column — PostgREST answers 42703
-- and the request fails loudly.
--
-- ## Existing rows
--
-- Preserved exactly. No participant has granted this item — the pack says the
-- implementation that would read it is unfinished and instructs that the
-- consent not be collected until it exists — so every row is the `false`
-- default. The rename is verified rather than assumed by
-- `supabase/tests/pilot_consent_rls.test.sql`.

alter table public.consent_records
  rename column future_fine_tuning to model_training_use;

comment on column public.consent_records.model_training_use is
  'Optional, separate from participation: may this participant''s data be used to train a model. '
  'Default false. consent-pack.md 第15条. Renamed from future_fine_tuning on 2026-09-20 — the old '
  'name asserted the use was hypothetical and named a single technique.';
