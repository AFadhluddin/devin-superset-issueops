import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import {
  buildRemediationPrompt,
  buildValidationPrompt,
  type IssueInput,
  type ValidationPromptInput,
} from "./prompts.js";
import { createDevinSession, getDevinSession } from "./devin.js";
import {
  createWorkflow,
  saveWorkflow,
  listWorkflows,
  getWorkflow,
  findExistingWorkflowForIssue,
  findWorkflowForBranch,
  findWorkflowForPr,
  findWorkflowForIssueNumber,
  getMetrics,
  type Workflow,
} from "./store.js";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

const COMPLETED_STATUSES = new Set([
  "completed",
  "complete",
  "finished",
  "success",
  "succeeded",
]);
const FAILED_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "expired",
]);

const app = express();
app.use(
  express.json({
    limit: "2mb",
    // Capture the raw body so webhook signatures can be verified later.
    verify: (req, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  }),
);

const issueInputSchema = z.object({
  issueNumber: z.number(),
  issueTitle: z.string(),
  issueUrl: z.string(),
  issueBody: z.string(),
  labels: z.array(z.string()),
});

type SkippedResult = {
  skipped: true;
  reason: string;
  workflowId?: string;
  devinSessionUrl?: string;
};
type StartedResult = {
  skipped: false;
  workflowId: string;
  devinSessionId: string | undefined;
  devinSessionUrl: string | undefined;
};
type StartResult = SkippedResult | StartedResult;

/**
 * Shared workflow entrypoint used by both the simulation endpoint and the
 * GitHub webhook. Enforces the trigger label, applies idempotency, kicks off a
 * Devin session, and persists the resulting session metadata.
 */
async function startIssueWorkflow(issue: IssueInput): Promise<StartResult> {
  if (!issue.labels.includes(config.TRIGGER_LABEL)) {
    console.log(
      `[workflow] skip issue #${issue.issueNumber}: missing trigger label "${config.TRIGGER_LABEL}".`,
    );
    return {
      skipped: true,
      reason: `Issue does not have trigger label "${config.TRIGGER_LABEL}".`,
    };
  }

  const existing = findExistingWorkflowForIssue(issue.issueUrl);
  if (existing) {
    console.log(
      `[workflow] skip issue #${issue.issueNumber}: duplicate of workflow ${existing.id} (status=${existing.status}).`,
    );
    const skipped: SkippedResult = {
      skipped: true,
      reason: "Workflow already exists for issue",
      workflowId: existing.id,
    };
    if (existing.devinSessionUrl !== undefined) {
      skipped.devinSessionUrl = existing.devinSessionUrl;
    }
    return skipped;
  }

  const workflow = createWorkflow(issue);

  const prompt = buildRemediationPrompt(issue);
  const session = await createDevinSession(prompt);

  const devinSessionId = session.session_id ?? session.devin_id ?? session.id;
  const devinSessionUrl =
    session.url ??
    (devinSessionId ? `https://app.devin.ai/sessions/${devinSessionId}` : undefined);

  workflow.status = "remediation_started";
  // Store under both the legacy and multi-agent field names.
  if (devinSessionId !== undefined) {
    workflow.devinSessionId = devinSessionId;
    workflow.remediationSessionId = devinSessionId;
  }
  if (devinSessionUrl !== undefined) {
    workflow.devinSessionUrl = devinSessionUrl;
    workflow.remediationSessionUrl = devinSessionUrl;
  }
  saveWorkflow(workflow);

  console.log(
    `[workflow] remediation agent started for issue #${issue.issueNumber}: workflow=${workflow.id} session=${devinSessionId ?? "unknown"} url=${devinSessionUrl ?? "n/a"}`,
  );

  return {
    skipped: false,
    workflowId: workflow.id,
    devinSessionId,
    devinSessionUrl,
  };
}

/** Maps a workflow start result to the shared JSON response shape. */
function toResponse(result: StartResult): Record<string, unknown> {
  if (result.skipped) {
    return {
      ok: true,
      skipped: true,
      reason: result.reason,
      workflowId: result.workflowId,
      devinSessionUrl: result.devinSessionUrl,
    };
  }
  return {
    ok: true,
    workflowId: result.workflowId,
    devinSessionId: result.devinSessionId,
    devinSessionUrl: result.devinSessionUrl,
  };
}

/**
 * Verifies the GitHub webhook HMAC SHA-256 signature against the raw body.
 * Returns true (and logs a warning) when no secret is configured.
 */
function verifyGithubSignature(req: Request): boolean {
  const secret = config.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      "[webhook] GITHUB_WEBHOOK_SECRET not set — skipping signature verification.",
    );
    return true;
  }

  const signature = req.header("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const digest = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex")}`;

  const sigBuf = Buffer.from(signature);
  const digestBuf = Buffer.from(digest);
  if (sigBuf.length !== digestBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, digestBuf);
}

const VALIDATION_MARKERS = {
  passed: "ISSUEOPS_VALIDATION_PASSED",
  failed: "ISSUEOPS_VALIDATION_FAILED",
  needsReview: "ISSUEOPS_NEEDS_HUMAN_REVIEW",
} as const;

const SUPPORTED_ISSUE_ACTIONS = ["opened", "labeled", "edited", "reopened"];
const SUPPORTED_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
];

type WebhookOutcome = { httpStatus?: number; json: Record<string, unknown> };

/** Best-effort extraction of an issue number from a URL or free text. */
function parseIssueNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const fromPath = /\/issues\/(\d+)/.exec(text);
  if (fromPath?.[1]) return Number(fromPath[1]);
  const fromHash = /#(\d+)/.exec(text);
  if (fromHash?.[1]) return Number(fromHash[1]);
  return undefined;
}

/**
 * Resolves the *source* (remediation) issue number from a pull request. A PR
 * number is NOT the same as the issue it remediates (PR #6 can close issue #2),
 * so we infer the issue number from, in order: the head branch
 * (`devin/issue-2-…`, `issue-2`), PR body closing keywords (`Closes #2`,
 * `Fixes #2`, `Resolves #2`), and finally the PR title.
 */
function extractSourceIssueNumber(input: {
  headBranch?: string | undefined;
  body?: string | undefined;
  title?: string | undefined;
}): number | undefined {
  // 1. Head branch: any `issue-<number>` segment.
  const fromBranch = /issue-(\d+)/i.exec(input.headBranch ?? "");
  if (fromBranch?.[1]) return Number(fromBranch[1]);

  // 2. PR body: GitHub closing keywords (case-insensitive).
  const fromBody = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/i.exec(
    input.body ?? "",
  );
  if (fromBody?.[1]) return Number(fromBody[1]);

  // 3. PR title fallback: `issue-<number>` or `#<number>`.
  const title = input.title ?? "";
  const fromTitleBranch = /issue-(\d+)/i.exec(title);
  if (fromTitleBranch?.[1]) return Number(fromTitleBranch[1]);
  const fromTitleHash = /#(\d+)/.exec(title);
  if (fromTitleHash?.[1]) return Number(fromTitleHash[1]);

  return undefined;
}

type IssuesEventPayload = {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    html_url?: string;
    body?: string | null;
    labels?: Array<{ name?: string } | string>;
  };
};

async function handleIssuesEvent(payload: IssuesEventPayload): Promise<WebhookOutcome> {
  const action = payload.action ?? "";
  console.log(
    `[webhook] received issues/${action || "unknown"} for issue #${payload.issue?.number ?? "?"}.`,
  );

  if (!SUPPORTED_ISSUE_ACTIONS.includes(action)) {
    console.log(`[webhook] ignoring issues action "${action}".`);
    return { json: { ok: true, skipped: true, reason: `Ignoring action "${action}".` } };
  }

  const ghIssue = payload.issue;
  if (!ghIssue || typeof ghIssue.number !== "number") {
    return { httpStatus: 400, json: { ok: false, error: "Webhook payload missing issue data." } };
  }

  const labels = (ghIssue.labels ?? []).map((label) =>
    typeof label === "string" ? label : (label.name ?? ""),
  );

  const issue: IssueInput = {
    issueNumber: ghIssue.number,
    issueTitle: ghIssue.title ?? "",
    issueUrl: ghIssue.html_url ?? "",
    issueBody: ghIssue.body ?? "",
    labels,
  };

  const result = await startIssueWorkflow(issue);
  return { json: toResponse(result) };
}

type PullRequestEventPayload = {
  action?: string;
  pull_request?: {
    html_url?: string;
    number?: number;
    title?: string;
    body?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  };
};

async function handlePullRequestEvent(
  payload: PullRequestEventPayload,
): Promise<WebhookOutcome> {
  const action = payload.action ?? "";
  const pr = payload.pull_request;
  console.log(
    `[webhook] received pull_request/${action || "unknown"} for PR #${pr?.number ?? "?"}.`,
  );

  if (!SUPPORTED_PR_ACTIONS.includes(action)) {
    console.log(`[webhook] ignoring pull_request action "${action}".`);
    return { json: { ok: true, skipped: true, reason: `Ignoring action "${action}".` } };
  }

  if (!pr) {
    return { httpStatus: 400, json: { ok: false, error: "Webhook payload missing pull_request data." } };
  }

  const prUrl = pr.html_url ?? "";
  const prNumber = pr.number;
  const prHeadBranch = pr.head?.ref;
  const prHeadSha = pr.head?.sha;
  const baseBranch = pr.base?.ref;
  const prTitle = pr.title ?? "";
  const prBody = pr.body ?? "";

  // The PR number is not the issue number — derive the source issue explicitly.
  const sourceIssueNumber = extractSourceIssueNumber({
    headBranch: prHeadBranch,
    body: prBody,
    title: prTitle,
  });
  console.log(
    `[webhook] PR #${prNumber ?? "?"} (branch=${prHeadBranch ?? "n/a"}, base=${baseBranch ?? "n/a"}) → source issue #${sourceIssueNumber ?? "unknown"}.`,
  );

  // Map the PR back to a remediation workflow: source issue first, then branch,
  // then PR URL, then any issue number parsed from the body.
  let workflow: Workflow | undefined =
    sourceIssueNumber !== undefined
      ? findWorkflowForIssueNumber(sourceIssueNumber)
      : undefined;
  if (!workflow && prHeadBranch) workflow = findWorkflowForBranch(prHeadBranch);
  if (!workflow && prUrl) workflow = findWorkflowForPr(prUrl);
  if (!workflow) {
    const issueNumber = parseIssueNumber(prBody);
    if (issueNumber !== undefined) workflow = findWorkflowForIssueNumber(issueNumber);
  }

  if (!workflow) {
    console.log(
      `[webhook] no workflow matched PR #${prNumber ?? "?"} (source issue #${sourceIssueNumber ?? "unknown"}, branch=${prHeadBranch ?? "n/a"}) — skipping.`,
    );
    return {
      json: {
        ok: true,
        skipped: true,
        reason: "No matching workflow found for pull request",
      },
    };
  }

  console.log(`[webhook] matched PR #${prNumber ?? "?"} to workflow ${workflow.id}.`);

  // Persist PR metadata.
  if (prUrl) workflow.prUrl = prUrl;
  if (prNumber !== undefined) workflow.prNumber = prNumber;
  if (prHeadBranch !== undefined) workflow.prHeadBranch = prHeadBranch;
  if (prHeadSha !== undefined) workflow.prHeadSha = prHeadSha;
  workflow.status = "remediation_pr_opened";
  saveWorkflow(workflow);

  // Agent-level idempotency keyed on the PR head SHA.
  if (prHeadSha && workflow.validatedHeadSha === prHeadSha) {
    console.log(`[webhook] PR ${prHeadSha} already validated — skipping validation agent.`);
    return {
      json: { ok: true, skipped: true, reason: "Validation already passed for this PR SHA", workflowId: workflow.id },
    };
  }
  if (
    prHeadSha &&
    workflow.validationSessionId &&
    workflow.validationStartedHeadSha === prHeadSha
  ) {
    console.log(`[webhook] validation already started for ${prHeadSha} — skipping duplicate.`);
    return {
      json: {
        ok: true,
        skipped: true,
        reason: "Validation session already exists for this PR SHA",
        workflowId: workflow.id,
        validationSessionUrl: workflow.validationSessionUrl,
      },
    };
  }

  // Start the validation agent (a separate Devin session).
  const validationInput: ValidationPromptInput = {
    repoUrl: `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}`,
    targetBranch: config.GITHUB_TARGET_BRANCH,
    issueNumber: workflow.issue.issueNumber,
    issueUrl: workflow.issue.issueUrl,
    issueTitle: workflow.issue.issueTitle,
    issueBody: workflow.issue.issueBody,
    prUrl,
  };
  if (prNumber !== undefined) validationInput.prNumber = prNumber;
  if (prHeadBranch !== undefined) validationInput.prHeadBranch = prHeadBranch;
  if (prHeadSha !== undefined) validationInput.prHeadSha = prHeadSha;

  const session = await createDevinSession(buildValidationPrompt(validationInput));
  const validationSessionId = session.session_id ?? session.devin_id ?? session.id;
  const validationSessionUrl =
    session.url ??
    (validationSessionId ? `https://app.devin.ai/sessions/${validationSessionId}` : undefined);

  if (validationSessionId !== undefined) workflow.validationSessionId = validationSessionId;
  if (validationSessionUrl !== undefined) workflow.validationSessionUrl = validationSessionUrl;
  if (prHeadSha !== undefined) workflow.validationStartedHeadSha = prHeadSha;
  workflow.status = "validation_started";
  saveWorkflow(workflow);

  console.log(
    `[workflow] validation agent started for PR #${prNumber ?? "?"}: workflow=${workflow.id} session=${validationSessionId ?? "unknown"}.`,
  );

  return {
    json: {
      ok: true,
      workflowId: workflow.id,
      prUrl,
      validationSessionId,
      validationSessionUrl,
    },
  };
}

type IssueCommentEventPayload = {
  action?: string;
  comment?: { id?: number; body?: string | null };
  issue?: { html_url?: string; number?: number; pull_request?: unknown };
};

function handleIssueCommentEvent(payload: IssueCommentEventPayload): WebhookOutcome {
  const action = payload.action ?? "";
  console.log(`[webhook] received issue_comment/${action || "unknown"}.`);

  if (action !== "created") {
    return { json: { ok: true, skipped: true, reason: `Ignoring action "${action}".` } };
  }

  const body = payload.comment?.body ?? "";
  const hasMarker =
    body.includes(VALIDATION_MARKERS.passed) ||
    body.includes(VALIDATION_MARKERS.failed) ||
    body.includes(VALIDATION_MARKERS.needsReview);
  if (!hasMarker) {
    return { json: { ok: true, skipped: true, reason: "Comment has no validation marker" } };
  }

  // PR comments arrive as issue_comment events; payload.issue.pull_request marks them.
  const issueUrl = payload.issue?.html_url ?? "";
  let workflow: Workflow | undefined = issueUrl ? findWorkflowForPr(issueUrl) : undefined;
  if (!workflow) {
    const issueNumber = parseIssueNumber(issueUrl) ?? payload.issue?.number ?? parseIssueNumber(body);
    if (issueNumber !== undefined) workflow = findWorkflowForIssueNumber(issueNumber);
  }

  if (!workflow) {
    console.log("[webhook] no workflow matched validation comment.");
    return { json: { ok: true, skipped: true, reason: "No matching workflow found for comment" } };
  }

  const commentId = payload.comment?.id;
  if (commentId !== undefined) workflow.validationCommentId = commentId;

  if (body.includes(VALIDATION_MARKERS.passed)) {
    workflow.status = "ready_for_review";
    if (workflow.prHeadSha !== undefined) workflow.validatedHeadSha = workflow.prHeadSha;
  } else if (body.includes(VALIDATION_MARKERS.failed)) {
    workflow.status = "validation_failed";
  } else {
    workflow.status = "needs_human_review";
  }
  saveWorkflow(workflow);

  console.log(`[workflow] validation result for workflow=${workflow.id}: ${workflow.status}.`);

  return { json: { ok: true, workflowId: workflow.id, status: workflow.status } };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_COLORS: Record<string, string> = {
  created: "#64748b",
  devin_session_created: "#0ea5e9",
  remediation_started: "#0ea5e9",
  remediation_pr_opened: "#6366f1",
  validation_started: "#a855f7",
  validation_passed: "#16a34a",
  ready_for_review: "#16a34a",
  completed: "#16a34a",
  in_progress: "#0ea5e9",
  needs_human_review: "#f59e0b",
  validation_failed: "#dc2626",
  failed: "#dc2626",
};

function statusBadge(status: string): string {
  const color = STATUS_COLORS[status] ?? "#64748b";
  return `<span class="badge" style="background:${color}">${escapeHtml(status)}</span>`;
}

function link(href: unknown, label: string): string {
  if (typeof href === "string" && href.length > 0) {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }
  return `<span class="muted">—</span>`;
}

/** Extracts a PR URL from explicit field or the latestPullRequests payload. */
function workflowPrUrl(workflow: Workflow): string | undefined {
  if (workflow.prUrl) return workflow.prUrl;
  const prs = workflow.latestPullRequests;
  if (Array.isArray(prs) && prs.length > 0) {
    const first = prs[0] as Record<string, unknown> | undefined;
    const url = first?.["pr_url"] ?? first?.["url"] ?? first?.["html_url"];
    if (typeof url === "string") return url;
  }
  return undefined;
}

function summaryCard(label: string, value: number | string): string {
  return `<div class="card"><div class="card-value">${escapeHtml(value)}</div><div class="card-label">${escapeHtml(label)}</div></div>`;
}

function renderDashboard(): string {
  const workflows = listWorkflows();
  const metrics = getMetrics();
  const byStatus = metrics.byStatus;

  const completedOrReady = metrics.completed + byStatus.readyForReview;
  const failedTotal = metrics.failed + byStatus.validationFailed;

  const cards = [
    summaryCard("Total workflows", metrics.totalWorkflows),
    summaryCard("Active", metrics.active),
    summaryCard("Completed / ready", completedOrReady),
    summaryCard("Failed", failedTotal),
    summaryCard("Remediation PRs opened", byStatus.remediationPrOpened),
    summaryCard("Validation agents started", byStatus.validationStarted),
  ].join("");

  const statusBreakdown = Object.entries({
    remediation_started: byStatus.remediationStarted,
    remediation_pr_opened: byStatus.remediationPrOpened,
    validation_started: byStatus.validationStarted,
    ready_for_review: byStatus.readyForReview,
    needs_human_review: byStatus.needsHumanReview,
    validation_failed: byStatus.validationFailed,
  })
    .map(
      ([status, count]) =>
        `<div class="status-row">${statusBadge(status)}<span class="status-count">${count}</span></div>`,
    )
    .join("");

  const rows = workflows
    .map((w) => {
      const remediationUrl = w.remediationSessionUrl ?? w.devinSessionUrl;
      const prUrl = workflowPrUrl(w);
      const issueLabel = `#${w.issue.issueNumber} ${w.issue.issueTitle}`;
      const prLabel = w.prNumber ? `PR #${w.prNumber}` : "PR";
      return `<tr>
        <td>${link(w.issue.issueUrl, issueLabel)}</td>
        <td>${statusBadge(w.status)}</td>
        <td>${link(remediationUrl, "remediation")}</td>
        <td>${link(prUrl, prLabel)}</td>
        <td>${link(w.validationSessionUrl, "validation")}</td>
        <td>${w.latestDevinStatus ? escapeHtml(w.latestDevinStatus) : '<span class="muted">—</span>'}</td>
        <td class="muted">${escapeHtml(w.updatedAt)}</td>
      </tr>`;
    })
    .join("");

  const emptyRow = `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No workflows yet. Trigger one via a labeled issue or POST /simulate/issue.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="10" />
<title>Devin Superset IssueOps Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px; }
  .card-value { font-size: 30px; font-weight: 700; line-height: 1; }
  .card-label { color: #94a3b8; font-size: 13px; margin-top: 8px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #94a3b8; margin: 28px 0 14px; }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 8px; }
  .status-row { display: flex; align-items: center; justify-content: space-between; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 10px 14px; }
  .status-count { font-weight: 700; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 11px 14px; font-size: 13px; border-bottom: 1px solid #334155; vertical-align: top; }
  th { background: #0b1220; color: #94a3b8; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  tr:last-child td { border-bottom: none; }
  a { color: #7dd3fc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #64748b; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .meta { color: #64748b; font-size: 12px; margin-top: 18px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Devin Superset IssueOps Dashboard</h1>
    <div class="sub">Live multi-agent view · auto-refreshes every 10s · success rate ${(metrics.successRate * 100).toFixed(0)}%</div>

    <div class="cards">${cards}</div>

    <h2>Status breakdown</h2>
    <div class="status-grid">${statusBreakdown}</div>

    <h2>Workflows</h2>
    <table>
      <thead>
        <tr>
          <th>Issue</th>
          <th>Status</th>
          <th>Remediation agent</th>
          <th>PR</th>
          <th>Validation agent</th>
          <th>Latest Devin status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>${rows || emptyRow}</tbody>
    </table>

    <div class="meta">issue → remediation agent → PR → validation agent → validation result</div>
  </div>
</body>
</html>`;
}

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "devin-superset-issueops",
    status: "ok",
    endpoints: {
      "GET /": "Service info",
      "GET /dashboard": "Live HTML operational dashboard",
      "POST /webhooks/github":
        "Multi-agent GitHub webhook: issues → remediation agent, pull_request → validation agent, issue_comment → validation result",
      "POST /simulate/issue": "Local deterministic demo trigger (body = IssueInput)",
      "GET /workflows": "List all tracked workflows",
      "POST /workflows/:id/refresh": "Refresh a workflow's Devin session status",
      "GET /metrics": "Workflow metrics summary",
    },
  });
});

app.get("/dashboard", (_req: Request, res: Response) => {
  res.type("html").send(renderDashboard());
});

app.post("/simulate/issue", async (req: Request, res: Response) => {
  const parsed = issueInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: z.prettifyError(parsed.error) });
    return;
  }

  try {
    const result = await startIssueWorkflow(parsed.data);
    res.json(toResponse(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/webhooks/github", async (req: Request, res: Response) => {
  if (!verifyGithubSignature(req)) {
    console.warn("[webhook] rejected: invalid x-hub-signature-256.");
    res.status(401).json({ ok: false, error: "Invalid webhook signature." });
    return;
  }

  const event = req.header("x-github-event");
  const action = (req.body as { action?: string })?.action ?? "unknown";
  console.log(`[webhook] received event=${event ?? "unknown"} action=${action}`);

  try {
    let outcome: WebhookOutcome;
    switch (event) {
      case "issues":
        outcome = await handleIssuesEvent(req.body as IssuesEventPayload);
        break;
      case "pull_request":
        console.log(`[webhook] dispatching pull_request action=${action}`);
        outcome = await handlePullRequestEvent(req.body as PullRequestEventPayload);
        break;
      case "issue_comment":
        console.log(`[webhook] dispatching issue_comment action=${action}`);
        outcome = handleIssueCommentEvent(req.body as IssueCommentEventPayload);
        break;
      case "pull_request_review":
        console.log(`[webhook] ignoring event "pull_request_review".`);
        outcome = {
          json: { ok: true, skipped: true, reason: `Ignoring event "pull_request_review".` },
        };
        break;
      default:
        console.log(`[webhook] ignoring event "${event ?? "unknown"}".`);
        outcome = {
          json: { ok: true, skipped: true, reason: `Ignoring event "${event ?? "unknown"}".` },
        };
    }
    res.status(outcome.httpStatus ?? 200).json(outcome.json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/workflows", (_req: Request, res: Response) => {
  res.json(listWorkflows());
});

app.post("/workflows/:id/refresh", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const workflow = getWorkflow(id);
  if (!workflow) {
    res.status(404).json({ ok: false, error: `Workflow ${id} not found.` });
    return;
  }

  if (!workflow.devinSessionId) {
    res.status(400).json({
      ok: false,
      error: "Workflow has no associated Devin session to refresh.",
    });
    return;
  }

  try {
    const session = await getDevinSession(workflow.devinSessionId);

    const rawStatus =
      typeof session.status === "string"
        ? session.status
        : typeof session.state === "string"
          ? session.state
          : "unknown";

    workflow.latestDevinStatus = rawStatus;
    workflow.latestDevinRaw = session;
    if (session.pull_requests !== undefined) {
      workflow.latestPullRequests = session.pull_requests;
    }
    workflow.metrics.statusPolls += 1;
    const now = new Date();
    workflow.updatedAt = now.toISOString();

    const normalized = rawStatus.toLowerCase();
    if (COMPLETED_STATUSES.has(normalized) || FAILED_STATUSES.has(normalized)) {
      workflow.status = COMPLETED_STATUSES.has(normalized) ? "completed" : "failed";
      workflow.completedAt = now.toISOString();
      workflow.metrics.durationSeconds =
        (now.getTime() - new Date(workflow.createdAt).getTime()) / 1000;
    }

    saveWorkflow(workflow);
    res.json(workflow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/metrics", (_req: Request, res: Response) => {
  res.json(getMetrics());
});

app.listen(config.PORT, () => {
  console.log(`devin-superset-issueops listening on http://localhost:${config.PORT}`);
});
