# Devin Superset IssueOps

Event-driven automation that turns a labeled GitHub issue into an autonomous
[Devin](https://devin.ai) remediation session against a fork of Apache Superset.

---

## 1. What this is

`devin-superset-issueops` is a small, Dockerized orchestration service. When a
GitHub issue is opened or labeled with `devin-remediate`, the service:

1. Receives the event (real GitHub webhook **or** a local simulation endpoint).
2. Creates a tracked **workflow** record.
3. Builds a focused remediation prompt for the issue.
4. Programmatically starts a **Devin session** via the Devin v3 API.
5. Persists the session id / link and exposes workflow status and metrics.

Devin is instructed to check out the `master` branch, implement the
smallest safe fix, add targeted tests, run them, and open a **draft PR**.

## 2. Why this matters

Engineering teams accumulate a long tail of small, well-scoped bugs that are
easy to describe but expensive to context-switch into. This service shows how an
**event → agent → PR** loop can be automated end-to-end while staying
observable:

- A labeled issue is the only human input required.
- Every triggered workflow is tracked with a status and a Devin session link.
- An engineering leader can glance at `/metrics` to see throughput, success
  rate, and how much work is in flight vs. done vs. failed.

## 3. Architecture

This is a **webhook-driven, multi-agent** pipeline. A single GitHub issue flows
through two distinct Devin agents:

```
 issue (labeled devin-remediate)        PR opened/updated            PR comment with marker
        │ issues webhook                 │ pull_request webhook        │ issue_comment webhook
        ▼                                ▼                             ▼
 startIssueWorkflow(issue)        handlePullRequestEvent()      handleIssueCommentEvent()
        │                                │                             │
        ├─ createWorkflow()              ├─ match workflow by branch/  ├─ match workflow by PR/
        ├─ buildRemediationPrompt()      │  PR url / issue number      │  issue number
        └─ createDevinSession()          ├─ store PR metadata          └─ ISSUEOPS_* marker →
            → Remediation Agent          └─ createDevinSession()           ready_for_review /
                                             → Validation Agent             validation_failed /
                                                                            needs_human_review
        └──────────────────────── all state persisted to .data/workflows/<id>.json ──────────────┘
                                   observable via GET /workflows and GET /metrics
```

Event chain: **issue → remediation agent → PR → validation agent → validation result**.

- **Express** HTTP service (ESM + TypeScript).
- **File-based store** under `.data/workflows` — one JSON file per workflow, no
  database required for the demo.
- **Devin v3 API** client for session creation / status. The remediation agent
  and the validation agent are **separate Devin sessions**.

Key files:

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Env parsing/validation with zod |
| `src/prompts.ts` | `IssueInput` / `ValidationPromptInput` types + remediation & validation prompt builders |
| `src/devin.ts` | Devin v3 API client (`createDevinSession`, `getDevinSession`) |
| `src/store.ts` | File-based workflow persistence, finders, and metrics |
| `src/index.ts` | Express app, webhook dispatcher, and shared `startIssueWorkflow` helper |

## 4. Setup

```bash
npm install
cp .env.example .env
# edit .env and fill in DEVIN_API_KEY, DEVIN_ORG_ID, GITHUB_OWNER
```

## 5. Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP port |
| `GITHUB_OWNER` | **yes** | — | GitHub username/org that owns the Superset fork |
| `GITHUB_REPO` | no | `superset` | Repository name |
| `GITHUB_TARGET_BRANCH` | no | `master` | Branch Devin should base its work on (PRs target this branch) |
| `GITHUB_TOKEN` | no | — | Reserved for future GitHub API usage |
| `GITHUB_WEBHOOK_SECRET` | no | — | Reserved for webhook signature verification |
| `DEVIN_API_KEY` | **yes** | — | Devin API key (Bearer token) |
| `DEVIN_ORG_ID` | **yes** | — | Devin organization id |
| `DEVIN_CREATE_AS_USER_ID` | no | — | Optional Devin user to attribute sessions to |
| `TRIGGER_LABEL` | no | `devin-remediate` | Label that triggers a workflow |

## 6. Running with Docker (recommended)

**Docker is the expected way to run the submitted solution.** The image builds
the TypeScript and starts the service with `npm start`.

### Full demo run order

1. **Terminal 1 — build and start the service in Docker:**

```bash
cp .env.example .env
# fill in DEVIN_API_KEY, DEVIN_ORG_ID, GITHUB_OWNER
docker compose up --build
```

   Wait for `devin-superset-issueops listening on http://localhost:3000`.

2. **Browser — open the live dashboard:**

   <http://localhost:3000/dashboard>

3. **Terminal 2 — (only for real GitHub webhooks) expose the port** with
   Cloudflare Tunnel, then set the printed URL as the GitHub webhook Payload URL
   (`https://<...>.trycloudflare.com/webhooks/github`, see section 9):

```bash
cloudflared tunnel --url http://localhost:3000
```

4. **Trigger a workflow** (either path):
   - **Real (event-driven):** label an issue `devin-remediate` in
     `AFadhluddin/superset` — the remediation agent starts automatically.
   - **Deterministic (no GitHub needed):**

```bash
curl -X POST http://localhost:3000/simulate/issue \
  -H "Content-Type: application/json" \
  -d @examples/issue-1.json
```

5. **Watch it progress** on the dashboard (auto-refreshes every 10s) or via the
   JSON endpoints below.

> To stop everything: `Ctrl-C` in each terminal, then `docker compose down` to
> remove the container. Workflow state in `./.data` persists for the next run.

### Verify the service is up

```bash
curl http://localhost:3000/
curl http://localhost:3000/workflows
curl http://localhost:3000/metrics
curl http://localhost:3000/dashboard
```

Notes:

- **`.env` is required but not committed** (it's in `.gitignore` and
  `.dockerignore`). `docker compose` reads it via `env_file`. The container
  needs `DEVIN_API_KEY`, `DEVIN_ORG_ID`, and `GITHUB_OWNER` at minimum.
- **`.data` is mounted as a local volume** (`./.data:/app/.data`) so workflow
  state persists across container rebuilds and restarts.
- **Cloudflare Tunnel runs outside Docker** and can point at the
  Docker-exposed port to receive GitHub webhooks:

```bash
cloudflared tunnel --url http://localhost:3000
```

  Then use the printed `https://<...>.trycloudflare.com/webhooks/github` as the
  GitHub webhook Payload URL (see section 9).

## 7. Running locally (development)

For iterating on the code without Docker:

```bash
npm install
cp .env.example .env
npm run dev
```

The service logs `listening on http://localhost:3000` when ready.

Typecheck / build / run the compiled output:

```bash
npm run typecheck
npm run build
npm start
```

## 8. Simulating a workflow

No GitHub setup required — just POST an `IssueInput` payload:

```bash
curl -X POST http://localhost:3000/simulate/issue \
  -H "Content-Type: application/json" \
  -d @examples/issue-1.json
```

Successful response:

```json
{
  "ok": true,
  "workflowId": "…",
  "devinSessionId": "devin-…",
  "devinSessionUrl": "https://app.devin.ai/sessions/devin-…"
}
```

If the payload's `labels` array does not include the trigger label, the request
is acknowledged but skipped:

```json
{ "ok": true, "skipped": true, "reason": "Issue does not have trigger label \"devin-remediate\"." }
```

## 9. Automatic GitHub issue trigger

`POST /webhooks/github` is the **real event-driven path**. When an issue in
`AFadhluddin/superset` is opened, edited, labeled, or reopened **and** carries
the `devin-remediate` label, the service automatically creates a Devin session —
no manual call required. The handler:

- Reads the event type from the `x-github-event` header and only processes
  `issues` events (other events are acknowledged and skipped).
- Processes the `opened`, `labeled`, `edited`, and `reopened` actions; other
  actions are skipped with a clear JSON response.
- Extracts issue number, title, URL, body, and labels from the payload.
- Skips issues that lack the `devin-remediate` trigger label.
- Applies **idempotency**: if a non-failed workflow already exists for the same
  `issueUrl`, it returns the existing workflow instead of starting a new session.
- Reuses the same `startIssueWorkflow` logic as `/simulate/issue`.

### Setting up the webhook (live test with Cloudflare Tunnel)

This demo uses [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared`) to expose `localhost:3000` to GitHub. It needs no account or
sign-up for a quick `--url` tunnel.

1. **Install `cloudflared`** (macOS / Homebrew):

```bash
brew install cloudflared
```

2. **Run the local server:**

```bash
npm run dev
```

3. **In a second terminal, open the tunnel:**

```bash
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a public HTTPS URL that forwards to your local server,
for example:

```
https://something-random.trycloudflare.com
```

Your GitHub webhook **Payload URL** is that URL plus the webhook path:

```
https://something-random.trycloudflare.com/webhooks/github
```

4. **Add the webhook in GitHub.** Go to `AFadhluddin/superset` →
   **Settings → Webhooks → Add webhook** and set:
   - **Payload URL:** `https://<cloudflare-url>/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** leave blank for a local demo, or set the same value in both
     `.env` (`GITHUB_WEBHOOK_SECRET`) and this field.
   - **SSL verification:** *Enable SSL verification* (Cloudflare provides a valid
     TLS cert, so leave this on).
   - **Events:** *Let me select individual events* → check **Issues**,
     **Pull requests**, and **Issue comments** (all three are needed for the
     full multi-agent chain — see section 10).
   - **Active:** checked.

5. **First delivery is a `ping`.** When you save the webhook, GitHub immediately
   sends a `ping` event. The service responds with a skip
   (`{ "ok": true, "skipped": true, "reason": "Ignoring event \"ping\"." }`) and
   GitHub shows a green checkmark — this is expected and confirms connectivity.

6. **Trigger a remediation:** create a new issue (or add the label to an
   existing one) with the `devin-remediate` label in `AFadhluddin/superset`. A
   Devin session is created automatically. Then:
   - Watch the `npm run dev` logs for `[webhook] received issues/...` and
     `[workflow] created Devin session...`.
   - Inspect the tracked work:

```bash
curl http://localhost:3000/workflows
curl http://localhost:3000/metrics
```

> **Production note:** a `trycloudflare.com` URL is temporary and changes each
> run. For production, deploy this service behind a stable HTTPS endpoint (a
> named Cloudflare Tunnel, load balancer, or hosting platform) and point the
> GitHub webhook at that durable URL instead.

### Signature verification

If `GITHUB_WEBHOOK_SECRET` is set, the service verifies the
`x-hub-signature-256` header using an HMAC SHA-256 over the raw request body and
returns `401` on mismatch. If the secret is **not** set, verification is skipped
and a warning is logged (fine for a local demo).

To exercise the endpoint locally with `curl` (no secret), mimic GitHub's headers:

```bash
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues" \
  -d '{"action":"labeled","issue":{"number":1,"title":"…","html_url":"https://github.com/AFadhluddin/superset/issues/1","body":"…","labels":[{"name":"devin-remediate"}]}}'
```

> **`/simulate/issue` vs. the webhook:** `/simulate/issue` is retained as a
> deterministic fallback for Loom/demo reliability (no GitHub or tunnel
> required), but the actual multi-agent workflow is driven by GitHub webhooks.

## 10. Webhook-driven multi-agent flow

`POST /webhooks/github` is a single endpoint that dispatches on the
`x-github-event` header to drive a two-agent pipeline. **The remediation agent
and the validation agent are separate Devin sessions.**

1. **`issues` (`labeled` / `opened` / `edited` / `reopened`)** — if the issue
   carries `devin-remediate`, a **remediation Devin agent** is started
   (`startIssueWorkflow`). Status → `remediation_started`. The session id is
   stored as both `devinSessionId` (legacy) and `remediationSessionId`.

2. **`pull_request` (`opened` / `synchronize` / `reopened`)** — when Devin opens
   (or updates) a PR, the service links it back to the **source issue** that it
   remediates. A PR number is **not** assumed to equal the issue number (PR #6
   can close issue #2), so the source issue number is derived, in order, from:
   1. the head branch (`devin/issue-2-…`, or any `issue-<n>` segment),
   2. PR body closing keywords (`Closes #2`, `Fixes #2`, `Resolves #2`,
      case-insensitive),
   3. the PR title (`issue-<n>` or `#<n>`) as a fallback.

   The derived issue number is matched via `findWorkflowForIssueNumber`, with
   further fallbacks to branch match, PR URL, then any issue number in the body.
   It then stores PR metadata (`prUrl`, `prNumber`, `prHeadBranch`, `prHeadSha`),
   sets status → `remediation_pr_opened`, and starts a **validation Devin
   agent** (`buildValidationPrompt`). Status → `validation_started`.

3. **`issue_comment` (`created`)** — GitHub delivers PR comments as
   `issue_comment` events. When the validation agent posts a comment ending in a
   machine-readable marker, the workflow's final state is recorded:
   - `ISSUEOPS_VALIDATION_PASSED` → `ready_for_review` (and `validatedHeadSha`)
   - `ISSUEOPS_VALIDATION_FAILED` → `validation_failed`
   - `ISSUEOPS_NEEDS_HUMAN_REVIEW` → `needs_human_review`

This yields a fully event-driven chain:

```
issue → remediation agent → PR → validation agent → validation result
```

**Agent-level idempotency** is keyed on the PR head SHA: validation is not
re-run if it already passed for that SHA or a validation session already exists
for it. On `pull_request.synchronize` with a *new* head SHA, validation runs
again.

The validation agent ends its PR comment with exactly one of:

```
ISSUEOPS_VALIDATION_PASSED
ISSUEOPS_VALIDATION_FAILED
ISSUEOPS_NEEDS_HUMAN_REVIEW
```

All state remains observable via `GET /workflows` and `GET /metrics` (see below).

## 11. Observability endpoints

```bash
curl http://localhost:3000/workflows
curl http://localhost:3000/metrics
```

### Live dashboard

Open **http://localhost:3000/dashboard** in a browser for a server-rendered
operational view (plain HTML, no frontend build, auto-refreshes every 10s). It
is the recommended thing to show during the Loom / VP Eng pitch — it gives an
engineering leader a live view of active Devin agents, opened PRs, validation
agents, and overall workflow health at a glance. It shows:

- **Summary cards:** total / active / completed-or-ready / failed workflows,
  remediation PRs opened, and validation agents started.
- **Status breakdown** from `metrics.byStatus`.
- **Workflow table:** issue (links to the GitHub issue), status badge,
  remediation agent (links to the Devin session), PR (links to the PR),
  validation agent (links to the validation Devin session), latest Devin status,
  and last-updated timestamp.

```bash
open http://localhost:3000/dashboard   # macOS
```

### Manual status refresh

Workflow status reflects creation by default. To pull the latest Devin session
status on demand, call the manual refresh endpoint with a workflow id:

```bash
curl -X POST http://localhost:3000/workflows/<workflowId>/refresh
```

Devin v3 session objects are keyed by `session_id` (with `url` and `status`),
and the service handles that field when extracting the session id. The refresh
call records `latestDevinStatus` (from `status`, falling back to `state`, then
`"unknown"`) and the raw response, stores `latestPullRequests` when the session
includes `pull_requests` metadata, increments `metrics.statusPolls`, and — when
Devin reports a terminal state — advances the workflow to `completed` / `failed`
and records `completedAt` and `durationSeconds`. The updated workflow is
returned in the response.

`/metrics` returns the original summary plus per-status counts for the
multi-agent pipeline:

```json
{
  "totalWorkflows": 3,
  "active": 1,
  "completed": 1,
  "failed": 1,
  "successRate": 0.5,
  "averageDurationSeconds": null,
  "byStatus": {
    "remediationStarted": 0,
    "remediationPrOpened": 0,
    "validationStarted": 1,
    "readyForReview": 1,
    "needsHumanReview": 0,
    "validationFailed": 1
  }
}
```

This gives an engineering leader an at-a-glance view of work in flight, where it
sits in the remediation → validation pipeline, completed/ready work, failures,
and the success rate across finished workflows. `successRate` counts
`completed`, `ready_for_review`, and `validation_passed` as successes against
`failed` + `validation_failed`.

## 12. Demo issues

Two ready-to-use payloads map to the two synthetic remediation bugs in the
Superset fork:

- `examples/issue-1.json` — **frontend** bug in
  `superset-frontend/src/dashboard/components/nativeFilters/utils.ts`
  (`getFilterValueForDisplay` drops numeric `0`).
- `examples/issue-2.json` — **backend** bug in
  `superset/utils/date_parser.py` (`get_since_until` no longer normalizes empty
  string bounds to `None`).

The `issueUrl` fields point at the `AFadhluddin/superset` fork.

## 13. Loom demo script

1. Show `.env` configured with Devin credentials (blur the key).
2. `npm run dev` — show the service start up.
3. `curl … /simulate/issue -d @examples/issue-1.json` — show the response with a
   live Devin session link.
4. Open the Devin session link in the browser; show Devin working.
5. `curl … /workflows` — show the tracked workflow with status
   `devin_session_created`.
6. `curl … /metrics` — explain active/completed/failed/successRate.
7. Open **http://localhost:3000/dashboard** — show the live cards, status
   breakdown, and workflow table updating as agents progress.
8. Repeat with `examples/issue-2.json` to show a second concurrent workflow.
9. Once Devin opens draft PRs, show the PR links in the Superset fork (and on the
   dashboard).

### Live demo commands

```bash
npm run dev

curl -X POST http://localhost:3000/simulate/issue \
  -H "Content-Type: application/json" \
  -d @examples/issue-1.json

curl http://localhost:3000/workflows

curl http://localhost:3000/metrics

curl -X POST http://localhost:3000/workflows/<workflowId>/refresh
```

## 14. Limitations

- **File-based store** only — fine for a demo, not for concurrent production
  load.
- **No background polling**: status is refreshed on demand via
  `POST /workflows/:id/refresh`, not automatically. Without a refresh, a
  workflow stays at `devin_session_created` and `completed` / `failed` /
  `durationSeconds` are not auto-populated.
- **Idempotency is per `issueUrl`** and treats any non-failed workflow as a
  duplicate; a failed workflow can be retried by re-triggering the issue.

## 15. Future work

- Background poller calling `getDevinSession` to advance workflows to
  `in_progress` / `completed` / `failed` and record `durationSeconds`.
- Capture and surface the resulting PR link per workflow.
- Swap the file store for a real database and add a small dashboard UI.
- Richer metrics (time-to-first-PR, per-label success rates).
