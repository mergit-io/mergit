/** The pull-request step: what the API sends for `/diff` and `/pr`, read defensively. */
export type PrStatus = "queued" | "running" | "done" | "error";

export type PullRequest = {
  status: PrStatus;
  branch: string | null;
  commitSha: string | null;
  number: number | null;
  url: string | null;
  error: string | null;
};

export type PlanDiff = {
  repoUrl: string;
  baseRef: string;
  tasks: { index: number; title: string }[];
  diff: string;
  lines: { added: number; removed: number };
};

const STATUSES: readonly string[] = ["queued", "running", "done", "error"];
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A link from the server goes into an href, so it is used only if it is an https address on github.com. */
function githubUrl(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : null;
  } catch {
    return null;
  }
}

export function parsePullRequest(body: unknown): PullRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status !== "string" || !STATUSES.includes(b.status)) return null;
  return {
    status: b.status as PrStatus,
    branch: text(b.branch),
    commitSha: text(b.commit_sha),
    number: typeof b.pr_number === "number" && Number.isInteger(b.pr_number) ? b.pr_number : null,
    url: githubUrl(b.pr_url),
    error: text(b.error),
  };
}

export function parseDiff(body: unknown): PlanDiff | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.diff !== "string" || typeof b.repo_url !== "string" || typeof b.base_ref !== "string") return null;
  if (!Array.isArray(b.tasks)) return null;
  const tasks = (b.tasks as unknown[]).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const { index, title } = t as Record<string, unknown>;
    return typeof index === "number" && typeof title === "string" ? [{ index, title }] : [];
  });
  let added = 0;
  let removed = 0;
  for (const line of b.diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { repoUrl: b.repo_url, baseRef: b.base_ref, tasks, diff: b.diff, lines: { added, removed } };
}

/** One sentence for where the pull request stands. */
export function prHeadline(pr: PullRequest | null): string {
  if (!pr) return "No pull request has been opened yet.";
  switch (pr.status) {
    case "queued":
      return "Waiting for the worker to pick this up…";
    case "running":
      return "Opening the pull request…";
    case "done":
      return pr.number ? `Pull request #${String(pr.number)} is open.` : "The pull request is open.";
    case "error":
      return `Opening the pull request failed: ${pr.error ?? "no reason was given"}. You can try again.`;
  }
}
