import { config } from "./config.js";

export type IssueInput = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string;
  labels: string[];
};

export function buildRemediationPrompt(issue: IssueInput): string {
  return `You are remediating a GitHub issue in my fork of Apache Superset.

Repository:
https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}

Target branch:
${config.GITHUB_TARGET_BRANCH}

GitHub issue:
${issue.issueUrl}

Issue number:
#${issue.issueNumber}

Issue title:
${issue.issueTitle}

Issue body:
${issue.issueBody}

Your task:
1. Check out the target branch \`${config.GITHUB_TARGET_BRANCH}\`.
2. Inspect the affected area mentioned in the issue.
3. Implement the smallest safe fix.
4. Add or update targeted tests that prove the issue is fixed.
5. Run the most targeted relevant test command.
6. Create a new branch with prefix \`devin/issue-${issue.issueNumber}-\`.
7. Open a draft PR against \`${config.GITHUB_TARGET_BRANCH}\`.

Constraints:
- Do not perform broad refactors.
- Do not modify unrelated files.
- Keep the PR small and reviewable.
- Prefer targeted tests over broad test suites.
- In the PR description, include:
  - root cause
  - files changed
  - tests added or updated
  - commands run
  - remaining risks.`;
}

export type ValidationPromptInput = {
  repoUrl: string;
  targetBranch: string;
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  issueBody: string;
  prUrl: string;
  prNumber?: number;
  prHeadBranch?: string;
  prHeadSha?: string;
};

const SLACK_CHANNEL = "#megacorp-engineering";

export function buildValidationPrompt(input: ValidationPromptInput): string {
  return `You are the Test/Validation Agent for a Devin-created PR in Apache Superset.

Repository:
${input.repoUrl}

Target branch:
${input.targetBranch}

Original issue:
${input.issueUrl}

Issue number:
#${input.issueNumber}

Issue title:
${input.issueTitle}

Issue body:
${input.issueBody}

Pull request:
${input.prUrl}

PR number:
#${input.prNumber}

PR branch:
${input.prHeadBranch}

PR head SHA:
${input.prHeadSha}

Your task:

1. Inspect the PR and gather:
   - PR URL and the source issue it remediates
   - changed files
   - tests added or updated
   - commands run (if visible in the PR description or CI)
   - remaining risks
   - whether the PR looks ready for review

2. Verify the original issue's acceptance criteria, then identify and run the
   smallest relevant test set that proves the fix.

3. Produce a blast-radius summary:
   - affected files / modules
   - rough dependency impact (what else imports or depends on the changed code)
   - which areas are touched: frontend, backend, tests, config
   - a risk level (Low / Medium / High) per area

4. Comment on the PR — this PR comment is the PRIMARY, authoritative
   validation record. Include:
   - tests run and their pass/fail result
   - the blast-radius summary from step 3
   - concerns / remaining risks
   - a Slack-ready chart of the change, preferring a Mermaid diagram, e.g.:

   \`\`\`mermaid
   graph TD
     Issue["Issue #${input.issueNumber}"] --> Change["primary changed file(s)"]
     Change --> Tests["test file(s)"]
     Tests --> Risk["overall blast radius: Low/Medium/High"]
   \`\`\`

5. Team notification to Slack (\`${SLACK_CHANNEL}\`):
   - Devin's native Slack integration is configured to post repository/session
     updates to \`${SLACK_CHANNEL}\` automatically, so the team is notified there
     about this session and PR without any action from you.
   - Additionally, ONLY IF a working Slack tool is actually available to you,
     you may post the summary + Mermaid chart to \`${SLACK_CHANNEL}\` as a bonus.
   - This is strictly best-effort and must NEVER block or slow validation: if no
     Slack tool is available, or a post fails for any reason, do not retry and
     do not treat it as an error. The PR comment is the source of truth.

6. If the implementation is incomplete and the fix is small, push a minimal
   follow-up commit to the same PR branch.

7. Do not broaden scope or refactor unrelated code.

End your PR comment with exactly one of these machine-readable markers:
ISSUEOPS_VALIDATION_PASSED
ISSUEOPS_VALIDATION_FAILED
ISSUEOPS_NEEDS_HUMAN_REVIEW`;
}
