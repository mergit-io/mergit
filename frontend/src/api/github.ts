/**
 * The public GitHub REST API, called from the browser for the new-run repository and branch pickers. It needs no
 * token: it sees public repositories only, and allows 60 requests an hour per address. Every failure becomes a sentence
 * the picker shows, and the form still takes a repository typed by hand.
 */

const API = "https://api.github.com";

export type Repo = {
  owner: string;
  name: string;
  /** `owner/name`, as GitHub shows it. */
  fullName: string;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  /** When it was last pushed to, ISO 8601. */
  pushedAt: string | null;
};

export class GitHubError extends Error {}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** `owner/name` from what someone typed: `owner/name`, `github.com/owner/name` or its https URL, with or without `.git`. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const text = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1], name: match[2] };
}

/** The https URL the API takes for a repository. */
export const repoUrl = (r: { owner: string; name: string }) => `https://github.com/${r.owner}/${r.name}`;

function toRepo(raw: unknown): Repo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const owner = (r.owner as Record<string, unknown> | undefined)?.login;
  if (typeof r.name !== "string" || typeof owner !== "string" || typeof r.full_name !== "string") return null;
  return {
    owner,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main",
    description: typeof r.description === "string" ? r.description : null,
    language: typeof r.language === "string" ? r.language : null,
    pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : null,
  };
}

async function get(path: string, fetchImpl: Fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new GitHubError("GitHub cannot be reached right now.");
  }
  if (response.status === 404) throw new GitHubError("GitHub has no public repository by that name.");
  if (response.status === 403 || response.status === 429) {
    throw new GitHubError("GitHub's limit for this network is used up for now. Type the repository instead.");
  }
  if (!response.ok) throw new GitHubError(`GitHub answered ${String(response.status)}.`);
  return response.json();
}

/** A user's or organisation's public repositories, most recently pushed first. */
export async function listRepos(login: string, fetchImpl: Fetch = fetch): Promise<Repo[]> {
  const body = await get(`/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&type=owner`, fetchImpl);
  if (!Array.isArray(body)) throw new GitHubError("GitHub did not answer with a list of repositories.");
  return body.flatMap((r) => toRepo(r) ?? []);
}

/** One public repository, to confirm it exists and learn its default branch. */
export async function getRepo(owner: string, name: string, fetchImpl: Fetch = fetch): Promise<Repo> {
  const repo = toRepo(await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, fetchImpl));
  if (!repo) throw new GitHubError("GitHub did not answer with a repository.");
  return repo;
}

/** A repository's branches, by name. */
export async function listBranches(owner: string, name: string, fetchImpl: Fetch = fetch): Promise<string[]> {
  const body = await get(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`,
    fetchImpl,
  );
  if (!Array.isArray(body)) throw new GitHubError("GitHub did not answer with a list of branches.");
  return body.flatMap((b: unknown) => {
    const n = (b as Record<string, unknown> | null)?.name;
    return typeof n === "string" ? [n] : [];
  });
}
