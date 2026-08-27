# AGENTS.md — ATD Backend

This repository is the canonical backend/API test and integration source for AlphaTrack Digital.

## Development authority

- GitHub is the source of truth and PR integration boundary.
- Work on isolated feature branches/worktrees; do not push directly to `main`.
- Local Codex and Codex Cloud must not independently own the same source branch at the same time.
- Local → Cloud handoff requires relevant tests, commit, push and exact SHA checkpoint.
- Codex Cloud may use a synthetic `work` branch with no raw Git remote; verify repository/source branch plus exact starting SHA.
- Return Cloud changes through Codex Cloud's native **Create PR** flow.
- When continuing an existing feature branch, the Cloud PR must target that feature branch, not `main`.

## Provider boundaries

- GitHub CI is the first backend validation gate.
- Vercel Hobby project `atd-backend-test` is a deliberate runtime/UAT target only.
- Netlify project `alphatra-serv` remains the current production backend.
- Codex Cloud usage does not authorize provider migration or production promotion.
- Do not spend Vercel build capacity on source-only changes when CI is sufficient.

## Secrets and data

- Never commit or echo production secrets, Brevo keys, MongoDB credentials, Meta tokens, webhook secrets, auth secrets or client data.
- Prefer GitHub/provider secret stores.
- Cloud tasks default to no production secrets.
- If a runtime test requires a secret, use least privilege and the narrowest environment/branch scope possible.
- Do not paste secret values into prompts, issues, PRs or logs.

## Testing

Before integration, run:

```bash
npm install --ignore-scripts --package-lock=false
npm test
npm run type-check
```

For lead capture, tracking, auth, webhook or CRM changes, add the relevant targeted regression/E2E checks.

A Vercel preview/runtime test is required only when provider-hosted behavior cannot be proven from CI/local tests.

## Tracking Audit / CRM guardrails

- Preserve the canonical frontend ↔ backend application contract.
- Preserve consent, attribution, source, event identity and deduplication semantics.
- Do not activate campaign spend or claim launch readiness from backend CI alone.
- Backend release/promotion remains coordinated with frontend/Brevo E2E and the campaign launch gate.

## Production guardrails

Do not perform or authorize without separate explicit approval:

- Netlify production promotion;
- Vercel/Netlify project recreation or migration;
- DNS/custom-domain changes;
- production secret rotation/expansion;
- destructive MongoDB operations;
- campaign activation;
- bypassing PR/CI/runtime gates.

## Hybrid handoff

Record repository, source branch, exact SHA, current/next execution owner, checks already run, remaining scope, runtime requirement, secret requirement and provider restrictions.

Do not hand off uncommitted local-only work.
