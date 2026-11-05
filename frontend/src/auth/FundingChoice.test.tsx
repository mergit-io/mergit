// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "./account";
import { AuthContext } from "./context";

const hoisted = vi.hoisted(() => ({
  fetchWorldConfig: vi.fn(),
  fetchRpContext: vi.fn(),
  idkitOpenProps: { current: null as Record<string, unknown> | null },
  proof: { protocol_version: "4.0", action: "mergit-free-trial", responses: [] },
}));

// The API address comes from the build's environment, which unit tests do not have (same stub
// `startTrial.test.ts` uses).
vi.mock("../chain/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chain/wallet")>()),
  apiBase: () => "https://api.test",
}));

vi.mock("../world/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../world/api")>()),
  fetchWorldConfig: hoisted.fetchWorldConfig,
  fetchRpContext: hoisted.fetchRpContext,
}));

// A stand-in for the real widget (which drives a QR/World App connect flow -- nothing a unit test should
// exercise): exposes two buttons so a test can act as IDKit itself would, by calling the same props
// `TrialVerify` passes it (`onOpenChange`, `handleVerify`, `onSuccess`, `onError`). "mock-proof" does what
// `@worldcoin/idkit@4.6.0`'s `IDKitWidgetBase` does once World App returns a proof: runs `handleVerify`,
// then `onSuccess` if it resolved -- or, if it rejected, *discards the error* and reports only
// `onError("failed_by_host_app")` (its `startHostVerify` is `.then(passed).catch(() => failed)`).
vi.mock("@worldcoin/idkit", () => ({
  IDKitRequestWidget: (props: Record<string, unknown>) => {
    hoisted.idkitOpenProps.current = props;
    if (!props.open) return null;
    return (
      <div data-testid="idkit-widget">
        <button
          type="button"
          onClick={() => {
            (props.onOpenChange as (open: boolean) => void)(false);
          }}
        >
          mock-cancel
        </button>
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
      </div>
    );
  },
  CredentialRequest: (type: string) => ({ type }),
  IDKitErrorCodes: { FailedByHostApp: "failed_by_host_app" },
  proofOfHuman: () => ({ type: "ProofOfHuman" }),
  selfieCheck: () => ({ type: "SelfieCheck" }),
}));

import { FundingChoice } from "./FundingChoice";

const account: Account = {
  userId: "user-1",
  address: "0xabc",
  name: "Ada",
  email: null,
  avatarUrl: null,
  identities: [],
  wallets: [],
  trialAddress: "0xtrial",
  trialStartedAt: null,
};

const refreshAccount = vi.fn(() => Promise.resolve());

const WORLD_CONFIG = {
  idkit: {
    enabled: true,
    app_id: "app_test123",
    action: "mergit-free-trial",
    preset: "selfie_check",
    rp_id: "rp_0000000000000001",
    environment: "staging",
  },
  agentPassEnabled: false,
};

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Waits for `/v0/world/config` to swap in `TrialVerify`'s button, presses it, and waits for the widget. */
async function openWidget() {
  await screen.findByRole("button", { name: "Start free" });
  await waitFor(() => {
    act(() => {
      screen.getByRole("button", { name: "Start free" }).click();
    });
    expect(hoisted.fetchRpContext).toHaveBeenCalledWith("mergit-free-trial");
  });
  await waitFor(() => {
    expect(screen.getByTestId("idkit-widget")).toBeInTheDocument();
  });
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthContext.Provider
        value={{
          session: null,
          account,
          ready: true,
          refreshAccount,
          openConnect: vi.fn(),
          signIn: vi.fn(),
          signOut: vi.fn(),
        }}
      >
        <FundingChoice />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("FundingChoice", () => {
  beforeEach(() => {
    hoisted.fetchWorldConfig.mockReset();
    hoisted.fetchRpContext.mockReset();
    hoisted.idkitOpenProps.current = null;
    refreshAccount.mockClear();
    hoisted.fetchRpContext.mockResolvedValue({ sig: "0xsig", nonce: "0xnonce", created_at: 1, expires_at: 301 });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the wallet option after a cancelled verification", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue({
      idkit: {
        enabled: true,
        app_id: "app_test123",
        action: "mergit-free-trial",
        preset: "selfie_check",
        rp_id: "rp_0000000000000001",
        environment: null,
      },
      agentPassEnabled: false,
    });
    hoisted.fetchRpContext.mockResolvedValue({
      sig: "0xsig",
      nonce: "0xnonce",
      created_at: 1,
      expires_at: 301,
    });

    renderDialog();

    await screen.findByRole("button", { name: "Start free" });
    const walletButton = () => screen.getByRole("button", { name: /connect a wallet/i });

    // Before touching World ID at all, the wallet option is already there and usable.
    expect(walletButton()).toBeEnabled();

    // `/v0/world/config` resolving swaps the plain button for `TrialVerify`'s own (same label, now backed by
    // the widget) -- click the one currently on screen until that has happened and the click actually asked
    // for a fresh RP context, rather than racing the config fetch with a button reference grabbed too early.
    await waitFor(() => {
      act(() => {
        screen.getByRole("button", { name: "Start free" }).click();
      });
      expect(hoisted.fetchRpContext).toHaveBeenCalledWith("mergit-free-trial");
    });

    // The widget is now open -- the wallet option is disabled while the free-trial attempt is in flight,
    // same as the plain button's own "Starting..." would do.
    await waitFor(() => {
      expect(screen.getByTestId("idkit-widget")).toBeInTheDocument();
    });
    expect(walletButton()).toBeDisabled();

    act(() => {
      screen.getByRole("button", { name: "mock-cancel" }).click();
    });

    // Cancelled, not approved: nothing was sent to the server, and the dialog's other option is usable
    // again -- the person is not stuck behind a "Starting..." that never clears.
    expect(walletButton()).toBeEnabled();
    expect(screen.queryByTestId("idkit-widget")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Start free" })).toBeEnabled();
  });

  it("keeps today's plain button when World ID is off or its config cannot be read", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(null);
    renderDialog();
    const startButton = await screen.findByRole("button", { name: "Start free" });
    expect(hoisted.fetchRpContext).not.toHaveBeenCalled();
    expect(screen.queryByTestId("idkit-widget")).not.toBeInTheDocument();
    expect(startButton).toBeEnabled();
  });

  it("hands the widget everything IDKit 4 needs, from the server's config", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(WORLD_CONFIG);
    renderDialog();
    await openWidget();
    const props = hoisted.idkitOpenProps.current;
    expect(props).toMatchObject({
      app_id: "app_test123",
      action: "mergit-free-trial",
      environment: "staging",
      allow_legacy_proofs: false,
      preset: { type: "SelfieCheck" },
      rp_context: {
        rp_id: "rp_0000000000000001",
        nonce: "0xnonce",
        created_at: 1,
        expires_at: 301,
        signature: "0xsig",
      },
    });
    expect(props).not.toHaveProperty("constraints");
  });

  it("asks for the 4.0 proof-of-human credential directly, not the preset that re-enables 3.0 fallback", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue({
      ...WORLD_CONFIG,
      idkit: { ...WORLD_CONFIG.idkit, preset: "proof_of_human" },
    });
    renderDialog();
    await openWidget();
    const props = hoisted.idkitOpenProps.current;
    expect(props).toMatchObject({ allow_legacy_proofs: false, constraints: { type: "proof_of_human" } });
    expect(props).not.toHaveProperty("preset");
  });

  it("sends the proof to /v0/account/trial and refreshes the account once it is accepted", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(WORLD_CONFIG);
    const fetchMock = vi.fn(() => reply(200, { started_at: "2026-11-06T00:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();
    await openWidget();

    act(() => {
      screen.getByRole("button", { name: "mock-proof" }).click();
    });

    await waitFor(() => {
      expect(refreshAccount).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v0\/account\/trial$/);
    expect(JSON.parse(init.body as string)).toEqual({ world_proof: hoisted.proof });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows Mergit's own refusal when handleVerify fails, not IDKit's generic failed_by_host_app", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(WORLD_CONFIG);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(403, { detail: "the free credits were already used by this person" })),
    );
    renderDialog();
    await openWidget();

    act(() => {
      screen.getByRole("button", { name: "mock-proof" }).click();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("the free credits were already used by this person");
    expect(screen.getByRole("alert")).not.toHaveTextContent("failed_by_host_app");
    expect(refreshAccount).not.toHaveBeenCalled();
  });

  it("explains a proof World rejected, by its reason", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(WORLD_CONFIG);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(403, { detail: { code: "world_proof_rejected", reason: "legacy_proof" } })),
    );
    renderDialog();
    await openWidget();

    act(() => {
      screen.getByRole("button", { name: "mock-proof" }).click();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/World ID 4\.0/);
  });

  it("still names the IDKit error code when the failure was IDKit's own, not Mergit's", async () => {
    hoisted.fetchWorldConfig.mockResolvedValue(WORLD_CONFIG);
    renderDialog();
    await openWidget();

    act(() => {
      (hoisted.idkitOpenProps.current?.onError as (code: string) => void)("verification_rejected");
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("(verification_rejected)");
  });
});
