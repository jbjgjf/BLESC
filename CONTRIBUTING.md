# Engineering Rulebook

Lightweight but strict. Principles: small PRs, spec before code, someone always owns it, AI drafts — humans decide.

---

## 1. Branch Structure

**Naming:** `type/short-description` — lowercase, hyphenated.
```
feat/user-auth-login
fix/cart-total-rounding
chore/upgrade-eslint
spike/websocket-poc
```
Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `spike`

**When to branch:** Always, for any change — even a one-line fix. No exceptions.

**Direct push to `main`: forbidden.** Main is protected (require PR + 1 review + passing CI). No one, including the lead, pushes directly.

**Experimental/spike branches:** prefix `spike/`, max lifespan 3 days, never merged directly — if the spike works, cut a clean `feat/` branch and PR from that. Delete spike branches after.

---

## 2. Pull Request Rules

**Title format:** `[Type] Short imperative description` — matches branch type.
```
[Feat] Add login with email + password
[Fix] Correct cart total rounding error
```

**PR template:** see [`.github/pull_request_template.md`](.github/pull_request_template.md) — auto-filled when you open a PR on GitHub.

**Max PR size:** ~400 lines of diff (excluding lockfiles/generated code) or ~30 min to review. If bigger, split.

**Evidence required:**
- UI change → before/after screenshot or short screen recording
- Backend/API change → request/response log or curl output
- Bug fix → log/screenshot showing the bug, then showing it fixed
- Any change → test output (pass) pasted or linked to CI run

**When to split a PR:** touches >2 unrelated concerns, mixes refactor with feature, or reviewer can't hold the whole diff in their head in one pass. Split by layer (backend/frontend) or by step (schema → API → UI).

**Reviewers:** 1 approval required minimum. Rotate — don't let the same person always review the same author. Whoever owns the touched area (see ownership below) gets first look; if unavailable within the SLA, anyone else on the team can review.

**Merge criteria:** CI green + 1 approval + no unresolved blocking comments + AI Usage box filled in. Author merges their own PR after approval (squash merge, PR title becomes commit message).

---

## 3. Issue Structure

**Title format:** `[Area] Short description`
```
[Auth] Add password reset flow
[Bug] Cart total off by rounding on discounts
```

**Issue template:** see [`.github/ISSUE_TEMPLATE/issue.md`](.github/ISSUE_TEMPLATE/issue.md) — auto-filled when you open an issue on GitHub.

**Definition of Ready** (before someone picks it up):
- Acceptance criteria are written and unambiguous
- Owner assigned
- No open question blocking a start (if there is, resolve it in the issue first)

**Definition of Done:**
- Acceptance criteria all met
- Tests added, CI passing
- PR merged to main
- Demoed (see daily demo rule)

**Owner assignment:** one owner per issue, assigned at creation or in daily standup — never "whoever gets to it." Owner is accountable for the issue reaching Done, even if others help.

**Splitting large tasks:** if an issue needs >2 days or touches >2 layers (DB + API + UI), break it into a checklist of sub-issues, each independently mergeable and demoable. Rule of thumb: if you can't describe the acceptance criteria in 3 bullets, split it.

---

## 4. Commit Rules

**Format:** [Conventional Commits](https://www.conventionalcommits.org/) light version:
```
feat: add password reset endpoint
fix: correct rounding in cart total
chore: bump eslint to v9
refactor: extract auth middleware
```

**Frequency:** commit whenever you reach a working checkpoint — don't wait until the whole feature is done. Several small commits per PR is normal and preferred over one giant commit.

**Never commit:**
- `.env`, credentials, API keys, tokens
- `node_modules`, build output, IDE folders
- Commented-out dead code
- Debug `console.log`/`print` spam

**AI-generated code commits:** commit as normal — no special tag in the commit message. Disclosure happens at the PR level (AI Usage box), not per-commit.

---

## 5. AI Coding Rules

**How to use AI tools:** treat AI as a fast, occasionally-wrong junior engineer. Fine to ask it to: scaffold boilerplate, write tests, explain unfamiliar code, draft a first pass at a function, suggest refactors, write docs.

**Never blindly accept:**
- Auth, permissions, payment, or security-sensitive logic — read every line
- Anything touching database queries (SQL injection, missing indexes, N+1s)
- Dependency additions (check the package actually exists and is legitimate — AI hallucinates package names)
- Error handling that swallows exceptions silently
- Any code you can't explain if asked

**Rule of thumb:** if you can't explain *why* the AI wrote it that way, don't merge it — ask the AI to explain, or rewrite it yourself.

**Documenting AI usage in PRs:** fill in the AI Usage checkbox + a one-line note on what was asked and what you changed. This isn't bureaucracy — it tells the reviewer how hard to look.

**Reviewing AI-generated code:** review it exactly as hard as human-written code — harder, actually, since it can look confident and polished while being subtly wrong. No "AI wrote it so it's probably fine."

**Security risks to watch for specifically:**
- Hardcoded secrets or API keys "for now"
- Hallucinated/typosquatted npm packages
- Missing input validation/sanitization on user input
- Overly permissive CORS or disabled auth checks "to make it work"
- SQL built via string concatenation instead of parameterized queries

---

## 6. Code Review Rules

**Reviewers check:**
1. Does it meet the issue's acceptance criteria?
2. Correctness — logic, edge cases, error handling
3. Security (see above)
4. Tests exist and are meaningful (not just for coverage %)
5. Readability — could a teammate maintain this in 3 months?

**Blocking vs non-blocking:**
- **Blocking** (must fix before merge): bugs, security issues, missing tests for core logic, broken acceptance criteria
- **Non-blocking** (leave as comment, author's call): style nitpicks, "consider renaming," minor optimization ideas — prefix with `nit:`

**Speed:** first response within 4 business hours; full review same day. If you can't review in time, say so in the PR or standup — don't let it silently rot.

**Avoiding vague/personal comments:**
- Comment on the code, not the person: "this loop re-fetches on every render" not "you always forget memoization"
- Be specific and actionable: point to the line, suggest the fix or ask a concrete question
- No comment without a reason — "I don't like this" isn't feedback, "this will break when X is null" is

---

## 7. Testing & Quality Rules

**Minimum before merge:**
- New logic (non-trivial function, API route, business rule) → at least one test
- Bug fix → a test that reproduces the bug and proves the fix
- Pure UI tweaks (copy, styling) → manual verification is enough, no test required

**Manual QA checklist** (for anything user-facing):
- [ ] Happy path works
- [ ] Empty/loading/error states look right
- [ ] Works on mobile viewport if applicable
- [ ] No console errors

**Handling bugs:** file an issue with repro steps → fix on a branch → add a regression test → PR as normal. Don't hotfix on main.

**When to add automated tests:** anything touching money, auth, data integrity, or that has broken before. Skip heavy test-writing for pure prototypes/spikes.

**Verifying by layer:**
- **Frontend:** run it in the browser, check the states above, screenshot as evidence
- **Backend:** hit the endpoint locally (curl/Postman), check logs, verify DB state changed as expected
- **AI features** (LLM calls, agents, RAG): test with at least 3 varied inputs including an adversarial/edge one; log prompt + response in the PR; watch for cost/latency, not just "did it answer"

---

## 8. Project Structure

```
/src
  /components     # reusable UI components (PascalCase folders)
  /pages          # route-level views
  /api            # API route handlers
  /services       # business logic, external API clients
  /db             # schema, migrations, queries
  /ai             # prompts, AI client wrappers, agent logic
  /lib            # shared utils, helpers
  /types          # shared TS types/interfaces
/tests            # mirrors /src structure
/docs             # architecture, setup, API docs
/scripts          # one-off/dev scripts (seed data, migrations runner)
```

**Naming conventions:**
- Files: `kebab-case.ts`, components `PascalCase.tsx`
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Test files: `*.test.ts` next to the file they test, or mirrored in `/tests`

---

## 9. Documentation Rules

**Must be documented:** setup/onboarding, architecture overview, any non-obvious "why" decision, API contracts, env vars.

**Where:** `/docs` folder in-repo. Root `README.md` is the entry point (setup + link to `/docs`). Don't scatter docs in Slack/Notion where they rot — link out from there back into the repo.

**Keep it short:** one page per topic. If it's longer, it's probably two topics. Update docs in the same PR as the code change they describe — don't defer.

**Setup docs:** exact commands, copy-pasteable, assume a fresh machine. Test it on a clean clone before trusting it.

**Architecture docs:** one diagram + a few paragraphs on major components and why they're shaped that way — not a tour of every file.

**API docs:** endpoint, method, request/response shape, auth requirement, one example. Generate from code (OpenAPI/JSDoc) where possible instead of hand-maintaining.

---

## 10. Daily Workflow

**Standup format** (async in Discord/Slack, post by a fixed time e.g. 9:30am):
```
**Yesterday:** what shipped/progressed
**Today:** what you're working on
**Blockers:** none / [specific blocker + who can help]
```

**Daily demo:** anything merged that day gets a 1-line + screenshot/gif post in the team channel. No demo prep — just proof it works. Keeps "done" honest.

**Reporting blockers:** the moment you're stuck >30 min, post it — don't sit on it until standup. Tag whoever owns the area.

**Progress communication:** PR links and issue links, not prose recaps. Let the tools be the source of truth; chat is for flagging things that need a human now.

---

## 11. Emergency Rules

**Main is broken:** whoever notices reverts the offending commit/PR immediately (`git revert`, not force-push), posts in the team channel, then root-causes after main is green again. Don't debug on a broken main.

**Secrets leaked:** rotate the secret immediately (before anything else), then remove it from git history, then notify the team. Speed over ceremony — assume it's compromised the moment it's pushed.

**AI introduces a dangerous bug** (data loss, security hole, prod incident): revert first, ask questions later. Then: write up what happened in the issue/postmortem, note which AI Usage box was checked on that PR, and treat it as feedback for tightening rule #5, not a blame exercise.

**Final decision rights:** tech lead (or designated lead) has final call on anything time-sensitive or contested. Everything else is default-to-consensus among the 4; don't let disagreements block shipping — lead breaks ties.
