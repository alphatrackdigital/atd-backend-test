# AlphaTrack Digital Backend Functions

Backend/API function layer for the AlphaTrack Digital website ecosystem.

## Runtime Roles

- GitHub source: `alphatrackdigital/atd-backend-test`
- Canonical integration branch: `main`
- Production backend target: Netlify project `alphatra-serv`
- Backend test target: Vercel project `atd-backend-test`
- Vercel test URL: `https://atd-backend-test.vercel.app`

The public cPanel frontend should call `alphatra-serv` for backend APIs. Vercel is
the test ground for backend changes and must not be treated as the production
backend. The separate Netlify frontend project remains a frontend-only test
target.

This repository carries equivalent Netlify and Vercel handlers so a change can
be verified on Vercel before the reconciled Netlify functions are promoted.

## Branch Role

`main` is the canonical integration branch for backend/API work in this
repository. Use short-lived feature branches and merge them into `main` only
after local validation and Vercel test verification.

Use this repository for:

- Blog API and blog admin
- Admin authentication
- Contact/leads function
- Contacts admin
- Brevo lifecycle and webhook functions
- MongoDB models and database helpers
- Netlify and Vercel function routing

Frontend website work belongs in `alphatrackdigital/alphatrackdigital`, not this
repository.

## Tech Stack

- Netlify Functions
- Vercel Functions
- TypeScript and JavaScript
- Mongoose and MongoDB
- Brevo, Meta Conversions API, and GA4 Measurement Protocol
- bcryptjs and jsonwebtoken

## Local Setup

```sh
git clone https://github.com/alphatrackdigital/atd-backend-test.git
cd atd-backend-test
npm install
npm test
npm run type-check
```

## Key Files

| Path | Purpose |
| --- | --- |
| `netlify/functions/` | Netlify serverless functions |
| `api/` | Equivalent Vercel serverless functions |
| `netlify/functions/auth.ts` | Admin authentication |
| `netlify/functions/blog.ts` | Public blog API |
| `netlify/functions/blog-admin.ts` | Blog admin API |
| `netlify/functions/leads.mjs` | Lead capture, attribution, CRM handoff, and Mongo persistence |
| `netlify/functions/brevo-subscribe.mjs` | Exit-popup and newsletter capture |
| `netlify/functions/brevo-meeting-webhook.mjs` | Strategy-call lifecycle and measurement |
| `netlify/functions/brevo-transactional-webhook.mjs` | Authenticated Brevo delivery events |
| `netlify/functions/contacts-admin.ts` | Contacts admin API |
| `netlify.toml` | Netlify routing |
| `vercel.json` | Vercel function configuration |

## Environment Variables

Use `.env.example` as the variable inventory. Store real values only in the
deployment platform; never commit secrets.

`META_GRAPH_API_VERSION` is optional and defaults to `v23.0`.
`META_CAPI_TEST_EVENT_CODE` is temporary: set it only during a controlled Meta
Test Events session, redeploy, verify, then remove it and redeploy again.

## Tracking Audit Release Gate

The Tracking Audit landing page is application-first. Do not release a frontend
that submits the canonical application payload until the corresponding backend
handler is live on `alphatra-serv`.

For a pre-production rehearsal, keep non-production Netlify deploys access-
controlled and use isolated QA persistence. Do not broaden or copy production
MongoDB, Brevo, or Meta credentials into preview contexts merely to make an E2E
check pass.

Before the backend release:

- verify Backend CI on the exact release head;
- verify the Vercel and Netlify Deploy Preview builds on the exact release head;
- use a dedicated QA MongoDB database for preview persistence;
- keep preview Brevo and Meta credentials absent unless dedicated test-safe
  credentials are available;
- prepare a controlled production canonical canary and downstream verification
  sequence for Brevo, MongoDB, transactional email, CRM review task, and Meta.

After the backend release, verify the production canonical application endpoint
before deploying the cPanel frontend. Keep paid campaign activation separate
from the website/backend release gate.

## Workflow

```sh
git checkout main
git pull origin main
git checkout -b feature/task-name
npm test
npm run type-check
```

Open a pull request back into `main`. Verify the Vercel test deployment before
promoting the same commit to Netlify production.

## Netlify

Current production backend project:

```text
alphatra-serv
```

Possible future name:

```text
alphatrackdigital-services
```

Rename only after branch bindings, environment variables, webhooks, frontend
endpoint overrides, and rollback references are inventoried. This project is the
backend/API service, not the public marketing website.