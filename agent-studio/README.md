# Agent Studio

A mobile-first control room that turns a plain-language idea into a reviewed pull request, using
open-source AI coding agents, GitHub, and Vercel. Everything runs on free tiers or free software.

This app lives in `agent-studio/` inside the `photo-edit` repository. The existing root app
(the browser-only "Still" photo editor) is unchanged.

- Mobile-first, English and Persian (Persian uses right-to-left layout).
- Owner-only workspace behind a token. Agents never write to the default branch.
- Merges and production deploys stop for a typed approval (`APPROVE`, `DEPLOY`).

## What it does, step by step

1. **Describe** the project in plain language (English or Persian).
2. **Plan**: the project manager produces requirements with acceptance criteria, assumptions, and at
   most three essential questions. It is labelled as *built-in planner* or *AI planner* on screen.
3. **Start a run**. Each run follows a fixed, reviewed workflow of 15 steps, shown in the app. A
   debugging step runs only when a check or review fails:
   research → architecture → mobile flows → backend → frontend → localization check → CI checks
   → code review and secret scan → independent requirement audit → pull request →
   **your approval** → merge → **your approval** → deploy → production check.
4. **Isolation**: work happens on a dedicated `agent/<name>-<id>` branch. Each change is one Git
   commit made through the GitHub Git Data API. Writes to the default branch are refused in code.
5. **Checks**: GitHub Actions runs on the agent branch (see `.github/workflows/agent-studio-ci.yml`).
   Failing checks start a bounded debugging loop (at most 3 fix attempts).
6. **Review**: the diff, CI results, findings, and approvals are shown on the run's Review tab.
7. **Merge and deploy** only after your typed approval. Merging is off unless
   `AGENT_STUDIO_ALLOW_MERGE=true`; otherwise merge on GitHub yourself and press Run.

## Verification status (read this first)

| Area | Status |
|---|---|
| Unit tests (61) | Passing: `npm test` |
| Lint, type check, production build | Passing locally and in GitHub Actions |
| Real GitHub flow (branch, commit, CI, pull request, approval gate) | **Verified** with an opt-in test against the real GitHub API. The test stands in a local mock model for the LLM; the branch, pull request and CI run were real. The pull request and branch were closed and deleted afterwards. |
| Real LLM output quality | **Not verified.** The build sandbox could not reach any model provider. Results depend on the model you choose. |
| Vercel deployment and live production URL | **Not verified** from the build sandbox (no Vercel access). The deploy hook and URL check are implemented and tested with mocks. |
| Aider and mini-swe-agent execution in CI | **Documented, not wired.** Their CLI flags were checked by installing them; a CI runner that executes them is not implemented in this version. Code changes come from the model patch adapter. |

## Quick start (local)

Requirements: Node.js 22.12 or newer, npm, and a GitHub token (optional for planning only).

```bash
cd agent-studio
cp .env.example .env.local      # then edit values; never commit this file
npm ci
npm run dev                     # http://localhost:3000
```

Checks:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

End-to-end test against real GitHub (opt-in, creates and then deletes a test branch and pull request):

```bash
E2E_GITHUB=1 GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name E2E_BASE_BRANCH=<branch-with-ci> npx vitest run tests/e2e
```

Behind some corporate proxies Node cannot verify GitHub's TLS certificate. Run with
`NODE_OPTIONS=--use-system-ca` in that case.

## Deploy on Vercel

1. In Vercel, create a **new project** from this repository. Set **Root Directory** to `agent-studio`.
   The framework is detected as Next.js. Keep your existing photo-editor project separate.
2. Add environment variables (Project → Settings → Environment Variables). Names are in
   `.env.example`. At minimum set `APP_ACCESS_TOKEN`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and a
   model (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`).
3. Redeploy, then open the site, sign in with `APP_ACCESS_TOKEN`, and check **Setup**.

Step-by-step phone instructions are in [docs/SETUP-MOBILE.md](docs/SETUP-MOBILE.md).

## Configuration reference

| Variable | Needed for | Notes |
|---|---|---|
| `APP_ACCESS_TOKEN` | Sign-in | 32+ characters. Rotating it signs everyone out. |
| `GITHUB_TOKEN` | All code and PR steps | Fine-grained, one repository only. See permissions below. |
| `GITHUB_REPOSITORY` | All code and PR steps | `owner/name`. The Owner can also change it in the GitHub screen. |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | Planning with AI, writing code, review, audit | Any OpenAI-compatible Chat Completions endpoint. HTTPS required (plain HTTP is accepted only for `localhost`). |
| `LLM_TIMEOUT_MS` | Model calls | Default 45000. |
| `AGENT_ALLOWED_PATHS` | What agents may change | Default: `app/,components/,lib/,src/,tests/,test/,docs/,public/,agent-studio/,README.md`. |
| `AGENT_STUDIO_ALLOW_MERGE` | Merging | Default `false`. |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Deployment list | Read-only status. |
| `VERCEL_DEPLOY_HOOK_URL` | Production deploy | Secret. Used only after `DEPLOY` is typed. |
| `PRODUCTION_URL` | Production check | Public HTTPS URL. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Persistent runs | Recommended on Vercel. Without them, runs live in memory and can be lost. |
| `AGENT_STUDIO_DATA_DIR` | Local file storage | Default `.data` (git-ignored). Not used on Vercel. |

### GitHub token (least privilege)

Create a **fine-grained** personal access token that can access **only** your repository, with:
Contents (read and write), Pull requests (read and write), Actions (read), Checks (read), and
Metadata (read). Do not use a classic token with `repo` scope. Do not give it access to other
repositories. Agents cannot change workflow files: the path policy refuses `.github/` changes.

### Model configuration (free options)

Pick one, check its current limits in its own console, and put the values in the environment.

| Option | `LLM_BASE_URL` | Notes (checked 2026-10-09) |
|---|---|---|
| Google AI Studio (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai` | Google documents this OpenAI-compatible endpoint, used with a key from AI Studio. Free-tier availability and limits change; third-party trackers reported roughly 10–15 requests per minute and 250–1,500 per day, varying by model. Confirm in AI Studio. Google's free-tier terms allow prompts to be used to improve its products, so do not send confidential code. |
| OpenRouter `:free` models | `https://openrouter.ai/api/v1` | Models whose ID ends in `:free`. OpenRouter's rate-limit documentation covers free-model limits and a daily count returned by `GET /api/v1/key`. Third-party summaries report about 20 requests per minute and 50 per day, rising to 1,000 per day after a lifetime $10 purchase. Free models can be busy and return 429. |
| Ollama on your own computer | `http://localhost:11434/v1` | Free inference on your hardware. **Not reachable from Vercel**, so use it only with a local run of this app. |

Groq and other providers with a free tier also work if they offer an OpenAI-compatible endpoint.
Verify each provider's current terms before use.

## Agents: what is installed, and how

Agent Studio keeps a **verified registry** of 25 candidate agents (`data/agents.json`): 4 active
team members, 13 optional, and 8 excluded. Each entry
records license, last push, latest release, free-use classes (A–E, below), integration
verification level, risks, and evidence links. The full ranked shortlist and the reasons for
inclusion and exclusion are in [docs/RESEARCH.md](docs/RESEARCH.md). The Team screen shows which
roles are served by which agent and what has actually run.

Free-use classes: **A** free software · **B** free model weights · **C** free inference (for example
your own machine) · **D** free hosting · **E** free tier with quotas.

Team status meanings (shown on the AI team screen):
- **Available**: the role's agent is verified in the registry. Nothing is configured yet.
- **Configured**: the credentials or settings the role needs are present on the server.
- **Executed**: at least one task for the role finished successfully with evidence in a run.

How agents are used:
- **Code changes** (frontend, backend, debugging): a model patch adapter asks the configured free
  model for complete file contents, validates each path against the allow-list, refuses secret-like
  text, and commits the result to the agent branch.
- **Checks**: GitHub Actions. Nothing runs on your phone or on the production server.
- **Review and audit**: deterministic scanner (secrets, protected paths, risky APIs), plus the
  model in a separate prompt. The auditor judges each requirement against the diff.
- **Installing agents for CI**: not wired in this version. Aider and mini-swe-agent are documented
  and their flags were checked (`aider --message … --yes-always --no-auto-commits`,
  `mini --task … --yolo`). A runner that executes them on an isolated CI job is the next step.

## Security model

- **Owner access only.** `APP_ACCESS_TOKEN` is compared in constant time. The session cookie is
  HMAC-signed with a key derived from the token, expires after seven days, and is `httpOnly`,
  `SameSite=Strict`, and `Secure` over HTTPS. Every API route checks the session, and `proxy.ts`
  guards pages. Login attempts are rate-limited (5 per 15 minutes per client).
- **CSRF**: state-changing requests must be JSON from this site (`Origin` must match the host).
- **Secrets stay on the server.** The GitHub token, model key, Vercel token, and deploy hook are read
  from environment variables and never sent to the browser. Error text and stored events are
  redacted for known token shapes and for exact secret values. The Setup screen shows only whether
  each variable is set.
- **Least-privilege GitHub**: one repository, branch-only writes to `agent/*`, no writes to the
  default branch, `force: false` commits (no silent overwrites).
- **Path policy**: repository paths are checked for traversal, absolute paths, control characters,
  and protected files (`.github/`, `.env*`, lockfiles, binaries, keys). Patches are limited to six
  files and 60 KB each.
- **Prompt injection**: repository files, failure logs, diffs, and the idea text are passed as
  quoted data and the system prompts say to ignore instructions inside them. Model output is
  validated against a schema and the path policy before anything is committed. The model cannot
  add workflow steps or run commands.
- **Untrusted code runs only in GitHub Actions**, on a disposable runner, never on the production
  server. Keep the Actions secrets for models in a protected environment if you add an agent runner.
- **Approval gates**: merge needs `APPROVE`; production deploy needs `DEPLOY`. Both are recorded with
  time and actor in the run's approval log.
- **Timeouts and limits**: model calls time out after 45 seconds by default (retried twice on rate
  limits or server errors); GitHub calls time out after 15 seconds; URL checks after 15 seconds;
  runs are limited to 3 debugging attempts and to one step per request.
- **Audit log**: sign-ins, run actions, approvals, repository changes, registry changes, deploy
  checks, and deploy hook calls are recorded (last 500 entries).
- **Production URL checks** accept only public HTTPS addresses. Private, loopback, and
  link-local addresses are refused, which prevents the server from being used to probe its network.
- **Known limits**: rate limiting is per server instance, so it is best-effort on serverless
  platforms. Use a free Upstash database to keep runs across restarts.

## Free-tier limits you will hit

| Service | Limit (source) |
|---|---|
| Vercel Hobby | 100 deployments per day, 45-minute build, one concurrent build, 5 deploy hooks per project, 1-hour runtime log retention ([Vercel limits](https://vercel.com/docs/limits)). Third-party summaries describe Hobby as personal, non-commercial use; confirm Vercel's current terms before using it for a paid product. |
| GitHub Actions | Standard GitHub-hosted runners are free in public repositories ([GitHub docs](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)). Private repositories get a monthly quota. |
| Upstash Redis | Free plan reported as 256 MB and 500,000 commands per month (third-party listings; confirm on upstash.com). |
| Gemini API free tier | Varies by model and changes over time. Check AI Studio. |
| OpenRouter `:free` | About 20 requests per minute; daily cap as described above. |

A successful run makes about eight model calls (research, design, mobile flows, backend, frontend,
localization, review, audit), plus one planner call if a model is configured, plus retries and any
debugging rounds. Plan for that on daily free quotas.

## Known limitations

- A plan is only as good as the model you configure. Without a model, planning uses a built-in
  planner and code steps stay blocked, with the reason shown.
- The model patch adapter rewrites whole files. It works best for small, focused changes. Large
  refactors should be split into several runs.
- Each run is single-owner. There are no per-user accounts or roles.
- Live GitHub status (the "re-check GitHub" button in the registry) uses the public API. Without a
  token it is limited to 60 requests per hour.
- Screens were checked at phone width (390 px) with a headless browser. They have not been tested
  on physical devices.
- No Vercel deployment was verified from the build sandbox. Confirm the production URL check in the
  Deploy screen after your first deploy.
- The registry scores are a documented ranking, not a benchmark. No coding-quality benchmarks were run.

## Project layout

```
proxy.ts                 owner session gate (pages and API)
app/                     pages (workspace, runs, team, github, deploy, registry, setup) and API routes
components/              client UI (bilingual, RTL-aware)
lib/engine.ts            the delivery state machine and step executors
lib/planner.ts           heuristic and model-based planner (labelled)
lib/workflow.ts          the fixed 16-step task graph and approval phrases
lib/github.ts            GitHub REST client (Git Data API, checks, pulls, compare)
lib/model.ts             OpenAI-compatible client with timeouts and JSON extraction
lib/store.ts             memory, file, and Upstash REST stores with optimistic versions
lib/security.ts          sessions, rate limits, redaction, path and branch guards
data/agents.json         verified agent registry (evidence, classes, verification level)
tests/                   unit tests and the opt-in GitHub end-to-end test
scripts/verify-registry.mjs   re-check registry maintenance data against GitHub
docs/RESEARCH.md         ranked shortlist, evidence method, role mapping
docs/SETUP-MOBILE.md     setup steps for a phone
```
