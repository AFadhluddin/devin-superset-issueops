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
1. Inspect the PR diff.
2. Verify the original issue acceptance criteria.
3. Identify and run the smallest relevant test set.
4. Comment on the PR with:
   - tests run
   - pass/fail result
   - concerns
5. If the implementation is incomplete and the fix is small, push a minimal follow-up commit to the same PR branch.
6. Do not broaden scope or refactor unrelated code.

End your PR comment with exactly one of these machine-readable markers:
ISSUEOPS_VALIDATION_PASSED
ISSUEOPS_VALIDATION_FAILED
ISSUEOPS_NEEDS_HUMAN_REVIEW`;
}
