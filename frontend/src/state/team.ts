import { createContext, useContext } from "react";
import type { RegistryAgent, TeamMember } from "../mock/registry";

type TeamValue = {
  team: TeamMember[];
  /** Registry ids already on the team. */
  added: ReadonlySet<string>;
  add: (agent: RegistryAgent, identity: number) => TeamMember;
};

export const TeamContext = createContext<TeamValue | null>(null);

export function useTeam() {
  const ctx = useContext(TeamContext);
  if (!ctx) throw new Error("useTeam must be used inside TeamProvider");
  return ctx;
}
