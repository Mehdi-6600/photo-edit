# Set up Agent Studio from your phone

Agent Studio now lives at the repository root and is the intended primary application. Keep using the existing `Mehdi-6600/photo-edit` GitHub repository and Vercel project; do not create a replacement project.

Keep generated credentials in a password manager. Do not paste them into chat, issues, screenshots, or commits.

## 1. Set owner access

Create a random password-manager value of at least 32 characters and save it as `APP_ACCESS_TOKEN`. This is the private workspace sign-in value. Rotating it signs out existing sessions.

## 2. Create a least-privilege GitHub token

1. In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set repository access to **Only select repositories**, then choose `photo-edit`.
3. Grant only these repository permissions:
   - **Metadata**: Read
   - **Contents**: Read and write
   - **Pull requests**: Read and write
   - **Actions**: Read
   - **Checks**: Read
4. Leave workflow and organization administration permissions off. Save the token as `GITHUB_TOKEN`.
5. Set `GITHUB_REPOSITORY` to `Mehdi-6600/photo-edit`. This locks the app to that one repository. If you deliberately omit it, the owner can select another repository accessible to the token in the GitHub screen.

Agent Studio uses a read-only permission probe. It does not make a fake branch, commit, or pull request to test write scopes. The `push` permission shown by GitHub describes the account's repository role; the actual token write permission is tested only when you explicitly start a project run.

## 3. Configure a model endpoint

Choose an OpenAI-compatible endpoint and check its current pricing, quotas, authentication requirements, and data terms. A self-hosted Ollama endpoint is a no-paid-provider option when the Agent Studio server can reach that machine; `localhost` on Vercel points to Vercel, not your phone.

Set:

- `LLM_BASE_URL` (for example, `https://generativelanguage.googleapis.com/v1beta/openai` or `https://openrouter.ai/api/v1`)
- `LLM_MODEL` (a model name currently available to your account)
- `LLM_API_KEY` (if required by the provider)

The Setup screen has a button that sends one short connectivity request. It reports only the model name and response time, not the raw reply or credentials. The configured provider receives project text and repository snippets during planning/review/code generation; avoid sending private code to a provider whose data terms you have not accepted.

## 4. Point the existing Vercel project at the root app

1. Open the existing Vercel project connected to `Mehdi-6600/photo-edit`.
2. Under **Settings → Build and Development Settings**, set **Root Directory** to the repository root (`.` or blank). Do not set it to `agent-studio`; that subdirectory has been removed.
3. Keep the existing Git repository connection and normal Next.js build settings. The root `vercel.json` uses `npm ci`; the root `package.json` builds Agent Studio.
4. Keep existing environment variables, add the new values above, and redeploy the project when the reviewed main-branch changes are ready.

The live Vercel project settings and production URL could not be inspected from the source workspace. A live deployment is not claimed as verified by this guide. Treat agent branches and Preview builds as untrusted code: scope production credentials to **Production only**, and use separate low-privilege Preview values if they are needed. See the [security notes](SECURITY.md).

## 5. Add durable storage (recommended)

Without a persistent store, Vercel uses in-memory storage and runs may disappear when an instance restarts.

1. Create an Upstash Redis database.
2. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the existing Vercel project's environment variables.
3. Redeploy and confirm Setup reports `upstash` storage.

## 6. Optional deployment diagnostics

- `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` allow the Deploy screen to list deployments. `VERCEL_TEAM_ID` is needed only for team-scoped projects.
- `VERCEL_DEPLOY_HOOK_URL` is optional. Treat it as a secret. Triggering this hook is behind the `DEPLOY` gate. That gate does not control a separate Vercel Git build triggered by merging into the production branch; `APPROVE` authorizes the merge and therefore comes before that automatic deploy. If you require `DEPLOY` to be the sole production approval, configure Vercel to skip automatic production-branch builds and verify that the deploy hook still works. The live Vercel settings were not available to verify here.
- `PRODUCTION_URL` is the public HTTPS site checked after deployment.
- Automatic merging is disabled by default. Keep `AGENT_STUDIO_ALLOW_MERGE=false` unless you explicitly want the app to merge approved PRs. The owner approval phrase is required either way.

## 7. Verify access and start a small project

1. Open the existing Vercel URL and sign in with `APP_ACCESS_TOKEN`.
2. In **Setup**, run the model connectivity check.
3. In **GitHub**, run the read-only access checks and confirm the configured repository is correct. The checks cover token authentication, repository/contents read, Actions, Checks, pull-request read, and the account's push role.
4. In **Workspace**, describe a small idea. Review the plan and answer clarification questions before starting if needed.
5. The run creates an `agent/*` branch and shows each step, CI result, diff, evidence, and pull request. Inspect the **Review** screen and GitHub PR before typing `APPROVE` or `DEPLOY`. If Vercel builds the production branch automatically, the approved merge may start that deployment before the later `DEPLOY` gate; see step 6 above.

The workflow uses a configured model patch adapter, GitHub Actions, and the GitHub API. Registry entries for Aider, mini-swe-agent, Gemini CLI, and other open-source CLIs are research candidates; this Vercel deployment does not launch those CLIs. See the [runtime limitations and research](RESEARCH.md).

## If something stops

| Message | Next step |
|---|---|
| Owner access is not configured | Set `APP_ACCESS_TOKEN` (32+ random characters) in the existing Vercel project and redeploy. |
| The repository lock is invalid | Set `GITHUB_REPOSITORY` to a valid `owner/name`, for example `Mehdi-6600/photo-edit`. |
| No model is configured | Set `LLM_BASE_URL`, `LLM_MODEL`, and (if required) `LLM_API_KEY`, redeploy, then run the connectivity check. |
| GitHub read check fails | Review the fine-grained token's repository selection and read permissions. |
| Account push permission is missing | Grant the token owner appropriate write access, then re-run the check. The API check itself never creates a write probe. |
| A branch changes outside Agent Studio | Review the branch on GitHub; only then use **Accept branch head**. |
| No CI checks were reported | Add a GitHub Actions test workflow to the target repo; do not skip the checks. Retry after the workflow exists. |
| Merging is disabled | Merge the PR manually on GitHub, or explicitly enable `AGENT_STUDIO_ALLOW_MERGE=true` after reviewing the security implications. |
| Runs disappear after a restart | Configure both Upstash REST variables and verify the storage status. |
