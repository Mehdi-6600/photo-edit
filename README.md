# Agent Studio

Agent Studio is the primary application in this repository. It turns a plain-language software idea into a requirements plan, a GitHub branch with reviewed model-generated changes, CI results, and a pull request. The root Next.js application is deployed by the existing repository/Vercel connection; no separate project or nested app directory is required.

## What is operational

- **Idea intake and planning:** a deterministic built-in planner works without an AI key. If configured, an OpenAI-compatible model improves the plan and can ask clarification questions. The owner can answer those questions and re-run planning before starting.
- **Implementation:** the app uses a constrained model-patch adapter. It asks the configured model for complete file contents, validates paths and content, then commits through GitHub's Git Data API to a dedicated `agent/*` branch. It does not run model-generated shell commands on the web server.
- **Checks and review:** GitHub Actions runs checks on the branch. Agent Studio polls the check runs, presents the diff and evidence, and uses deterministic secret/path checks plus a separate model review and requirements audit.
- **Pull requests:** the app opens or reuses a pull request after checks and review. Merge requires the exact `APPROVE` phrase; a configured Vercel deploy hook requires `DEPLOY`. If the existing Vercel Git integration automatically deploys the production branch on merge, `APPROVE` also precedes that Git-triggered deployment; the separate `DEPLOY` gate cannot delay it.
- **Repository connection:** the app validates the GitHub token and selected repository. Setting `GITHUB_REPOSITORY=owner/name` locks runs to that repository; without it, the owner can choose a repository reachable by the token in the GitHub screen.
- **English and Persian:** the interface is mobile-first, changes direction for Persian, and includes English/Persian UI copy.

## Agent and tool honesty

The agent registry is a researched catalogue of public coding agents and tools, including licensing, maintenance evidence, runtimes, authentication needs, risks, and adapter status. Registry entries marked **documented** or **not wired** are not executed by this deployment. In particular, Aider, mini-swe-agent, Gemini CLI, and other listed command-line agents are not launched by Agent Studio.

The workflow currently uses one configured model endpoint for its planning, implementation, review, and audit prompts; these are role-specific model calls, not separate third-party agent processes. Testing is performed by the target repository's GitHub Actions. No generated code or arbitrary shell command runs on the production server. Running CLI agents requires a separately configured, isolated runner and model credentials; it is not currently part of this Vercel app. See [the research notes](docs/RESEARCH.md) for the evaluation and [setup guide](docs/SETUP-MOBILE.md) for configuration.

## Quick start

Requirements: Node.js 22.12 or newer and npm.

```bash
npm ci
cp .env.example .env.local
# Edit .env.local with your own values; never commit it.
npm run dev
```

Open the URL printed by Next.js. Set a random `APP_ACCESS_TOKEN` of at least 32 characters, then use the same value on the sign-in screen. For local work, configure a GitHub token and repository to enable code changes; configure an OpenAI-compatible model endpoint to enable model-backed planning and implementation. Planning still works with the built-in planner if no model is configured.

Useful commands:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run registry:verify
```

The opt-in end-to-end test creates a real branch and pull request on the explicitly configured test repository, then closes/deletes them. Use only a disposable test repository and a least-privilege token:

```bash
E2E_GITHUB=1 GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name E2E_BASE_BRANCH=<branch-with-ci> npx vitest run tests/e2e
```

## GitHub configuration

Use a fine-grained token limited to one repository where possible. Minimum permissions for the complete GitHub flow:

- Metadata: read
- Contents: read and write (branch and commit APIs)
- Pull requests: read and write
- Actions: read
- Checks: read

`GITHUB_REPOSITORY=owner/name` is a server-side repository lock. When set, the repository selector cannot redirect the app to a different repository. Agent Studio never writes to the repository's default/base branch; it uses a fresh `agent/*` branch and non-forced ref updates. The path allow-list and protected-path checks are enforced on every model patch. The app's GitHub permission check is read-only; it does not create a test branch or pull request just to probe write scopes. GitHub account push access is shown separately from token write scopes, which cannot be safely introspected without attempting a real write.

## Model configuration

Any OpenAI-compatible Chat Completions endpoint can be used, including a self-hosted Ollama endpoint, Google AI Studio, or OpenRouter. Provider quotas, data policies, authentication requirements, and model availability can change; check the provider's current terms. The model connectivity check sends one short, explicit test prompt and reports only the configured model name and latency—not the raw response or credentials.

Repository content and the project idea may be sent to the configured model provider during planning, implementation, review, and audit. Do not use a provider for private code unless its data terms are acceptable to you. The app never sends GitHub or Vercel credentials to the model.

## Vercel deployment

This app is now at the repository root, matching the normal Vercel project root and the existing root-level Git connection. The root `vercel.json` specifies the Next.js framework and `npm ci`; the root `package.json` runs the Agent Studio build. No project replacement or new Vercel import is needed.

Before redeploying the existing Vercel project, confirm **Project Settings → Build and Development Settings → Root Directory** points to the repository root (shown as `.` or blank), not the former `agent-studio` subdirectory. Keep the existing Git connection and environment variables. If the Vercel project is configured with a nested root, change only that setting to the repository root, then redeploy. The current live Vercel project configuration and production URL were not accessible from this repository workspace, so a production deployment is **not claimed as verified**.

For serverless persistence, set both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without them, Vercel uses in-memory storage and runs may disappear when an instance restarts. Optional `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` list deployments. `VERCEL_DEPLOY_HOOK_URL` enables the deploy-hook action after the `DEPLOY` gate; `PRODUCTION_URL` enables the HTTP check. The hook gate does not control Vercel's separate Git-triggered production builds.

See [.env.example](.env.example) for every supported variable and [docs/SETUP-MOBILE.md](docs/SETUP-MOBILE.md) for a phone-friendly walkthrough.

## Security and operational limits

- Owner-only access uses a signed, `httpOnly`, `SameSite=Strict` session cookie and a rate-limited login. Mutating APIs require same-origin JSON.
- GitHub, model, Vercel, and Upstash credentials stay server-side. Status screens return presence flags, not values. Errors, run events, review patches, and audit evidence are redacted before display/storage.
- Model output is untrusted. File paths, file count, size, protected areas, and secret-like strings are checked before commits. The model cannot alter workflow files, dependency lockfiles, environment files, or execute shell commands on the app server.
- A merge requires `APPROVE`; automated merging additionally requires `AGENT_STUDIO_ALLOW_MERGE=true`. `DEPLOY` gates only the configured Vercel deploy hook. If Vercel's existing Git integration builds the production branch on merge, that deployment may start after `APPROVE` and before the later `DEPLOY` gate. Disable/adjust Vercel Git production builds and rely on the hook if you require a separate deploy approval; verify that setting in Vercel.
- A persistent Upstash store provides optimistic run-version checks. Without Upstash, local development uses `.data/` files and Vercel uses ephemeral memory.
- Treat agent branches and Vercel Preview builds as untrusted code. Keep production credentials scoped to Production only; Next.js builds can execute project code before merge. See [security notes](docs/SECURITY.md).
- The opt-in GitHub e2e test is skipped in normal CI. A live Vercel deploy, real external model quality, and third-party CLI execution are not verified by unit tests.

## CI

GitHub Actions runs lint, TypeScript, unit tests, and the production build on pushes and pull requests. The opt-in live GitHub test remains disabled unless `E2E_GITHUB=1` is explicitly supplied.
