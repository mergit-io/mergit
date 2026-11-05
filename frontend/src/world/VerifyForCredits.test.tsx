// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../auth/context";

const hoisted = vi.hoisted(() => ({
  fetchWorldConfig: vi.fn(),
  fetchRpContext: vi.fn(),
  widgetProps: { current: null as Record<string, unknown> | null },
  proof: { protocol_version: "4.0", action: "mergit-free-trial", responses: [] },
}));

vi.mock("../chain/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chain/wallet")>()),
  apiBase: () => "https://api.test",
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchWorldConfig: hoisted.fetchWorldConfig,
  fetchRpContext: hoisted.fetchRpContext,
}));

// Same stand-in as `FundingChoice.test.tsx`: "mock-proof" behaves as `@worldcoin/idkit@4.6.0` does once
// World App returns a proof -- `handleVerify`, then `onSuccess`, or only `onError("failed_by_host_app")`.
vi.mock("@worldcoin/idkit", () => ({
  IDKitRequestWidget: (props: Record<string, unknown>) => {
    hoisted.widgetProps.current = props;
    if (!props.open) return null;
    return (
      <button
        type="button"
        onClick={() => {
          void Promise.resolve((props.handleVerify as (r: unknown) => unknown)(hoisted.proof)).then(
            () => {
              (props.onSuccess as (r: unknown) => void)(hoisted.proof);
            },
            () => {
              (props.onError as (code: string) => void)("failed_by_host_app");
            },
          );
        }}
      >
        mock-proof
      </button>
    );
  },
  CredentialRequest: (type: string) => ({ type }),
  IDKitErrorCodes: { FailedByHostApp: "failed_by_host_app" },
  selfieCheck: () => ({ type: "SelfieCheck" }),
}));

import { VerifyForCredits } from "./VerifyForCredits";

const CONFIG = {
  idkit: {
    enabled: true,
    app_id: "app_test123",
    action: "mergit-free-trial",
    preset: "selfie_check",
    rp_id: "rp_0000000000000001",
    environment: "production",
  },
  agentPassEnabled: false,
};

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const refreshAccount = vi.fn(() => Promise.resolve());

function renderIt(onVerified: () => void) {
  return render(
    <AuthContext.Provider
      value={{
        session: null,
        account: null,
        ready: true,
        refreshAccount,
        openConnect: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
      }}
    >
      <VerifyForCredits onVerified={onVerified} />
    </AuthContext.Provider>,
  );
}

async function pressVerifyAndProve() {
  act(() => {
    screen.getByRole("button", { name: "Verify with World ID" }).click();
  });
  await screen.findByRole("button", { name: "mock-proof" });
  act(() => {
    screen.getByRole("button", { name: "mock-proof" }).click();
  });
}

describe("VerifyForCredits", () => {
  beforeEach(() => {
    hoisted.fetchWorldConfig.mockReset();
    hoisted.fetchRpContext.mockReset();
    hoisted.fetchRpContext.mockResolvedValue({ sig: "0xsig", nonce: "0xnonce", created_at: 1, expires_at: 301 });
    refreshAccount.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("posts the proof to /v0/account/trial, refreshes the account and lets the approval go on", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(CONFIG);
    const fetchMock = vi.fn(() => reply(200, { started_at: "2026-10-01T00:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);
    const onVerified = vi.fn();
    renderIt(onVerified);
    await screen.findByRole("button", { name: "Verify with World ID" });

    await pressVerifyAndProve();

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledOnce();
    });
    expect(refreshAccount).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v0/account/trial");
    expect(JSON.parse(init.body as string)).toEqual({ world_proof: hoisted.proof });
  });

  it("shows the server's refusal when that human was already claimed by another account", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(CONFIG);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(403, { detail: "the free credits were already used by this person" })),
    );
    const onVerified = vi.fn();
    renderIt(onVerified);
    await screen.findByRole("button", { name: "Verify with World ID" });

    await pressVerifyAndProve();

    expect(await screen.findByRole("alert")).toHaveTextContent("the free credits were already used by this person");
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Verify with World ID" })).toBeEnabled();
  });

  it("says so, instead of a dead button, when World ID cannot be started here", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(null);
    renderIt(vi.fn());
    expect(await screen.findByRole("status")).toHaveTextContent(/cannot be started/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
