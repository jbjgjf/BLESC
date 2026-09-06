// Strings the language check may skip, grouped by why.
//
// Every entry here is a claim that the text never reaches a reader. Adding one
// is cheap and reversible; the group it goes in is the argument for it, so a
// reviewer can disagree with the argument rather than with a bare list. If a
// string does not fit a group, it probably belongs in `src/lib/i18n`.

/** Names of things, which do not translate. */
const BRAND = ["blesc"];

/** Shell commands and selectors, quoted so a reader can copy them. */
const CODE = ["npm run smoke", "#bl-main h1"];

/**
 * Text the product matches *on*, not text it shows. Supabase answers in
 * English, and the crisis lexicon has to match what a student might type in
 * either language, so both stay in the source language of what they match.
 */
const MATCHED_AGAINST = [
  "invalid login credentials",
  "email not confirmed",
  "user already registered",
  "password should be at least",
  "rate limit",
  "too many",
  "not configured",
  "kill myself",
  "want to die",
  "hurt myself",
];

/**
 * Instructions addressed to the model. The reply they produce is Japanese —
 * the chat and voice prompts say so explicitly — but the instruction itself is
 * written in the language the model follows most reliably.
 */
const MODEL_INSTRUCTIONS = [
  "BLESC 30-turn recall workspace. Use cautious, non-diagnostic language.",
  "Briefly reflect the user's latest answer, avoid clinical certainty, then keep the interview moving.",
  "Current user turn: ${nextUserTurnCount}/${MAX_USER_TURNS}.",
  "Next guided question candidate: ${nextQuestionForTurn(nextUserTurnCount)}",
  "Say this to the student now, in your own voice and without preamble: ${safeResponse}",
  "Safety comes before every other goal in this conversation.",
  "Never promise secrecy, exclusivity, or permanence. Do not say you will always be there, that the student needs only you, or that you will keep something from a trusted adult.",
  "Be accurate about privacy. Raw journal and chat text is never visible to educators or counselors. A derived summary reaches an educator only when the student grants consent on the Sharing page, and that consent can be revoked at any time. You never contact anyone on the student's behalf and you cannot notify an adult yourself — when there is risk you encourage the student toward a real person, you do not route around them. Never say this conversation is completely private, and never say nothing is ever shared with anyone.",
  "Do not confirm beliefs the student cannot verify, such as a group conspiring against them. Stay warm, keep the uncertainty open, and never diagnose.",
  "The recent turns contain explicit danger signals. Lead with immediate safety, keep the reply short and concrete, name local emergency services and a crisis line alongside a trusted adult, and do not bury those routes.",
  "The recent turns contain possible danger signals, which may be ambiguous. Err toward support: check on their safety and offer a real-person route even if you are unsure, and name local emergency services if the risk could be immediate.",
];

/**
 * Server-side failures, named after the table that refused the write. These
 * reach a log and a 500 body, never a screen: the client turns a failed
 * submission into its own message from the catalogue.
 */
const WRITE_FAILURES = [
  "${label}: no row returned",
  "owner_user_id/participant_id not supplied",
  "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set",
  "entries insert",
  "graph_snapshots insert",
  "insights insert",
  "consent_records insert",
  "entry_sessions insert",
  "entry_fields insert: ${fieldsInsert.error.message}",
  "interaction_events insert: ${eventsInsert.error.message}",
  "entry_research_links insert: ${linkInsert.error.message}",
  "entry_embeddings insert: ${insert.error.message}",
  "model_runs insert: ${runInsert.error.message}",
  "safety model_runs insert: ${safetyInsert.error.message}",
  "extractions insert: ${extractionInsert.error.message}",
  "graph_versions insert: ${versionInsert.error.message}",
  "graph_change_events insert: ${changeInsert.error.message}",
  "longitudinal_features insert: ${insert.error.message}",
  "eval_examples insert: ${insert.error.message}",
];

/** A programming mistake, raised where only a developer can see it. */
const DEVELOPER_ERRORS = ["useAuth must be used inside AuthProvider"];

export const ALLOWLIST = [
  ...BRAND,
  ...CODE,
  ...MATCHED_AGAINST,
  ...MODEL_INSTRUCTIONS,
  ...WRITE_FAILURES,
  ...DEVELOPER_ERRORS,
];
