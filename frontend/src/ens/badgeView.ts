import type { FailureReason } from "../chain/ens/agentEns.ts";
import type { AgentEnsState } from "../chain/useAgentEns";
import type { IconName } from "../components/Icon";

export type BadgeView = {
  /** One of the `.badge` colour classes in components.css. */
  className: "b-ok" | "b-run" | "b-fail" | "b-wait" | "b-n";
  icon: IconName;
  label: string;
  /** Why it is not verified, in words; null when there is nothing to explain. */
  reason: string | null;
  /** The only flag that may draw a tick: true for the read layer's `verified` badge and nothing else. */
  tick: boolean;
};

const REASONS: Record<FailureReason, string> = {
  "no-registration-record": "The ENS name does not attest to this agent (no agent-registration record).",
  "unknown-agent": "This agent is not registered in the Identity contract.",
  "no-metadata-uri": "The agent was registered without a registration file, so it cannot name its ENS name.",
  "unsupported-uri": "The agent's registration file is not at an https address.",
  "registration-file-unreachable": "The agent's registration file could not be fetched.",
  "registration-file-invalid": "The agent's registration file is not in the expected format.",
  "name-mismatch": "The agent's registration file names a different ENS name.",
  "registration-not-listed": "The agent's registration file does not list this agent.",
  "read-failed": "ENS or the settlement chain could not be read, so the link cannot be confirmed.",
};

/** The fail reason in words, for screens that show it outside the badge. */
export const failReason = (reason: FailureReason): string => REASONS[reason];

/**
 * How an agent's ENS state is drawn. Every surface goes through this, so a tick can only come from the read layer's
 * `verified` badge (two-way check passed and the operator on ENS is the operator on Base).
 */
export function ensBadgeView(s: AgentEnsState): BadgeView {
  switch (s.state) {
    case "loading":
      return { className: "b-n", icon: "clock", label: "Checking ENS…", reason: null, tick: false };
    case "none":
      return {
        className: "b-n",
        icon: "x",
        label: "No ENS name",
        reason: "This agent's name is not a valid ENS label, so it has no name under the parent.",
        tick: false,
      };
    case "error":
      return { className: "b-n", icon: "x", label: "ENS unavailable", reason: s.message, tick: false };
    case "ready": {
      const v = s.value;
      switch (v.badge) {
        case "verified":
          return { className: "b-ok", icon: "tick", label: "Two-way verified", reason: null, tick: true };
        case "unconfirmed":
          return {
            className: "b-run",
            icon: "link",
            label: "Linked, owner not confirmed",
            reason:
              "The name and the agent point at each other, but the operator is not recorded on ENS yet, so a sale cannot be ruled out.",
            tick: false,
          };
        case "owner-changed":
          return {
            className: "b-wait",
            icon: "hand",
            label: "Owner changed, not verified",
            reason:
              "The agent's owner on Base is not the operator recorded on ENS: it was sold since ENS was last updated.",
            tick: false,
          };
        case "not-verified":
          return {
            className: "b-fail",
            icon: "fail",
            label: "Not verified",
            reason: v.verification.status === "failed" ? REASONS[v.verification.reason] : null,
            tick: false,
          };
      }
    }
  }
}
