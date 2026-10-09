# Agent research: ranked shortlist and team decisions

Researched on **2026-10-09**. Data lives in `data/agents.json`; `npm run registry:verify` re-checks
the maintenance fields against GitHub. Every claim below was read from a repository's own metadata,
README, LICENSE, or package registry, or is labelled as not verified.

## Method

1. **Repository facts** from the GitHub REST API: license (SPDX), archived flag, last code push,
   latest release, open issues. Stars were recorded for context and are **not** used in ranking.
2. **Interface facts** from each project's README and docs, then confirmed where possible by
   installing the CLI from PyPI or npm in the build sandbox and reading its `--help` output.
3. **Free-use facts** from the project's own text about model providers and from the official
   pages of the providers involved (Google's OpenAI-compatibility page, OpenRouter's rate-limit page,
   Vercel's limits page, GitHub's Actions billing page). Third-party summaries are labelled as such.
4. **Integration verification levels**:
   - `installed-and-checked`: the CLI was installed and its flags were read with `--help`.
   - `docs-only`: the claim comes from the project's README or docs.
   - `not-verified`: only repository metadata was checked.

Verified on this machine: `aider-chat` 0.86.2 and `mini-swe-agent` 2.4.6 installed from PyPI with
their flags confirmed. Not run: any agent against a real model, because the sandbox could not reach
model providers.

## Free-use classes

- **A.** Free software: OSI-approved license, no paid license required.
- **B.** Free model weights: open weights you can download and run locally. Check each model's license.
- **C.** Free inference: requests served at no charge, for example your own machine.
- **D.** Free hosting: a platform tier that hosts the app or runs CI at no cost, within limits.
- **E.** Free tier with quotas: a paid provider's free allowance with rate or daily limits.

## Team-membership rule

The score ranks the candidates. Team membership, shown as **active**, **optional**, or **excluded**,
is a decision made on top of the score, using these gates:

1. OSI-approved license, not archived, last code push within 365 days.
2. A zero-cost path exists: class B, C, or E is available and the tool does not require a paid plan.
3. An unattended interface is documented (`cli-headless`).
4. Integration evidence is at least `docs-only`.
5. No Docker or GPU requirement for the default team.

A candidate that passes all five gates is **active** only if it is the chosen option for a role.
Each role has one active option, except review, which has two on purpose: Gemini CLI (hosted free
tier) and Qwen Code (can run on a local model). A reviewer that uses a different provider from the
coder gives the review more independence. A candidate that passes the gates but duplicates an active
option stays **optional**. Examples: Open Interpreter and Kilo Code pass the gates, but debugging and
coding already have active options. Cline, goose, and opencode fail gate 4 because their headless
interfaces were not checked. OpenHands fails gate 5 because it needs Docker.

The score does not measure reliability or coding ability directly, because no benchmark was run.
That is why some optional candidates score higher than active ones.

## Ranked shortlist (score out of 100)

Score = maintenance (30) + release recency (10) + zero-cost path (up to 25) + integration and
verification (up to 20) + coding capability (15) − heavy-setup penalty (up to −10). Excluded entries
are not scored.

| Rank | Score | Status | Agent | License | Last push | Latest release | Free-use | Integration verification | Role(s) |
|---:|---:|---|---|---|---|---|---|---|---|
| 1 | 95 | **active** | mini-swe-agent | MIT | 2026-10-06 | v2.4.6 (2026-07-23) | A B C E | installed-and-checked | debugging |
| 2 | 87 | optional | Cline | Apache-2.0 | 2026-10-09 | desktop-v0.0.45 (2026-10-08) | A B C E | not-verified | frontend, backend |
| 3 | 87 | optional | goose | Apache-2.0 | 2026-10-09 | v1.54.0 (2026-10-08) | A B C E | not-verified | debugging |
| 4 | 87 | optional | Open Interpreter | Apache-2.0 | 2026-10-07 | rust-v0.0.56 (2026-10-07) | A B C E | docs-only | debugging |
| 5 | 87 | **active** | Qwen Code | Apache-2.0 | 2026-10-09 | sdk-typescript-v0.1.18 (2026-10-05) | A B C E | docs-only | review |
| 6 | 80 | optional | OpenHands | MIT | 2026-10-09 | v1.26.0 (2026-10-08) | A B C E | docs-only | backend, frontend |
| 7 | 77 | **active** | Gemini CLI | Apache-2.0 | 2026-10-08 | v0.63.0 (2026-10-06) | A E | docs-only | review |
| 8 | 77 | optional | Kilo Code CLI | MIT | 2026-10-08 | jetbrains/v7.1.9 (2026-10-08) | A E | docs-only | frontend, backend |
| 9 | 77 | optional | opencode | MIT | 2026-10-09 | v1.18.35 (2026-10-06) | A B C E | not-verified | frontend, backend |
| 10 | 72 | **active** | Aider | Apache-2.0 | 2026-05-22 | v0.86.0 (2025-08-09) | A B C E | installed-and-checked | frontend, backend |
| 11 | 71 | optional | Continue | Apache-2.0 | 2026-10-08 | v2.0.0-vscode (2026-06-19) | A B C E | not-verified | frontend |
| 12 | 71 | optional | SWE-agent (full) | MIT | 2026-10-06 | v1.1.0 (2025-05-22) | A B C E | not-verified | debugging |
| 13 | 67 | optional, paid | OpenAI Codex CLI | Apache-2.0 | 2026-10-09 | rust-v0.162.0 (2026-10-08) | A only | docs-only | frontend, backend |
| 14 | 65 | optional (library) | CrewAI | MIT | 2026-10-08 | 1.15.26 (2026-10-08) | A C E | docs-only | none |
| 15 | 65 | optional (library) | smolagents | Apache-2.0 | 2026-10-06 | v1.26.0 (2026-05-29) | A C E | docs-only | none |
| 16 | 46 | optional | MetaGPT | MIT | 2026-01-21 | v0.8.1 (2024-04-22) | A B C E | docs-only | architect |
| 17 | 32 | optional | ChatDev | Apache-2.0 | 2026-07-24 | v2.2.0 (2026-03-23) | A only | docs-only | architect |
| — | — | excluded | Agentless | MIT | 2024-12-22 | v1.5.0 (2024-10-29) | | | |
| — | — | excluded | AutoCodeRover | not detected by GitHub | 2025-04-24 | v1.1.0 (2024-09-10) | | | |
| — | — | excluded | AutoGen | CC-BY-4.0 (GitHub field) | 2026-04-15 | python-v0.7.5 (2025-09-30) | | | |
| — | — | excluded | Claude Code | Proprietary (© Anthropic PBC) | 2026-10-08 | v2.1.295 | | | |
| — | — | excluded | GPT Pilot | FSL-1.1-MIT (source-available) | 2026-06-18 | none | | | |
| — | — | excluded | gpt-engineer | MIT | archived | v0.3.1 (2024-06-06) | | | |
| — | — | excluded | Plandex | MIT | 2025-10-03 | cli/v2.2.1 (2025-07-16) | | | |
| — | — | excluded | Roo Code | Apache-2.0 | archived (2026-05-15) | v3.54.0 (2026-05-15) | | | |

Verification notes for the table:
- **mini-swe-agent**: `mini --task … --model … --yolo --cost-limit … --output …` confirmed from the installed package.
- **Aider**: `aider --message … --yes-always --no-auto-commits --model … --file …` confirmed from the installed package. Its latest release is older than its last push, so its maintenance score is lower than mini-swe-agent's.
- **Gemini CLI**: the README states a free tier of 60 requests per minute and 1,000 per day with a personal Google account, and documents `gemini -p "…"`. Quotas can change.
- **Qwen Code**: the README documents headless use with `qwen -p "…"` and support for local models through Ollama or vLLM.
- **OpenAI Codex CLI**: the README says use requires a ChatGPT paid plan or an API key, so it is **not zero-cost** and sits outside the team.
- **ChatDev**: its README requires API keys in `.env`, and it runs in Docker. It is a reference design for role collaboration, not an execution engine.

## Why each exclusion

- **Roo Code**: the repository is archived on GitHub.
- **gpt-engineer**: the repository is archived on GitHub.
- **Claude Code**: its LICENSE.md is proprietary (© Anthropic PBC) and subject to commercial terms. It is not open source and needs a paid plan.
- **GPT Pilot**: its LICENSE is FSL-1.1-MIT, which is source-available, not OSI open source, during the non-compete period. GitHub reports the license as NOASSERTION.
- **AutoCodeRover**: GitHub cannot detect a license, and there has been no push since 2025-04-24.
- **Agentless**: research code with no push since 2024-12-22.
- **Plandex**: no push since 2025-10-03, more than 12 months ago.
- **AutoGen**: GitHub reports CC-BY-4.0, a content license. The software license was not verified, so it stays out until verified.

## Role mapping (12 logical roles)

| Role | Served by | Adapter type | Verified agents for the role (informational) |
|---|---|---|---|
| Project manager | Built-in planner, or the configured model | deterministic (model optional) | — |
| Research | Configured free model | model | — |
| Software architect | Configured free model | model | — |
| UI/UX | Configured free model | model | — |
| Frontend | Model patch adapter committing to the agent branch | model | Aider (active, installed-and-checked) |
| Backend | Model patch adapter committing to the agent branch | model | Aider (active, installed-and-checked) |
| Code review | Deterministic diff scanner, plus the configured model | model + deterministic | Gemini CLI, Qwen Code (active, docs-only; not wired) |
| Testing | GitHub Actions CI on the agent branch | GitHub CI | — |
| Debugging | Model patch adapter reading CI and review output | model | mini-swe-agent (active, installed-and-checked; not wired) |
| DevOps | GitHub API for pull requests and merges; Vercel deploy hook and URL check | GitHub API | — |
| Localization | Configured free model, reviewing English and Persian coverage | model | — |
| Independent auditor | Separate model call that judges requirements against the diff | model | — |

Reuse rules: one configured model serves several roles, but each role uses its own prompt and its
own run step. The auditor is a separate call with a stricter prompt. Running a different provider
for the auditor would make it more independent; the UI does not enforce that yet. Agents are not run
on every task: each step runs only when its dependencies have succeeded.

## Environment and feasibility (build sandbox, 2026-10-09)

- Reachable: `api.github.com`, `github.com`, `registry.npmjs.org`, `pypi.org`.
- Not reachable: Vercel, Hugging Face, OpenRouter, Groq, and GitHub Models endpoints. Live model
  calls and Vercel deployment could not be tested from here.
- Node 22.22.3 needs `--use-system-ca` to verify GitHub's certificate on this network.
- No Docker, no browser binary from the public internet. The phone-width screenshots used a
  Chromium build packaged on npm, with its NSS libraries extracted from the package.

## Not verified (and why it matters)

- Reliability and coding quality of any model on these tasks: no benchmark or live run.
- Current Gemini and OpenRouter free-tier quotas: change often; confirm in each console.
- Qwen Code's and Gemini CLI's current free-tier terms: verify before use.
- Cline, goose, opencode, Continue, and SWE-agent CLI flags: not installed, so not confirmed.
- Vercel function duration on Hobby: third-party summaries report 300 seconds; not confirmed on
  Vercel's own pages in this build.

## Sources

- Repository metadata and LICENSE/README files: GitHub REST API (`api.github.com/repos/…`) for each
  repository in `data/agents.json`.
- PyPI: `aider-chat` 0.86.2 and `mini-swe-agent` 2.4.6 (installed and `--help` read).
- npm: `@google/gemini-cli` 0.63.0, `@qwen-code/qwen-code` 0.25.0, `@kilocode/cli` 7.8.8, `opencode-ai` 1.18.35.
- Google Gemini API, OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- OpenRouter, API rate limits: https://openrouter.ai/docs/api_reference/limits
- Vercel, limits: https://vercel.com/docs/limits
- GitHub, Actions billing: https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions
- GitHub, fine-grained personal access token permissions: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
