import { useEffect, useState } from "react";
import { getRepo, GitHubError, listBranches, listRepos, type Repo } from "../../../api/github";

const message = (e: unknown) => (e instanceof GitHubError ? e.message : "GitHub could not be read right now.");

/** Public repositories of a GitHub user or organisation, most recently pushed first. Nothing is fetched for null. */
export function useRepoList(login: string | null) {
  const [state, setState] = useState<{ login: string; repos: Repo[] | null; error?: string } | null>(null);
  useEffect(() => {
    if (!login) return;
    let live = true;
    listRepos(login).then(
      (repos) => {
        if (live) setState({ login, repos });
      },
      (e: unknown) => {
        if (live) setState({ login, repos: null, error: message(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [login]);
  // A result for another login (the one before a change) is not shown.
  const current = state && state.login === login ? state : null;
  return { repos: current?.repos ?? null, error: current?.error, loading: Boolean(login) && current === null };
}

const DEBOUNCE_MS = 400;

/**
 * A repository's branches and its default branch. Waits until the name has stopped changing, so typing does not spend
 * GitHub's limit.
 */
export function useBranches(repo: { owner: string; name: string } | null) {
  const key = repo ? `${repo.owner}/${repo.name}` : null;
  const [state, setState] = useState<{
    key: string;
    branches: string[] | null;
    defaultBranch: string | null;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    const [owner = "", name = ""] = key.split("/");
    let live = true;
    const timer = window.setTimeout(() => {
      // Independent: the branches still show if only the repository lookup fails, and the other way round.
      void Promise.allSettled([getRepo(owner, name), listBranches(owner, name)]).then(([repoResult, branchResult]) => {
        if (!live) return;
        setState({
          key,
          branches: branchResult.status === "fulfilled" ? branchResult.value : null,
          defaultBranch: repoResult.status === "fulfilled" ? repoResult.value.defaultBranch : null,
          error: branchResult.status === "rejected" ? message(branchResult.reason) : undefined,
        });
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key]);
  const current = state && state.key === key ? state : null;
  return {
    branches: current?.branches ?? null,
    defaultBranch: current?.defaultBranch ?? null,
    error: current?.error,
    loading: Boolean(key) && current === null,
  };
}
