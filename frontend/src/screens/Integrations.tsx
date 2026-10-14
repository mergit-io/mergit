import { useState } from "react";
import { AppTile } from "../components/AppTile";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { stagger } from "../lib/stagger";
import { githubInstallation, githubPermissions, integrations, toolCalls } from "../mock/data";
import { useToast } from "../toast/context";
import "../styles/screens/integrations.css";

export function Integrations() {
  const [apps, setApps] = useState(integrations);
  const toast = useToast();

  const connect = (name: string) => {
    setApps((list) => list.map((a) => (a.name === name ? { ...a, connected: true, calls: "0 calls this month" } : a)));
    toast(`${name} connected`);
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Connect the apps your agents work in. Credentials are sealed per user and never reach a model."
        actions={<Button icon="plus">Request an app</Button>}
      />

      <section className="in-apps">
        {apps.map((app, i) => (
          <article key={app.name} className="card pad24 col g16 rise in-app" style={stagger(i)}>
            <div className="row between">
              <AppTile mark={app.mark} icon={app.github ? "github" : undefined} />
              {app.connected ? (
                <Badge status="Completed" label="Connected" />
              ) : (
                <span className="small c3">{app.tools}</span>
              )}
            </div>
            <div className="col g4">
              <h2 className="title">{app.name}</h2>
              <p className="c2">{app.description}</p>
            </div>
            <div className="row between mt-auto">
              <span className="small c3">{app.calls}</span>
              {app.connected ? (
                <Button compact>Manage</Button>
              ) : (
                <Button
                  variant="primary"
                  compact
                  onClick={() => {
                    connect(app.name);
                  }}
                >
                  Connect
                </Button>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="in-bottom fill">
        <div className="card col min0">
          <div className="hd">
            <h2 className="title">GitHub permissions</h2>
            <span className="small c3">
              Installation {githubInstallation.id}, {githubInstallation.org}
            </span>
          </div>
          <div className="scroll">
            {githubPermissions.map(([scope, purpose, level]) => (
              <div key={scope} className="tr medium-row in-perm">
                <span className="mono w-140">{scope}</span>
                <span className="c2 grow">{purpose}</span>
                {level === "None" ? (
                  <Badge status="Neutral" label="Not granted" />
                ) : (
                  <span className={`chip${level === "Write" ? " warn" : ""}`}>{level}</span>
                )}
              </div>
            ))}
          </div>
          <div className="row g8 in-repos">
            <span className="small c3">Repositories</span>
            {githubInstallation.repos.map((repo) => (
              <span key={repo} className="chip raised">
                <Icon name="repo" size={12} />
                {repo}
              </span>
            ))}
            <span className="grow" />
            <a className="link small" href="https://github.com/settings/installations" target="_blank" rel="noreferrer">
              Change on GitHub <Icon name="external" size={13} />
            </a>
          </div>
        </div>

        <div className="card col min0">
          <div className="hd">
            <h2 className="title">Recent tool calls</h2>
            <Button variant="link" compact>
              View all
            </Button>
          </div>
          <div className="scroll">
            {toolCalls.map((call, i) => (
              <div key={call.id} className="tr tall rise" style={stagger(i)}>
                <AppTile mark={call.mark} icon={call.mark === "GH" ? "github" : undefined} size={32} />
                <div className="col grow">
                  <span className="mono">{call.tool}</span>
                  <span className="small c3">{call.ref}</span>
                </div>
                <span className="row" role="img" aria-label={call.ok ? "Succeeded" : "Refused"}>
                  <Icon
                    name={call.ok ? "check" : "fail"}
                    size={16}
                    color={call.ok ? "var(--mint)" : "var(--red)"}
                    stroke={2}
                  />
                </span>
                <span className="small c3 w-46 text-right">{call.when} ago</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
