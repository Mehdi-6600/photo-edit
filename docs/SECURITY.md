# Security notes

## Treat agent branches and previews as untrusted

Model-produced source is untrusted until a human has inspected the complete diff. The workflow writes only to a dedicated `agent/*` branch, runs repository CI, and requires the owner to type `APPROVE` before merging. Automatic merging is disabled by default. Do not treat a model review or a green CI result as a replacement for a human review of authorization, secrets, dependencies, build scripts, and deployment configuration.

The existing Vercel Git integration may build pull-request branches as Preview deployments. A Next.js build can execute project code, including during prerendering. In the existing Vercel project's Environment Variables, scope production credentials to **Production only**. Do not expose the production `APP_ACCESS_TOKEN`, GitHub write token, model key, Vercel token/deploy-hook URL, or production Upstash credentials to Preview or Development builds. If previews need credentials, use separate low-privilege test values and a disposable database. The `DEPLOY` phrase gates only the configured deploy hook; it cannot stop a Git-triggered Preview or a production deployment that Vercel starts after a merge.

The app does not run model-generated shell commands. It sends project text, allow-listed repository snippets, and sanitized CI/review output to the configured model provider; do not submit code or plans the provider is not allowed to receive.

## Server-side URL checks

The production verifier only checks `PRODUCTION_URL` from server configuration; request bodies cannot select an arbitrary host. It permits public HTTPS hostnames, refuses common private/local/IP-literal addresses, caps response reading, and does not follow redirects. DNS answers are not pinned to a validated IP for the connection, so configure only a hostname you control and trust. Deploy-hook requests are restricted to the Vercel integration endpoint. Redis credentials are sent only to a root HTTPS endpoint on `*.upstash.io`, and redirects are not followed.

## Dependency audit (2026-10-09)

- `npm audit --omit=dev` reports **0 vulnerabilities** in production dependencies.
- Full `npm audit` reports **4 high-severity, development-only** findings in the lint dependency chain: `@next/eslint-plugin-next@16.3.8` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3`. The reported `braces` issue is a denial of service from deeply nested patterns. These packages are used by ESLint, not shipped in the production dependency set.
- The suggested `@next/eslint-plugin-next@14.2.35` downgrade was compatibility-tested with the repository's ESLint 10 setup: linting fails because the old plugin calls the removed `context.getCwd()` API. That downgrade also leaves two high findings through its old `glob` dependency. It was not retained. The current Next.js 16 plugin remains aligned with Next.js 16; no compatible patched transitive version was available in the npm registry at the time of this check.

Re-run `npm audit` after dependency updates. Do not silence the audit with an incompatible plugin downgrade or an unreviewed dependency override. Reassess this exception when the upstream Next.js lint plugin or its dependency chain publishes a compatible fix.
