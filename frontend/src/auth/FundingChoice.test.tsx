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
}));

vi.mock("../world/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../world/api")>()),
  fetchWorldConfig: hoisted.fetchWorldConfig,
  fetchRpContext: hoisted.fetchRpContext,
}));

// A stand-in for the real widget (which drives a QR/World App connect flow -- nothing a unit test should
// exercise): exposes two buttons so a test can act as IDKit itself would, by calling the same props
// `TrialVerify` passes it (`onOpenChange`, `handleVerify`, `onSuccess`).
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
            void Promise.resolve((props.handleVerify as (r: unknown) => unknown)({ fake: true })).then(() => {
              (props.onSuccess as (r: unknown) => void)({ fake: true });
            });
          }}
        >
          mock-success
        </button>
      </div>
    );
  },
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

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AuthContext.Provider
        value={{
          session: null,
          account,
          ready: true,
          refreshAccount: vi.fn(() => Promise.resolve()),
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
});
