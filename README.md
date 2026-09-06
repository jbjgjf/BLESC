# BLESC

BLESC is a Japanese journaling application that helps participants record daily experiences and turns those records into a personal, time-aware knowledge graph. It is being prepared for a research pilot with high-school students; it is **not ready for participant enrollment**.

The working application is [blesc.online](https://blesc.online). The source of truth for pilot delivery is the [Pilot Launch Project](https://github.com/users/jbjgjf/projects/2).

## What is in this repository

| Area | Location | Purpose |
| --- | --- | --- |
| Web application | [`sentra/frontend`](sentra/frontend) | Next.js app for participants, educators, and research workflows. |
| Processing service | [`sentra/backend`](sentra/backend) | FastAPI service for graph extraction and analysis. |
| Database | [`sentra/supabase`](sentra/supabase) | Supabase schema and migrations. |
| Evaluation tools | [`sentra/eval`](sentra/eval) | Synthetic evaluation provisioning and test runs. |
| Specifications | [`sentra/docs`](sentra/docs) | Research, safety, architecture, deployment, and operating documentation. |

## Pilot status

The intended pilot is **50 students × 21 days**: 14 baseline days followed by 7 days of post-baseline observation, for at most 1,050 diary entries.

Enrollment must not begin until every [pilot blocker](https://github.com/jbjgjf/BLESC/issues?q=is%3Aopen%20label%3Apilot-blocker) is resolved and verified in a dry run. The five defects that blocked it first — consent, durable storage, telemetry, follow-up answers and research text retention — were fixed in [#138](https://github.com/jbjgjf/BLESC/pull/138) and are closed.

What remains is tracked as [Epic #161](https://github.com/jbjgjf/BLESC/issues/161), which ends at a 10-participant × 3-day dry run on production-equivalent infrastructure:

1. [#164](https://github.com/jbjgjf/BLESC/issues/164) — force information, participant assent and guardian verification from `/pilot/join`.
2. [#165](https://github.com/jbjgjf/BLESC/issues/165) — collection-only mode and fixed self-ratings, with no third-party transmission.
3. [#166](https://github.com/jbjgjf/BLESC/issues/166) — dedicated Vercel and Supabase, and the staged rollout of #138.
4. [#167](https://github.com/jbjgjf/BLESC/issues/167) — pseudonymised export, PII review and operational monitoring.
5. [#168](https://github.com/jbjgjf/BLESC/issues/168) — the dry run itself, and a recorded Go/No-Go.

[#162](https://github.com/jbjgjf/BLESC/issues/162) — the protocol, the collection inventory and the consent document — is a human decision and is not something this repository can mark done.

The operating decision, task order, and dry-run criteria are in [Discussion #137](https://github.com/jbjgjf/BLESC/discussions/137).

## Start locally

### Demo only

The demo needs no login, API key, Supabase project, or backend service.

```bash
cd sentra/frontend
npm install
npm run dev
```

Open [http://localhost:3000/demo](http://localhost:3000/demo). It uses fixed data and does not prove that login, diary persistence, AI responses, or research data collection work. See the [demo and release gate](sentra/docs/demo_and_release_gate.md) before presenting it.

### Development with real data

Use separate Supabase and OpenAI projects for development or evaluation. Do not use real participant data in the demo environment.

1. Copy the frontend environment template and set the Supabase URL and publishable/anon key:

   ```bash
   cd sentra/frontend
   cp .env.example .env.local
   ```

2. Apply the migration in [`sentra/supabase/migrations`](sentra/supabase/migrations) to the intended Supabase project. Enable email/password authentication.

3. Start the frontend:

   ```bash
   npm install
   npm run dev
   ```

4. To run the optional FastAPI service, configure `sentra/backend/.env.local` with its own `OPENAI_API_KEY`, then:

   ```bash
   cd ../backend
   pip install -r requirements.txt
   USE_MOCK_LLM=false python -m uvicorn app.main:app --reload --port 8000
   ```

For the complete service setup, see [`sentra/README.md`](sentra/README.md). Never commit `.env.local`, API keys, service-role keys, or participant data.

## Verify a change

```bash
cd sentra/frontend
npm run lint
npm test
npm run build

cd ../backend
python -m pytest tests -q
```

The [Research Contracts workflow](https://github.com/jbjgjf/BLESC/actions/workflows/research-contracts.yml) runs the project checks in GitHub Actions. A production release also requires the human checks in the [release gate](sentra/docs/demo_and_release_gate.md).

## How we work in GitHub

| Use | Place | Expected outcome |
| --- | --- | --- |
| Define executable work | [Issues](https://github.com/jbjgjf/BLESC/issues) | One owner, acceptance criteria, and a next action. |
| Plan and track delivery | [Projects](https://github.com/users/jbjgjf/projects/2) | Update status, priority, phase, and blockers. |
| Record decisions | [Discussions](https://github.com/jbjgjf/BLESC/discussions) | Link the decision to affected Issues. |
| Review and merge code | [Pull requests](https://github.com/jbjgjf/BLESC/pulls) | Include `Closes #…`, evidence, and passing CI. |
| Maintain shared orientation | [Wiki](https://github.com/jbjgjf/BLESC/wiki) | Keep short entry points; keep versioned technical detail in `sentra/docs`. |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. In particular, work from a branch, do not push directly to `main`, and include evidence appropriate to the change.

## Further reading

- [研究エンジン：設計・数学解説・7チームの72時間計画](https://github.com/jbjgjf/BLESC/wiki/Research-Engine) — implementation proposal; the 72-hour target is a synthetic research prototype, separate from participant enrollment.

- [Research pipeline](sentra/docs/research_pipeline.md)
- [Participant temporal graph](sentra/docs/participant_temporal_graph.md)
- [Synthetic evaluation](sentra/docs/synthetic_evaluation.md)
- [Educator oversight](sentra/docs/educator_oversight.md)
- [Vercel deployment](sentra/docs/deployment_vercel.md)
