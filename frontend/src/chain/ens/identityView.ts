import type { AgentEns, FailureReason } from "./agentEns.ts";

/**
 * The same shape as `useAgentEns`'s result (chain/useAgentEns.ts). It is restated here, not imported, because files in
 * this folder import nothing from the rest of the app (the fork tests in ens/ load them with plain Node).
 */
export type AgentEnsState =
  { state: "loading" } | { state: "none" } | { state: "ready"; value: AgentEns } | { state: "error"; message: string };

export type Tone = "ok" | "weak" | "warn" | "bad" | "none";

/** What the identity badge says. Always a word as well as a tone, so the state is never told by colour alone. */
export type IdentityView = {
  tone: Tone;
  icon: "tick" | "clock" | "warn" | "fail" | null;
  label: string;
  /** A sentence that explains the label, for the badge's title and screen readers. */
  hint: string;
  /** True only for "verified". */
  showTick: boolean;
  /** Whether the agent has an ENS name, so its profile page exists. */
  link: boolean;
};

/** Every reason the two-way check can fail, in the order agentEns.ts checks them. */
export const FAILURE_REASONS = [
  "read-failed",
  "unknown-agent",
  "no-registration-record",
  "no-metadata-uri",
  "unsupported-uri",
  "registration-file-unreachable",
  "registration-file-invalid",
  "name-mismatch",
  "registration-not-listed",
] as const satisfies readonly FailureReason[];

/** What a failed check means, as a plain sentence. */
export function failureText(reason: FailureReason): string {
  switch (reason) {
    case "read-failed":
      return "The records the check needs could not be read this time.";
    case "unknown-agent":
      return "This agent is not registered in the Identity registry on Base.";
    case "no-registration-record":
      return "The ENS name has no record that points at this agent's registry entry.";
    case "no-metadata-uri":
      return "The agent's registry entry on Base has no registration file.";
    case "unsupported-uri":
      return "The agent's registration file is not at an https address, so it was not checked.";
    case "registration-file-unreachable":
      return "The agent's registration file could not be fetched.";
    case "registration-file-invalid":
      return "The agent's registration file is not a valid registration file.";
    case "name-mismatch":
      return "The agent's registration file names a different ENS name.";
    case "registration-not-listed":
      return "The agent's registration file does not list this registry entry.";
    default: {
      const unknown: never = reason;
      return unknown;
    }
  }
}

const BOTH_WAYS = "The ENS name and the agent's registry entry on Base point at each other";

function readyView(ens: AgentEns): IdentityView {
  const base = { link: true, showTick: false };
  let view: IdentityView;
  switch (ens.badge) {
    case "verified":
      view = {
        ...base,
        tone: "ok",
        icon: "tick",
        label: "Verified on ENS",
        hint: `${BOTH_WAYS}, and the operator recorded on ENS is still the operator on Base.`,
        showTick: true,
      };
      break;
    case "unconfirmed":
      view = {
        ...base,
        tone: "weak",
        icon: "clock",
        label: "ENS match, owner not confirmed",
        hint: `${BOTH_WAYS}, but the operator is not recorded on ENS yet, so a change of owner cannot be ruled out.`,
      };
      break;
    case "owner-changed":
      view = {
        ...base,
        tone: "warn",
        icon: "warn",
        label: "Owner changed since ENS was updated",
        hint: "The agent's operator on Base is not the one recorded on ENS: it changed hands after its ENS records were last updated.",
      };
      break;
    case "not-verified":
      view = {
        ...base,
        tone: "bad",
        icon: "fail",
        label: "Not verified on ENS",
        hint:
          ens.verification.status === "failed"
            ? failureText(ens.verification.reason)
            : "The two-way check between ENS and Base did not pass.",
      };
      break;
    default:
      // Anything the reader did not promise is shown as not verified: never a tick by accident.
      view = { ...base, tone: "bad", icon: "fail", label: "Not verified on ENS", hint: "The check did not pass." };
  }
  if (ens.unreadable.length > 0) {
    view = { ...view, hint: `${view.hint} Some details could not be read this time: ${ens.unreadable.join(", ")}.` };
  }
  return view;
}

/** What to show for an agent's ENS state. Only a "verified" result ever gets a tick. */
export function identityView(state: AgentEnsState): IdentityView {
  switch (state.state) {
    case "none":
      return {
        tone: "none",
        icon: null,
        label: "No ENS name",
        hint: "This agent's name is not an ENS label, so it has no ENS name.",
        showTick: false,
        link: false,
      };
    case "loading":
      return {
        tone: "none",
        icon: null,
        label: "Checking ENS",
        hint: "The ENS records are being read.",
        showTick: false,
        link: true,
      };
    case "error":
      return {
        tone: "none",
        icon: null,
        label: "ENS unavailable",
        hint: state.message || "The ENS records could not be read. Try again in a moment.",
        showTick: false,
        link: true,
      };
    case "ready":
      return readyView(state.value);
  }
}
