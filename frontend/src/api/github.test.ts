import { describe, expect, it } from "vitest";
import { GitHubError, getRepo, listBranches, listRepos, parseRepo, repoUrl } from "./github";

const answer = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const repo = (name: string) => ({
  name,
  full_name: `acme/${name}`,
  owner: { login: "acme" },
  default_branch: "trunk",
  description: null,
  language: "Python",
  pushed_at: "2026-10-30T10:00:00Z",
});

describe("parseRepo", () => {
  it("takes owner/name, a github.com path or its URL", () => {
    for (const input of [
      "acme/widgets",
      " github.com/acme/widgets ",
      "https://github.com/acme/widgets",
      "https://www.github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
    ]) {
      expect(parseRepo(input)).toEqual({ owner: "acme", name: "widgets" });
    }
  });

  it("refuses anything that is not one repository", () => {
    for (const input of [
      "",
      "acme",
      "acme/widgets/tree/main",
      "https://gitlab.com/acme/widgets",
      "-acme/x",
      "acme/..",
    ]) {
      expect(parseRepo(input)).toBeNull();
    }
  });

  it("builds the https URL the API expects", () => {
    expect(repoUrl({ owner: "acme", name: "widgets" })).toBe("https://github.com/acme/widgets");
  });
});

describe("the GitHub calls", () => {
  it("lists repositories and skips rows that are not repositories", async () => {
    const list = await listRepos("acme", answer(200, [repo("widgets"), { nope: true }, repo("api")]));
    expect(list.map((r) => [r.fullName, r.defaultBranch])).toEqual([
      ["acme/widgets", "trunk"],
      ["acme/api", "trunk"],
    ]);
  });

  it("reads one repository and its branches", async () => {
    expect((await getRepo("acme", "widgets", answer(200, repo("widgets")))).defaultBranch).toBe("trunk");
    expect(await listBranches("acme", "widgets", answer(200, [{ name: "trunk" }, { name: "fix/x" }, {}]))).toEqual([
      "trunk",
      "fix/x",
    ]);
  });

  it("explains a missing repository, the rate limit and an unreachable GitHub in words", async () => {
    await expect(getRepo("acme", "gone", answer(404, {}))).rejects.toThrow("no public repository");
    await expect(listRepos("acme", answer(403, {}))).rejects.toThrow("limit");
    await expect(listRepos("acme", () => Promise.reject(new Error("offline")))).rejects.toBeInstanceOf(GitHubError);
  });
});
