import { config } from "./config.js";

type SlackResult = { ok: boolean; error?: string; ts?: string };

/** Whether a Slack bot token is configured. */
export function slackEnabled(): boolean {
  return Boolean(config.SLACK_BOT_TOKEN);
}

/**
 * Posts a message to Slack via chat.postMessage using the bot token.
 * Best-effort: never throws — returns a result and logs failures so a Slack
 * problem can never block the orchestration flow.
 */
export async function postSlackMessage(text: string): Promise<SlackResult> {
  if (!config.SLACK_BOT_TOKEN) {
    console.log("[slack] SLACK_BOT_TOKEN not set — skipping Slack notification.");
    return { ok: false, error: "not_configured" };
  }

  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: config.SLACK_CHANNEL,
        text,
        unfurl_links: false,
      }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string; ts?: string };
    if (!data.ok) {
      console.warn(`[slack] post failed: ${data.error ?? "unknown error"}`);
      return { ok: false, error: data.error ?? "unknown_error" };
    }
    console.log(`[slack] posted to ${config.SLACK_CHANNEL} (ts=${data.ts ?? "?"}).`);
    return data.ts !== undefined ? { ok: true, ts: data.ts } : { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[slack] post error: ${message}`);
    return { ok: false, error: message };
  }
}

function prLink(prUrl: string | undefined, prNumber: number | undefined): string {
  if (prUrl && prNumber) return `<${prUrl}|PR #${prNumber}>`;
  if (prUrl) return `<${prUrl}|PR>`;
  if (prNumber) return `PR #${prNumber}`;
  return "PR";
}

/** Notifies the team that a remediation PR opened and validation has started. */
export async function notifyPrOpened(args: {
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  prUrl: string;
  prNumber?: number;
  validationSessionUrl?: string;
  isUpdate?: boolean;
}): Promise<SlackResult> {
  const verb = args.isUpdate ? "updated" : "opened";
  const lines = [
    `:rocket: *Remediation ${verb}* — ${prLink(args.prUrl, args.prNumber)} for issue <${args.issueUrl}|#${args.issueNumber}: ${args.issueTitle}>`,
    args.validationSessionUrl
      ? `• Validation agent: <${args.validationSessionUrl}|Devin session> (running)`
      : `• Validation agent: running`,
  ];
  return postSlackMessage(lines.join("\n"));
}

/** Notifies the team of the validation outcome (passed / failed / needs review). */
export async function notifyValidationResult(args: {
  status: "ready_for_review" | "validation_failed" | "needs_human_review";
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  prUrl?: string;
  prNumber?: number;
  validationSessionUrl?: string;
}): Promise<SlackResult> {
  const meta: Record<string, { emoji: string; label: string }> = {
    ready_for_review: { emoji: ":white_check_mark:", label: "Validation PASSED — ready for review" },
    validation_failed: { emoji: ":x:", label: "Validation FAILED" },
    needs_human_review: { emoji: ":warning:", label: "Needs human review" },
  };
  const { emoji, label } = meta[args.status] ?? {
    emoji: ":information_source:",
    label: args.status,
  };

  const lines = [
    `${emoji} *${label}* — ${prLink(args.prUrl, args.prNumber)} for issue <${args.issueUrl}|#${args.issueNumber}: ${args.issueTitle}>`,
    args.validationSessionUrl
      ? `• Validation agent: <${args.validationSessionUrl}|Devin session>`
      : undefined,
    `• Full report: see the PR comment.`,
  ].filter((line): line is string => Boolean(line));
  return postSlackMessage(lines.join("\n"));
}
