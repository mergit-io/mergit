import type { AgentKind } from "../../mock/data";
import { LIcon, type LIconName } from "../LIcon";
import { team } from "../content";
import { useInView } from "../motion";
import { SectionHead } from "./SectionHead";

/** Icon and wash per role, as drawn on the landing page. */
const ROLE: Record<AgentKind, { icon: LIconName; tone: string }> = {
  Planner: { icon: "route", tone: "purple" },
  Research: { icon: "search", tone: "green" },
  Coder: { icon: "code", tone: "purple" },
  Tester: { icon: "checks", tone: "amber" },
  Reviewer: { icon: "shield", tone: "rose" },
  Proof: { icon: "file", tone: "gray" },
};

export function Team() {
  const [ref, inView] = useInView<HTMLElement>(0.15);
  return (
    <section id="agents" ref={ref} className={`l-section l-gray${inView ? " in" : ""}`} aria-labelledby="team-title">
      <div className="l-container">
        <SectionHead id="team-title" split eyebrow={team.eyebrow} title={team.title} lede={team.lede} />
        <ul className="team-grid">
          {team.agents.map((agent, i) => (
            <li
              key={agent.name}
              className="l-card team-card l-reveal"
              style={{ transitionDelay: `${String(200 + i * 80)}ms` }}
            >
              <div className="row between">
                <span className={`team-avatar ${ROLE[agent.kind].tone}`} aria-hidden="true">
                  <LIcon name={ROLE[agent.kind].icon} size={24} />
                </span>
                <span className="l-pill gray">Specialist</span>
              </div>
              <h3>{agent.name}</h3>
              <p>{agent.body}</p>
              <div className="team-foot">
                <div className="col">
                  <span className="l-eyebrow small">Delivers</span>
                  <span className="team-delivers">{agent.delivers}</span>
                </div>
                <span className="l-pill purple mono" title="ERC-8004 identity and value density">
                  ID {agent.id} · D {agent.density}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
