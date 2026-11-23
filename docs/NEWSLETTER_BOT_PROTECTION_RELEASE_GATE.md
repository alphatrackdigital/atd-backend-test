# ATD newsletter anti-bot release gate (staged)

**Status:** REVIEW ONLY. Do not turn on production enforcement until both backend and static frontend are deployed and validated. Owner sign-off required. Applies to the `newsletter` source of `/api/leads` only.

## Evidence

On 2026-11-23, Netlify `alphatra-serv` request telemetry showed 9 successful POST requests to `/api/leads`, from 9 different client addresses (6 DE, 2 NL, 1 US), all with the same macOS Chrome 142 user agent and referrer `https://alphatrack.digital/`. Multiple addresses independently appear on Tor exit-node listings. These indicators strongly suggest automation, but individual subscribers must not be removed without validation.

`BREVO_DOI_TEMPLATE_ID` in Netlify production was read as `0` (disabled). The currently published email-notification fix removed only per-signup staff notifications; it did not stop contact creation.

## Changes in this branch

- Optional server-side Cloudflare Turnstile verification **before Brevo, MongoDB, CRM, or Meta CAPI calls**. Only `source: "newsletter"` is affected.
- Feature flag: `TURNSTILE_NEWSLETTER_REQUIRED=true`. Default is **off**, preserving all existing production behavior until deliberate activation.
- Secret: `TURNSTILE_SECRET_KEY`, **Netlify secret setting**, server-side only. Never commit it or put it in a `VITE_` variable.
- Optional comma-separated `TURNSTILE_ALLOWED_HOSTNAMES`; defaults to `alphatrack.digital,www.alphatrack.digital`. Siteverify must return `success=true`, exact action `newsletter_signup`, and an allowed hostname.
- Missing/expired/invalid/replayed verification fails before writes. Unavailable server secret/verification service fails closed, not silently open.
- Configured but invalid Brevo double-opt-in no longer falls back to direct capture (which would silently subscribe an unconfirmed address).
- Contact form and tracking audit continue independently. Exit-popup `/api/brevo-subscribe` is not covered by this change.

## Safe rollout sequence

1. Review matching frontend PR in `alphatrackdigital/atd-website`. Create a **free** Cloudflare Turnstile widget with managed challenge for the `alphatrack.digital` and `www.alphatrack.digital` hostnames; use action `newsletter_signup`. Validate Ketch consent/CMP classification for Turnstile loading.
2. Populate frontend **public** `VITE_TURNSTILE_NEWSLETTER_SITE_KEY` in the real static build configuration. Populate Netlify backend `TURNSTILE_SECRET_KEY` with the widget's **private** secret; ensure functions can read it. Do not send the secret over chat or commit it.
3. Run CI and preview contract tests, including absent/fake/wrong-hostname/replayed tokens, Siteverify timeouts, genuine valid tokens, legitimate contact/audit source flow, duplicate/idempotency behavior, and no staff signup emails.
4. Deploy backend implementation while `TURNSTILE_NEWSLETTER_REQUIRED` is unset/false; verify 9 functions and deployed SHA. Deploy verified static frontend to cPanel/Namecheap with public sitekey and check rendering on all pages where the newsletter section appears, including mobile.
5. In a real browser, verify widget completed, token posted, CSP permits `challenges.cloudflare.com`, Ketch consent behavior remains acceptable, and no unexpected errors. At this point backend is still open to old clients.
6. Deliberately enable `TURNSTILE_NEWSLETTER_REQUIRED=true` on **production** Netlify site, triggering any required rebuild/redeploy. Verify malicious/missing tokens return HTTP 403 without any Brevo/Mongo/CRM/Meta writes; valid tokens reach the intended list. Monitor function logs and real newsletter conversion rates.
7. Separately configure an **active** Brevo newsletter DOI template and redirect, test with owned addresses, then change production `BREVO_DOI_TEMPLATE_ID` from 0 only after the DOI flow is proven. Confirm unconfirmed addresses are not added to active marketing lists. Avoid unsolicited test messages to real people.
8. Rollback: switch `TURNSTILE_NEWSLETTER_REQUIRED` off if genuine signups fail (requires re-deploy if applicable), restore previous static build or backend commit as appropriate. Re-enable only after QA. Preserve evidence.

## Safety constraints

- No country-based, Tor-wide, or brittle user-agent bans.
- No automatic deletion of Brevo contacts or overwriting of consent evidence.
- No production deployment in this PR without explicit owner approval and release verification.
- Do not disable or modify Ketch CMP, privacy requests, or mandatory compliance alerts to stop digest email reminders.
