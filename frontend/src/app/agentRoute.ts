import { PARENT_NAME, ensNameOf, labelForAgent } from "../chain/ens/names.ts";

const SUFFIX = `.${PARENT_NAME}`;

/** The router pattern for the public profile page. It is public, so it sits outside the session gate and the app base. */
export const AGENT_ROUTE = "/agents/:ensName";

/** The public profile page of the agent with ENS label `label`: `/agents/<label>.mergit.eth`. Throws for an invalid label. */
export function agentPath(label: string): string {
  return `/agents/${ensNameOf(label)}`;
}

/**
 * The agent label in a profile URL's `:ensName`, or null if it is not one. `canonical` is true only for the exact full
 * name (`coder-0.mergit.eth`); a bare label or a different case is still recognised, and the page redirects it to the
 * full name. Anything with another parent, more than one label or any character a label cannot hold is not a profile.
 */
export function parseAgentParam(param: string | undefined): { label: string; canonical: boolean } | null {
  if (typeof param !== "string" || param === "") return null;
  const lower = param.toLowerCase();
  const bare = lower.endsWith(SUFFIX) ? lower.slice(0, -SUFFIX.length) : lower;
  const label = labelForAgent(bare);
  if (label === null) return null;
  return { label, canonical: param === ensNameOf(label) };
}
