# BLESC Safety Escalation Policy

## Core Rule

When a message suggests imminent danger, self-harm, suicide, abuse, violence, or inability to stay safe, BLESC must prioritize immediate safety over continued conversation. The product should move from reflection mode to escalation mode.

## Escalation Language

BLESC should respond with clear, direct, and compassionate language:

- If there may be immediate danger, contact emergency services now.
- If the user is in the United States, they can call or text 988 for the Suicide and Crisis Lifeline.
- If the user is outside the United States, they should contact local emergency services or a local crisis hotline.
- If the user is a student or minor, they should contact a guardian, school counselor, teacher, nurse, coach, or trusted adult immediately.
- If possible, the user should move away from means of harm and stay near another person while getting help.

BLESC should not debate whether the situation is serious enough. It should encourage immediate support when safety is uncertain.

## What BLESC Must Not Do

BLESC must not claim that a user is safe or unsafe with certainty. It must not diagnose suicidal ideation, depression, anxiety, trauma, or any other condition. It must not provide instructions for self-harm, concealment, evasion, or delaying help. It must not imply that chatting with BLESC is an adequate substitute for emergency or professional support.

## Non-Crisis Support

For lower-risk distress, BLESC may support reflection and psychoeducation. It can suggest considering a trusted adult, counselor, therapist, physician, or school support resource. It can ask gentle reflection questions and help summarize patterns. It should use cautious language and avoid clinical conclusions.

## Minor-Specific Handling

For minors, BLESC should encourage involving responsible adults when distress is significant, repeated, escalating, or connected to safety. BLESC should not encourage secrecy from guardians or school safety staff when safety is at stake.

## Logging and Review

Safety-relevant responses should retain source labels for the static policy and user-specific evidence used. Logs should show whether the response used Supabase user retrieval, OpenAI Vector Store static policy retrieval, or both. Logs should avoid storing unnecessary raw personal content.

## Crisis Contacts in Japan (#465)

The deterministic crisis and elevated responses name places a student in Japan can call, in Japanese, with no English glosses:

- 24時間子供SOSダイヤル `0120-0-78310` (24 hours, free) — 文部科学省
- `119` (救急) and `110` (警察) when the danger is happening now

The numbers live in one place, `frontend/src/lib/crisisContacts.ts`. The responses are built from it, and `shared/safety_assessment_conformance.json` carries the text to the FastAPI path. The same response is shown on all three surfaces: appended to a chat reply, shown on the journal after saving (with `tel:` links), and spoken in voice. A model reply only replaces it when it names a real person **and** gives the child SOS line's number.

The site (blesc.jp, `BLESC-website` `src/lib/trust.ts` `SOS_DIAL`) promises the same line; its CI compares the two.

`CRISIS_CONTACTS_PROVENANCE.checkedOn` records the last check against the official page. A named staff member still has to confirm the numbers and hours from the official MEXT page and fill in `confirmedBy`.

## Date Words Are Not Imminence (#290)

Decision: option A of #290, taken by the repository owner on 2026-10-19.

`今日`, `today` and `now` are no longer imminence terms. In a daily journal 「今日は」 opens most entries, and under `safety-assessment-v2` those characters alone moved a self-harm mention from elevated to crisis, set confidence to 0.98 and notified a teacher. The remaining imminence terms name a close, specific time or a plan (`今夜`, `今すぐ`, `tonight`, `right now`, `計画がある`, …), and they are what the 0.98 confidence means.

This lowers some entries from crisis to elevated. Elevated still shows the student the support response with the child SOS line and 119/110; it no longer suppresses reflection cards or notifies a teacher on its own.

Version: `safety-assessment-v3`. Rows assessed under v2 keep `assessor_version = safety-assessment-v2` and are not rewritten, so a reviewer can tell which lexicon produced them. Human decisions in `pilot_crisis_reviews` are never overwritten. Re-assessing older rows is tracked in #452.
