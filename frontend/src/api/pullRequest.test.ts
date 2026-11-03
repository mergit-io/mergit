import { describe, expect, it } from "vitest";
import { parseDiff, parsePullRequest, prHeadline } from "./pullRequest";

const pr = (over: Record<string, unknown> = {}) => ({
  plan_uuid: "0b7f6a52-3a7c-4c2e-9d1f-1c0e5a6b7d88",
  requested_by: "0x1725a458a3fc8bb3d7460d262c7f94766fef585d",
  status: "queued",
  branch: null,
  commit_sha: null,
  pr_number: null,
  pr_url: null,
  error: null,
  ...over,
});

describe("parsePullRequest", () => {
  it("reads a request that is waiting for the worker", () => {
    expect(parsePullRequest(pr())).toEqual({
      status: "queued",
      branch: null,
      commitSha: null,
      number: null,
      url: null,
      error: null,
    });
  });

  it("reads a finished request with its link", () => {
    const done = parsePullRequest(
      pr({
        status: "done",
        branch: "mergit/0b7f6a52",
        commit_sha: "a".repeat(40),
        pr_number: 7,
        pr_url: "https://github.com/mergit-io/demo-repo/pull/7",
      }),
    );
    expect(done).toMatchObject({ status: "done", number: 7, url: "https://github.com/mergit-io/demo-repo/pull/7" });
  });

  it("does not trust a link that is not an https GitHub address: it goes into an href", () => {
    for (const url of [
      "javascript:alert(1)",
      "http://github.com/a/b/pull/1",
      "https://evil.example/a/b/pull/1",
      "https://github.com.evil.example/x",
      "//github.com/a/b/pull/1",
    ]) {
      expect(parsePullRequest(pr({ status: "done", pr_url: url }))?.url, url).toBeNull();
    }
  });

  it("is null for anything that is not a request, and for a status it does not know", () => {
    expect(parsePullRequest(null)).toBeNull();
    expect(parsePullRequest({})).toBeNull();
    expect(parsePullRequest(pr({ status: "exploded" }))).toBeNull();
  });
});

describe("parseDiff", () => {
  it("reads the tasks and the combined diff", () => {
    const d = parseDiff({
      plan_uuid: "p",
      repo_url: "https://github.com/mergit-io/demo-repo",
      base_ref: "main",
      tasks: [{ index: 0, title: "Clamp the refund", task_id: "0x" + "ab".repeat(32) }],
      diff: "--- a/x\n+++ b/x\n@@\n-old\n+new\n",
    });
    expect(d).toEqual({
      repoUrl: "https://github.com/mergit-io/demo-repo",
      baseRef: "main",
      tasks: [{ index: 0, title: "Clamp the refund" }],
      diff: "--- a/x\n+++ b/x\n@@\n-old\n+new\n",
      lines: { added: 1, removed: 1 },
    });
  });

  it("counts changed lines without counting the file headers", () => {
    const d = parseDiff({
      repo_url: "r",
      base_ref: "main",
      tasks: [],
      diff: "--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n-a\n+b\n+c\n context\n",
    });
    expect(d?.lines).toEqual({ added: 2, removed: 1 });
  });

  it("is null for an answer that is not a diff", () => {
    expect(parseDiff(null)).toBeNull();
    expect(parseDiff({ diff: 5 })).toBeNull();
    expect(parseDiff({ repo_url: "r", base_ref: "m", tasks: "nope", diff: "" })).toBeNull();
  });
});

describe("prHeadline", () => {
  it("says what is happening at each stage, in words", () => {
    expect(prHeadline(null)).toMatch(/no pull request has been opened/i);
    expect(
      prHeadline({ status: "queued", branch: null, commitSha: null, number: null, url: null, error: null }),
    ).toMatch(/waiting/i);
    expect(
      prHeadline({ status: "running", branch: null, commitSha: null, number: null, url: null, error: null }),
    ).toMatch(/opening/i);
    expect(
      prHeadline({
        status: "done",
        branch: "b",
        commitSha: "s",
        number: 7,
        url: "https://github.com/a/b/pull/7",
        error: null,
      }),
    ).toBe("Pull request #7 is open.");
  });

  it("shows why a request failed, and that asking again is allowed", () => {
    const text = prHeadline({
      status: "error",
      branch: null,
      commitSha: null,
      number: null,
      url: null,
      error: "patch does not apply",
    });
    expect(text).toContain("patch does not apply");
    expect(text).toMatch(/try again/i);
  });
});
