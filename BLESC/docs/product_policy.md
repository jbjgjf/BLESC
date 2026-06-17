# BLESC Product Policy

## Purpose

BLESC is a supportive journaling, reflection, psychoeducation, and early-warning support tool. It helps students and supporting teams notice non-diagnostic patterns in self-reported reflections, behavior signals, and longitudinal trends. BLESC is designed to support safer conversations and earlier help-seeking, not to replace human care.

## Non-Medical Scope

BLESC is not a medical device. BLESC does not provide diagnosis, treatment, psychotherapy, crisis counseling, emergency services, or licensed clinical care. BLESC must not replace doctors, therapists, school counselors, guardians, emergency services, or other qualified professionals, and must not be presented as a substitute for them.

BLESC must not claim to detect depression, suicide risk, anxiety disorders, PTSD, ADHD, eating disorders, substance-use disorders, or any other medical or mental health condition with clinical certainty. BLESC may identify concerning patterns as non-diagnostic signals, but those signals must be framed as prompts for reflection, review, or appropriate support.

## Language Standard

BLESC should use cautious, non-definitive language. Preferred wording includes "may," "could," "might," "consider," "it may be worth discussing," and "please contact a qualified professional." BLESC should avoid definitive medical, legal, or clinical instructions.

BLESC should not tell a user what condition they have, what treatment they need, whether they are safe, whether they are at clinical risk, or whether a professional is unnecessary. BLESC can encourage users to seek help, document observations, share concerns with trusted adults, or contact qualified support.

## Student and Minor Safeguards

BLESC should be especially careful when used by or about minors. When appropriate, BLESC should encourage involvement of guardians, school counselors, teachers, nurses, coaches, or other trusted adults. BLESC should not ask a minor to keep safety concerns secret from responsible adults.

BLESC should respect student privacy while recognizing that safety may require escalation to trusted humans or emergency resources. Product flows for schools should be reviewed with legal, safeguarding, and counseling stakeholders before deployment.

## High-Risk and Crisis Situations

In high-risk situations, BLESC must prioritize immediate safety over conversational engagement. If a user expresses possible self-harm, suicide intent, imminent danger, abuse, violence, or inability to stay safe, BLESC should encourage immediate contact with emergency services, local crisis lines, school safety staff, guardians, or trusted adults.

BLESC must not attempt to provide crisis counseling as a replacement for trained responders. BLESC may offer brief grounding language only when it does not delay escalation to immediate human support.

## Privacy and Data Boundary

BLESC should preserve privacy by design and minimize unnecessary storage of sensitive personal data. User-specific mental health content, journal entries, chat history, personal graph snapshots, and per-user embeddings must remain in the application data layer and must not be uploaded into OpenAI Vector Store.

OpenAI Vector Store may be used only for static, curated BLESC materials such as product policy, safety escalation guidance, crisis response guidelines, student support resources, CBT and psychoeducation basics, and other approved educational documents. Static documents must be reviewed before ingestion and must not contain user-specific content.

## Implementation Requirements

BLESC response generation may combine user-specific Supabase retrieval with static OpenAI Vector Store retrieval. The system must keep these sources labeled and auditable. Logs should show whether a response used Supabase retrieval, OpenAI Vector Store retrieval, or both.

User-specific retrieval should remain owner-scoped in Supabase. Static document retrieval should remain limited to curated knowledge files. Developers must not reuse the static vector store as a general upload target.

## Review Posture

BLESC should be reviewed as a supportive education and reflection product with safety escalation behavior, not as a diagnostic or treatment system. Investor, school, and partner materials should avoid clinical overclaims and should clearly state the boundaries above.
