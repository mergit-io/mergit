import type { Address } from "viem";

export type AgentInput = {
  label: string;
  agentId?: number;
  name: string;
  description: string;
  profileUrl: string;
  image?: string;
  supportedTrust?: string[];
};

export type RegistrationFile = {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations?: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
};

const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The ENS name of an agent: one subname under `mergit.eth`. */
export function ensNameOf(label: string): string {
  if (typeof label !== "string" || !LABEL.test(label)) throw new Error(`invalid label "${label}": use 1 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen`);
  return `${label}.mergit.eth`;
}

/** ERC-8004 registration file for one agent. `registrations` is present only once the agent id is known. */
export function registrationFile(agent: AgentInput, chain: { chainId: number; identity: Address }): RegistrationFile {
  const ensName = ensNameOf(agent.label);
  const file: RegistrationFile = {
    type: REGISTRATION_TYPE,
    name: agent.name,
    description: agent.description,
    ...(agent.image ? { image: agent.image } : {}),
    services: [
      { name: "ENS", endpoint: ensName, version: "v1" },
      { name: "web", endpoint: agent.profileUrl },
    ],
    x402Support: false,
    active: true,
    ...(agent.agentId !== undefined ? { registrations: [{ agentId: agent.agentId, agentRegistry: `eip155:${chain.chainId}:${chain.identity}` }] } : {}),
    supportedTrust: agent.supportedTrust ?? ["reputation"],
  };
  return file;
}

export function serializeRegistration(file: RegistrationFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}
