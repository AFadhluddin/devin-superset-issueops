import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IssueInput } from "./prompts.js";

export type WorkflowStatus =
  | "created"
  | "devin_session_created"
  | "in_progress"
  | "completed"
  | "failed"
  | "remediation_started"
  | "remediation_pr_opened"
  | "validation_started"
  | "validation_passed"
  | "validation_failed"
  | "needs_human_review"
  | "ready_for_review";

export type Workflow = {
  id: string;
  issue: IssueInput;
  status: WorkflowStatus;
  // Backward-compatible single-agent fields.
  devinSessionId?: string;
  devinSessionUrl?: string;
  // Multi-agent: remediation agent.
  remediationSessionId?: string;
  remediationSessionUrl?: string;
  // Multi-agent: validation agent.
  validationSessionId?: string;
  validationSessionUrl?: string;
  validationStartedHeadSha?: string;
  validatedHeadSha?: string;
  validationCommentId?: number;
  // Pull request metadata.
  prUrl?: string;
  prNumber?: number;
  prHeadBranch?: string;
  prHeadSha?: string;
  latestDevinStatus?: string;
  latestDevinRaw?: unknown;
  latestPullRequests?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metrics: {
    statusPolls: number;
    durationSeconds?: number;
  };
};

const DATA_DIR = path.resolve(process.cwd(), ".data", "workflows");

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function workflowPath(id: string): string {
  return path.join(DATA_DIR, `${id}.json`);
}

export function createWorkflow(issue: IssueInput): Workflow {
  const now = new Date().toISOString();
  const workflow: Workflow = {
    id: randomUUID(),
    issue,
    status: "created",
    createdAt: now,
    updatedAt: now,
    metrics: {
      statusPolls: 0,
    },
  };
  saveWorkflow(workflow);
  return workflow;
}

export function getWorkflow(id: string): Workflow | undefined {
  ensureDataDir();
  const file = workflowPath(id);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Workflow;
  } catch {
    return undefined;
  }
}

export function saveWorkflow(workflow: Workflow): void {
  ensureDataDir();
  workflow.updatedAt = new Date().toISOString();
  fs.writeFileSync(workflowPath(workflow.id), JSON.stringify(workflow, null, 2), "utf8");
}

export function listWorkflows(): Workflow[] {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const workflows: Workflow[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
      workflows.push(JSON.parse(raw) as Workflow);
    } catch {
      // Skip unreadable/corrupt workflow files rather than failing the request.
    }
  }
  return workflows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Returns the most recent non-failed workflow for a given issue URL, used for
 * idempotency so the same issue event does not spawn duplicate Devin sessions.
 */
export function findExistingWorkflowForIssue(issueUrl: string): Workflow | undefined {
  return listWorkflows().find(
    (w) => w.issue.issueUrl === issueUrl && w.status !== "failed",
  );
}

export function findWorkflowForIssueNumber(issueNumber: number): Workflow | undefined {
  return listWorkflows().find((w) => w.issue.issueNumber === issueNumber);
}

export function findWorkflowForPr(prUrl: string): Workflow | undefined {
  return listWorkflows().find((w) => w.prUrl === prUrl);
}

/**
 * Matches a PR head branch to a workflow. Devin opens branches with the prefix
 * `devin/issue-<issueNumber>-`, so we parse the issue number out of the branch
 * name and map it back to the originating workflow.
 */
export function findWorkflowForBranch(branchName: string): Workflow | undefined {
  const workflows = listWorkflows();

  const direct = workflows.find((w) => w.prHeadBranch === branchName);
  if (direct) return direct;

  const match = /devin\/issue-(\d+)-/.exec(branchName);
  if (match && match[1]) {
    const issueNumber = Number(match[1]);
    return workflows.find((w) => w.issue.issueNumber === issueNumber);
  }

  return undefined;
}

export type Metrics = {
  totalWorkflows: number;
  active: number;
  completed: number;
  failed: number;
  successRate: number;
  averageDurationSeconds: number | null;
  byStatus: {
    remediationStarted: number;
    remediationPrOpened: number;
    validationStarted: number;
    readyForReview: number;
    needsHumanReview: number;
    validationFailed: number;
  };
};

const ACTIVE_STATUSES = new Set<WorkflowStatus>([
  "created",
  "devin_session_created",
  "in_progress",
  "remediation_started",
  "remediation_pr_opened",
  "validation_started",
]);

export function getMetrics(): Metrics {
  const workflows = listWorkflows();
  const total = workflows.length;

  const countByStatus = (status: WorkflowStatus): number =>
    workflows.filter((w) => w.status === status).length;

  const completed = countByStatus("completed");
  // A finished/successful workflow is either the legacy "completed" status or a
  // multi-agent workflow that reached "ready_for_review" / "validation_passed".
  const readyForReview = countByStatus("ready_for_review");
  const validationPassed = countByStatus("validation_passed");
  const succeeded = completed + readyForReview + validationPassed;

  const failed = countByStatus("failed");
  const validationFailed = countByStatus("validation_failed");
  const failedTotal = failed + validationFailed;

  const active = workflows.filter((w) => ACTIVE_STATUSES.has(w.status)).length;

  const finished = succeeded + failedTotal;
  const successRate = finished > 0 ? succeeded / finished : 0;

  const durations = workflows
    .map((w) => w.metrics.durationSeconds)
    .filter((d): d is number => typeof d === "number");
  const averageDurationSeconds =
    durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : null;

  return {
    totalWorkflows: total,
    active,
    completed,
    failed,
    successRate,
    averageDurationSeconds,
    byStatus: {
      remediationStarted: countByStatus("remediation_started"),
      remediationPrOpened: countByStatus("remediation_pr_opened"),
      validationStarted: countByStatus("validation_started"),
      readyForReview,
      needsHumanReview: countByStatus("needs_human_review"),
      validationFailed,
    },
  };
}
