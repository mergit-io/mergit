/** The parent of every agent name. The agents' ENS names are `<label>.mergit.eth`. */
export const PARENT_NAME = "mergit.eth";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The ENS name of an agent: one label under `mergit.eth`. Throws for anything that is not a single lowercase DNS label. */
export function ensNameOf(label: string): string {
  if (typeof label !== "string" || !LABEL.test(label)) {
    throw new Error(
      `Invalid label ${JSON.stringify(label)}: use 1 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen.`,
    );
  }
  return `${label}.${PARENT_NAME}`;
}

/**
 * The ENS label for an agent called `name`: the name itself if it already is a valid label, otherwise null (the agent
 * has no ENS name). It never rewrites a name into a different label, so an agent can never be shown under another
 * agent's name.
 */
export function labelForAgent(name: string): string | null {
  return typeof name === "string" && LABEL.test(name) ? name : null;
}
