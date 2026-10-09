# Set up Agent Studio from your phone

About 20 minutes. Everything happens in your phone's browser: GitHub, Vercel, and the AI provider.
You never type into a terminal.

Keep these three values in your password manager as you create them. Do not paste them into chat,
issues, or screenshots.

## 1. Make your owner password (1 minute)

Use your password manager's generator to create a random string of 40 or more characters. Save it
as **APP_ACCESS_TOKEN**. This is how you sign in to the app.

## 2. Make a GitHub token that can touch only this repository (5 minutes)

1. Open github.com, tap your avatar, then **Settings**, **Developer settings**,
   **Personal access tokens**, **Fine-grained tokens**, then **Generate new token**.
   On a phone you may need to switch the browser to "Desktop site" to see these menus.
2. **Token name**: `agent-studio`. **Resource owner**: your account.
3. **Repository access**: **Only select repositories**, then choose `photo-edit`.
4. **Permissions** (repository):
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Actions: **Read**
   - Checks: **Read**
   - Metadata: **Read**
   Leave everything else as "No access".
5. Generate the token and copy it once. Save it as **GITHUB_TOKEN**.

Also set **GITHUB_REPOSITORY** to `Mehdi-6600/photo-edit`.

## 3. Get a free AI key (5 minutes)

Pick one. Both have free tiers. Check the provider's current limits before you rely on them.

**Option A: Google AI Studio (Gemini)**
1. Open aistudio.google.com, sign in with your Google account, and create an API key.
2. Set **LLM_API_KEY** to that key.
3. Set **LLM_BASE_URL** to `https://generativelanguage.googleapis.com/v1beta/openai`.
4. Set **LLM_MODEL** to a model name your AI Studio account lists as available.

**Option B: OpenRouter (free `:free` models)**
1. Open openrouter.ai, sign in, and create a key. Save it as **LLM_API_KEY**.
2. Set **LLM_BASE_URL** to `https://openrouter.ai/api/v1`.
3. Set **LLM_MODEL** to a model whose name ends in `:free` (browse openrouter.ai/models).

## 4. Create the Vercel project (5 minutes)

1. Open vercel.com, sign in with GitHub, then **Add New**, then **Project**.
2. Import **Mehdi-6600/photo-edit**.
3. Set **Root Directory** to `agent-studio`. This is the most important setting. Your existing
   photo-editor project stays separate.
4. Open **Environment Variables** and add the names below. Use the same names as in
   `.env.example`:
   - APP_ACCESS_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY
   - LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
   - Optional: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (step 5)
5. Tap **Deploy**.

## 5. Keep your runs safe (recommended, 5 minutes)

Without storage, runs live only in memory and can disappear when the server restarts.

1. Open upstash.com, create a **Redis** database on the free plan, and copy the **REST URL** and
   **REST token**.
2. Add them to Vercel as **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**, then redeploy.

## 6. Optional: production deploys and a live-site check

- **PRODUCTION_URL**: your live site address, for example `https://your-project.vercel.app`.
- **VERCEL_DEPLOY_HOOK_URL**: in Vercel, open the project, then **Settings**, **Git**,
  **Deploy Hooks**, and create a hook for your production branch. Treat the URL as a password.

Without a deploy hook, merging to the production branch still deploys automatically through the
Vercel Git integration. The app then checks the live URL.

## 7. Check the setup

1. Open your Vercel URL and sign in with APP_ACCESS_TOKEN.
2. Open **Setup**. Required items should show **Set**. Optional items can show **Not set**.
3. Open **GitHub**. You should see your account name and read and push access.

## 8. Start your first project

1. Open **Workspace**, describe a small idea in your own words, and tap **Analyze and plan**.
2. Read the plan, then tap **Start project run**.
3. Open **Live runs**. Tap **Run next step**, or **Run until attention needed**.
4. When the run asks for approval, open **Review** first. Only type **APPROVE** if the diff and
   checks look right. Type **DEPLOY** only after the merge and the production checks look right.

## If something stops

| Message you see | What to do |
|---|---|
| "AI model is not configured" | Check LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY in Vercel, then redeploy. |
| "GitHub is not connected" | Check GITHUB_TOKEN and GITHUB_REPOSITORY. |
| "The agent branch changed outside Agent Studio" | Review the branch on GitHub, then tap **Accept branch head**. |
| "No CI checks were reported" | Add a GitHub Actions workflow to the target repository. Copy `.github/workflows/agent-studio-ci.yml` and change `working-directory` to match the target project. Then tap **Retry failed step**. |
| "Merging is disabled" | Merge the pull request on GitHub, then tap **Run next step**. Set AGENT_STUDIO_ALLOW_MERGE=true only if you want the app to merge for you. |
| HTTP 429 from the model | The free quota is used up for now. Wait, or choose another model, then press Run again. |

Vercel's Hobby plan is for personal, non-commercial use. Check Vercel's current terms before you use
this for a paid product.
