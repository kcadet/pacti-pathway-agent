# PACTI Pathway Agent — HVAC exploration demo

Standalone, **synthetic-data** hackathon demo for the Nebius × NVIDIA Global AI Hackathon (Best Apps and Agents).
Ported from the public reference branch `CadEduKit/pacti-pathway-agent@nvidia-nebius-hvac-demo` (draft PR #1): the local Node server was replaced by a TanStack Start server function running on the edge runtime. Not connected to the production PACTI app or any real participant data. No affiliation with or endorsement by NVIDIA or Nebius is implied.

**Live demo:** https://pacti-pathway.lovable.app

## How NVIDIA Nemotron is used (via Nebius Token Factory)
- The "Generate HVAC plan with NVIDIA" button calls a server-side function that posts to Nebius Token Factory's OpenAI-compatible `chat/completions` endpoint (`https://api.tokenfactory.nebius.com/v1/`) with the NVIDIA Nemotron model `nvidia/nemotron-3-super-120b-a12b` (configurable via `NEBIUS_MODEL`).
- The request asks for a structured JSON plan (summary, fitReasons[], exactly 4 weeks, mentorQuestions[]) with `response_format: { type: "json_object" }`, `temperature 0.2`, a 4,000-token output cap, and `chat_template_kwargs: { enable_thinking: false }` so the full output budget goes to the plan instead of chain-of-thought.
- The API key lives only in server-side secrets; the browser never sees it. Redirects are refused, requests time out at 45s, and responses are capped at 100 KB.

## How Token Factory accelerated development
- One OpenAI-compatible endpoint meant the demo could call a 120B-parameter NVIDIA Nemotron model with a plain `fetch` — no SDK, no GPU infrastructure, no model hosting.
- The OpenAI-compatible shape let us reuse standard request/response handling and switch models with a single env var.
- Reported token usage per call feeds directly into the demo's server-side spending ceiling, so cost control came almost for free.

## Judge access
1. Open the live demo URL above and create an account with any email + password.
2. Plan generation is restricted to approved accounts (server-side allowlist). Email the demo owner (see the Devpost submission) with the email you used, and your account will be added to the approved list.
3. Until approved, you can still sign in and see the interface; generation returns a clear "not approved" message without consuming the shared budget.
4. Limits: 5 generations per account per UTC day, 40 demo-wide per day, 150,000-token demo-wide daily budget. Counts reset at 00:00 UTC.

## What it does
- Fixed synthetic profile: Maya, Erie PA. One pathway: HVAC exploration.
- "Generate HVAC plan with NVIDIA" calls Nebius Token Factory (OpenAI-compatible `chat/completions`) with an NVIDIA Nemotron model, server-side only.
- Output is validated (summary, fitReasons[], exactly 4 weeks with action + known sourceIds[], mentorQuestions[]); anything else is rejected with an explicit error. There is **no demo fallback**.
- Shows model, timestamp, latency, and provider-reported token usage. Cost is not calculated.
- Single controlled source snapshot: `onet-hvac` (O*NET 49-9021.00, reviewed 2026-10-01). No live retrieval, no local vacancies, providers, wages or credentials.
- Guardrails: plans that name a school, provider or employer are rejected and regenerated once (maximum one retry), then shown as an explicit error. The name check has two layers: (1) names ending in words like College, School, Inc. or Services, or union locals; (2) suffix-free proper-noun runs — two or more capitalized words that are not on a small allowlist (HVAC, Maya, Erie, County, PA, EPA, …), e.g. "Penn State Behrend", "Johnson Controls" — plus mid-sentence words with inner capitals ("McKinstry"). The model is told to write in sentence case so ordinary text does not trip layer 2.
- The same validation runs on saved plans: a browser-saved plan that names an organization or carries an unsupported citation is refused on save and on reload.
- **Automated name detection cannot guarantee complete coverage.** It misses single-word names ("Trane", "Carrier"), lowercase or stylized names, and names starting a sentence followed by a lowercase word. It can also flag legitimate Title Case text. Mentor review of every plan stays required.
- Each week has an uncited recommendation, and optionally an occupation fact. Only facts within the O*NET evidence keep the `onet-hvac` citation; other citation tags are removed and counted.
- Plans can be saved/reloaded in **browser localStorage only**, with schema validation and storage-error feedback.

## Setup
1. Add `NEBIUS_API_KEY` in Lovable → Project Settings → Secrets. Never put it in chat, code, or `VITE_` vars.
2. Optional: `NEBIUS_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`; must match `nvidia/*nemotron*`) and `NEBIUS_BASE_URL` (default `https://api.tokenfactory.nebius.com/v1/`; only HTTPS `api.tokenfactory[.region].nebius.com/v1/` accepted).
3. Requests are sent with `redirect: "error"`, a 45s timeout, and a 100 KB response cap. The endpoint accepts only `{}` or `{ "profile": "synthetic-maya" }` (≤256 bytes).

### Environment variables (server-side only, no values included in this repo)
| Variable | Required | Purpose |
| --- | --- | --- |
| `NEBIUS_API_KEY` | yes | Nebius Token Factory API key (server secret) |
| `NEBIUS_MODEL` | no | Model override, default `nvidia/nemotron-3-super-120b-a12b` |
| `NEBIUS_BASE_URL` | no | Endpoint override, default `https://api.tokenfactory.nebius.com/v1/` |
| `HVAC_USER_DAILY_CALLS` | no | Per-user daily call limit (default 5) |
| `HVAC_PROJECT_DAILY_CALLS` | no | Demo-wide daily call limit (default 40) |
| `HVAC_DAILY_TOKEN_CEILING` | no | Demo-wide daily token budget (default 150,000) |
| `HVAC_RESERVE_TOKENS_PER_CALL` | no | Tokens reserved per call (default 5,500) |
| `HVAC_USER_CONCURRENT` / `HVAC_PROJECT_CONCURRENT` | no | Concurrency caps (defaults 1 / 3) |

## Tests
`bunx vitest run` — covers config/endpoint validation, missing key, provider HTTP/timeout/redirect/non-JSON errors, plan validation, token reporting, usage limits (retries, ceilings, concurrency), repeated-fact removal, and localStorage persistence (round-trip, tampered data, storage failure). Type check: `bunx tsgo --noEmit` (or `tsc --noEmit`).

## Access and usage limits (server-side)
- Plan generation requires a signed-in account (email + password). The server function rejects requests without a valid session before any limit check or model call.
- Limits are stored in the database, so they survive refresh, sign-out and server restarts. Users can read only their own usage rows and cannot write them; all writes go through server-only database functions under one lock.
- Every model call counts, including the one automatic retry. Defaults (override with server env vars):
  - `HVAC_USER_DAILY_CALLS` = 5 per user per UTC day
  - `HVAC_PROJECT_DAILY_CALLS` = 40 demo-wide per UTC day
  - `HVAC_DAILY_TOKEN_CEILING` = 150,000 tokens demo-wide per UTC day
  - `HVAC_USER_CONCURRENT` = 1, `HVAC_PROJECT_CONCURRENT` = 3 (stuck runs expire after 3 minutes)
  - `HVAC_RESERVE_TOKENS_PER_CALL` = 5,500 (cannot be set lower)
- **Spending ceiling is a token budget, not a dollar amount.** Nebius does not return a price, so each call reserves 5,500 tokens (prompt plus the 4,000-token output cap) before it runs. The reservation is replaced by Nebius's reported total; if usage is not reported or the call fails, the full reservation stays charged.
- Request input is limited to `{}` or `{ "profile": "synthetic-maya" }` (≤256 bytes).
- Repeated occupation facts are shown only once; later weeks keep their uncited recommendation.

## Known limitations
- Automated organization-name detection cannot guarantee complete coverage: it misses single-word names ("Trane", "Carrier"), lowercase or stylized names, and names at the start of a sentence followed by a lowercase word. Mentor review of every plan stays required.
- The spending ceiling is a conservative token budget, not an exact dollar cost — Nebius does not return prices.
- Approving a new tester requires a manual database insert; there is no admin screen.
- Anyone can create an account (sign-up is open); only generation is gated by the approved list.
- The O*NET snapshot is static (reviewed 2026-10-01); there is no live retrieval of local training, vacancies, wages or funding.
- The usage count on the page refreshes after each attempt, but a plan in flight in another tab is not reflected until that attempt ends.

## Before any public release
Review the limit values, consider email-domain restrictions for sign-up, and confirm Nebius billing alerts. Keep the project unpublished until then.

See `docs/demo-outline.md` for the 3-minute demo script.

## Approved accounts
Only accounts listed in the `hvac_approved_users` table can generate plans. The check runs inside the database functions that start a run and reserve each call, so unapproved accounts get `LIMIT_NOT_APPROVED` before Nebius is called and never touch the shared budget. Add a tester by inserting their user id into that table.

## License
MIT — see [LICENSE](LICENSE). Third-party packages keep their own licenses (see package.json); the O*NET snapshot is U.S. Department of Labor public-domain data.
