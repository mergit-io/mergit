import { useCallback, useMemo, useState, type ReactNode } from "react";
import { starterTeam, type RegistryAgent, type TeamMember } from "../mock/registry";
import { TeamContext } from "./team";

/** The workspace's team. Demo state: agents added from the registry last until reload. */
export function TeamProvider({ children }: { children: ReactNode }) {
  const [team, setTeam] = useState<TeamMember[]>(starterTeam);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const add = useCallback((agent: RegistryAgent, identity: number) => {
    const member: TeamMember = {
      name: agent.name,
      identity,
      density: "new",
      icon: agent.icon,
      tone: agent.tone,
      isNew: true,
    };
    setTeam((list) => [...list, member]);
    setAdded((ids) => new Set(ids).add(agent.id));
    return member;
  }, []);

  const value = useMemo(() => ({ team, added, add }), [team, added, add]);
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}
