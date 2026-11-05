import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";

const APPROVAL_ID = "a1111111-1111-1111-1111-111111111111";
const START_URL = `/v0/world/approvals/${APPROVAL_ID}/start`;
const ORIGIN = "https://mergit.site";

vi.mock("./api", () => ({
  getApprovalStatus: vi.fn(),
  resolveApiUrl: (path: string) => `https://api.mergit.site${path}`,
}));

// Imported after the mock so `getApprovalStatus` below is the mocked function (vi.mock is hoisted).
import { getApprovalStatus } from "./api";
import { withHumanApproval, type ApprovalOutcome, type ApprovalRequired } from "./humanApproval";

/** Asserts a `withHumanApproval` rejection: a 403 `ApiError` whose message contains `fragment`. Spelled out
 * as a plain assertion rather than `rejects.toMatchObject({ message: expect.stringContaining(...) })`,
 * which types the asymmetric matcher as `any` once it sits inside an object literal. */
async function expectDenied(promise: Promise<unknown>, fragment: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(403);
  expect((error as ApiError).message).toContain(fragment);
}

function approvalError(expiresAt = "2026-11-06T00:00:10.000Z") {
  return new ApiError(428, "needs approval", [], {
    code: "human_approval_required",
    approval_id: APPROVAL_ID,
    start_url: START_URL,
    expires_at: expiresAt,
    summary: { goal: "ship it" },
  });
}

/** What the real `HumanApprovalDialog` does on its own "Continue" click: open the popup itself, synchronously,
 * and hand the result to `withHumanApproval` as the outcome -- `withHumanApproval` never calls `window.open`
 * itself (plan sec 1.7's binding ruling: a popup blocker only reliably honors a call made directly inside the
 * click, not a later `await`-ed continuation). These mocks stand in for that click. */
function approve(req: ApprovalRequired): Promise<ApprovalOutcome> {
  const popup = window.open(`https://api.mergit.site${req.start_url}`, "mergit-world-approval", "width=480,height=760");
  return Promise.resolve({ approved: true, popup });
}
const cancel = (): Promise<ApprovalOutcome> => Promise.resolve({ approved: false });

/** A `window` stand-in good enough for `humanApproval.ts`: `message` listeners it can be told to fire, and
 * `setInterval`/`clearInterval` delegated to the real (or faked, per test) globals. */
function fakeWindow(open: ReturnType<typeof vi.fn>) {
  const listeners: ((event: { origin: string; data: unknown }) => void)[] = [];
  return {
    open,
    location: { origin: ORIGIN },
    addEventListener: (_type: string, handler: (event: { origin: string; data: unknown }) => void) => {
      listeners.push(handler);
    },
    removeEventListener: (_type: string, handler: (event: { origin: string; data: unknown }) => void) => {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
    setInterval: (handler: () => void, timeout?: number) => setInterval(handler, timeout),
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      clearInterval(id);
    },
    dispatch(origin: string, data: unknown) {
      for (const handler of [...listeners]) handler({ origin, data });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("withHumanApproval", () => {
  it("approves then retries with the approval id", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    const run = vi.fn().mockRejectedValueOnce(approvalError()).mockResolvedValueOnce("done");
    const confirm = vi.fn(approve);

    const promise = withHumanApproval(run, confirm);
    await vi.waitFor(() => {
      expect(win.open).toHaveBeenCalled();
    });
    expect(win.open.mock.calls[0]?.[0]).toBe(`https://api.mergit.site${START_URL}`);

    win.dispatch(ORIGIN, { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "approved" });

    await expect(promise).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, APPROVAL_ID);
  });

  it("rejects when the popup cannot open", async () => {
    const win = fakeWindow(vi.fn(() => null));
    vi.stubGlobal("window", win);
    const run = vi.fn().mockRejectedValueOnce(approvalError());
    const confirm = vi.fn(approve); // the dialog's own window.open returns null (blocked); confirm still resolves

    await expectDenied(withHumanApproval(run, confirm), "blocked");
    expect(run).toHaveBeenCalledTimes(1);
    expect(getApprovalStatus).not.toHaveBeenCalled();
  });

  it("rejects when the human cancels and never retries", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    const run = vi.fn().mockRejectedValueOnce(approvalError());
    const confirm = vi.fn(cancel);

    await expectDenied(withHumanApproval(run, confirm), "not given");
    expect(run).toHaveBeenCalledTimes(1);
    expect(win.open).not.toHaveBeenCalled(); // declining never even attempts the popup
  });

  it("rejects on denied, says why, and never retries", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    // The popup's message carries only the status; the reason is read off the approval itself.
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "denied", reason: "access_denied", expires_at: "" });
    const run = vi.fn().mockRejectedValueOnce(approvalError());
    const confirm = vi.fn(approve);

    const promise = withHumanApproval(run, confirm);
    await vi.waitFor(() => {
      expect(win.open).toHaveBeenCalled();
    });
    win.dispatch(ORIGIN, { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "denied" });

    await expectDenied(promise, "You cancelled at World ID");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still rejects on a denied message when the reason cannot be fetched", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockRejectedValue(new Error("offline"));
    const run = vi.fn().mockRejectedValueOnce(approvalError());

    const promise = withHumanApproval(run, vi.fn(approve));
    await vi.waitFor(() => {
      expect(win.open).toHaveBeenCalled();
    });
    win.dispatch(ORIGIN, { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "denied" });

    await expectDenied(promise, "not given");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores messages from other origins", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    const run = vi.fn().mockRejectedValueOnce(approvalError()).mockResolvedValueOnce("done");
    const confirm = vi.fn(approve);

    const promise = withHumanApproval(run, confirm);
    await vi.waitFor(() => {
      expect(win.open).toHaveBeenCalled();
    });
    // A denial from the wrong origin must not settle anything; only the same-origin approval counts.
    win.dispatch("https://evil.example", { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "denied" });
    win.dispatch(ORIGIN, { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "approved" });

    await expect(promise).resolves.toBe("done");
  });

  it("stops polling at expires_at", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const expiresAt = new Date(start + 3000).toISOString();
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "pending", reason: null, expires_at: expiresAt });
    const run = vi.fn().mockRejectedValueOnce(approvalError(expiresAt));
    const confirm = vi.fn(approve);

    const promise = withHumanApproval(run, confirm);
    const captured = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0); // flush run()/confirm()/window.open before the first poll tick
    await vi.advanceTimersByTimeAsync(2000); // first tick: still pending, before expiry
    expect(getApprovalStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // second tick: now past expires_at
    const error = await captured;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toContain("expired");
    expect(getApprovalStatus).toHaveBeenCalledTimes(1); // no poll past expiry
  });

  it.each([
    ["different_human", "not the one linked to your Mergit account"],
    ["linked_to_another_account", "already linked to a different Mergit account"],
    ["stale_auth_time", "did not sign you in fresh"],
    ["missing_pop", "did not confirm you were present"],
  ])("shows the person why a polled approval was denied (%s)", async (reason, words) => {
    vi.useFakeTimers();
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "denied", reason, expires_at: "" });
    const run = vi.fn().mockRejectedValueOnce(approvalError(new Date(Date.now() + 60_000).toISOString()));

    const captured = withHumanApproval(run, vi.fn(approve)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);

    const error = (await captured) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain(words);
    expect(error.message).not.toContain("not given");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reads World being unreachable as try again (503), not as approval refused", async () => {
    vi.useFakeTimers();
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "failed", reason: "world_unreachable", expires_at: "" });
    const run = vi.fn().mockRejectedValueOnce(approvalError(new Date(Date.now() + 60_000).toISOString()));

    const captured = withHumanApproval(run, vi.fn(approve)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);

    const error = (await captured) as ApiError;
    expect(error.status).toBe(503);
    expect(error.message).toContain("unreachable");
    expect(error.message).toContain("try again");
    expect(error.message).not.toContain("not given");
  });

  it("gives up at once when the person cancels the wait, closes the popup, and never retries", async () => {
    vi.useFakeTimers();
    const popup = { closed: false, close: vi.fn() };
    const win = fakeWindow(vi.fn(() => popup as unknown as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "pending", reason: null, expires_at: "" });
    const run = vi.fn().mockRejectedValueOnce(approvalError(new Date(Date.now() + 300_000).toISOString()));
    const controller = new AbortController();
    const confirm = (req: ApprovalRequired): Promise<ApprovalOutcome> => {
      const opened = window.open(`https://api.mergit.site${req.start_url}`, "mergit-world-approval");
      return Promise.resolve({ approved: true, popup: opened, cancelled: controller.signal });
    };
    const onWaitEnd = vi.fn();

    const captured = withHumanApproval(run, confirm, onWaitEnd).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4000); // still pending at World: the page is waiting
    expect(onWaitEnd).not.toHaveBeenCalled();

    controller.abort(); // the dialog's Cancel
    const error = (await captured) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("You cancelled the World ID check");
    expect(onWaitEnd).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);

    const polls = vi.mocked(getApprovalStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getApprovalStatus).toHaveBeenCalledTimes(polls); // nothing left polling
  });

  it("does not treat a popup that reads closed as a failure: it polls once at once and keeps waiting", async () => {
    // World's pages can send Cross-Origin-Opener-Policy, which makes `popup.closed` read true mid-check.
    vi.useFakeTimers();
    const popup = { closed: false, close: vi.fn() };
    const win = fakeWindow(vi.fn(() => popup as unknown as Window));
    vi.stubGlobal("window", win);
    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "pending", reason: null, expires_at: "" });
    const run = vi.fn().mockRejectedValueOnce(approvalError(new Date(Date.now() + 300_000).toISOString()));
    run.mockResolvedValueOnce("done");
    const onWaitEnd = vi.fn();

    const promise = withHumanApproval(run, vi.fn(approve), onWaitEnd);
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(600); // one closed-check, well before the 2 s poll tick
    expect(getApprovalStatus).toHaveBeenCalledTimes(1); // the immediate poll the closed popup prompted
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false); // still waiting: closed is a hint, never a verdict
    expect(onWaitEnd).not.toHaveBeenCalled();

    vi.mocked(getApprovalStatus).mockResolvedValue({ status: "approved", reason: null, expires_at: "" });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe("done");
    expect(onWaitEnd).toHaveBeenCalledOnce();
    expect(run).toHaveBeenNthCalledWith(2, APPROVAL_ID);
  });

  it("ends the wait before retrying the action, so the waiting dialog is gone by then", async () => {
    const win = fakeWindow(vi.fn(() => ({}) as Window));
    vi.stubGlobal("window", win);
    const order: string[] = [];
    const run = vi
      .fn()
      .mockRejectedValueOnce(approvalError())
      .mockImplementationOnce(() => {
        order.push("retry");
        return Promise.resolve("done");
      });

    const promise = withHumanApproval(run, vi.fn(approve), () => order.push("wait ended"));
    await vi.waitFor(() => {
      expect(win.open).toHaveBeenCalled();
    });
    win.dispatch(ORIGIN, { type: "mergit-world-approval", approval_id: APPROVAL_ID, status: "approved" });

    await expect(promise).resolves.toBe("done");
    expect(order).toEqual(["wait ended", "retry"]);
  });
});
