import { paths } from "../app/paths";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge } from "../components/Badge";
import { Icon } from "../components/Icon";
import { Switch } from "../components/Switch";
import { stagger } from "../lib/stagger";
import {
  ASK_TIMEOUT_SECONDS,
  askBefore,
  defaultPrompt,
  draftPlan,
  draftPlanApps,
  newRunContext,
  runDetail,
  templates,
} from "../mock/data";
import { useToast } from "../toast/context";
import { useNotWired } from "../hooks/useNotWired";
import "../styles/screens/newrun.css";

const LIMIT = 2000;

export function NewRun() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [asks, setAsks] = useState(askBefore);
  const navigate = useNavigate();
  const toast = useToast();
  const notWired = useNotWired();

  const start = () => {
    if (!prompt.trim()) return;
    // No runtime yet: open the demo trace instead of a run built from this prompt.
    toast(`Demo mode: opening ${runDetail.id}`);
    void navigate(paths.run(runDetail.id));
  };

  return (
    <div className="nr-wrap">
      <div className="col g20 nr-col">
        <div className="col g6 nr-head">
          <span className="chip">
            <Icon name="sparkle" size={12} />
            New run
          </span>
          <h1 className="display">Describe the outcome, not the steps</h1>
          <p className="c2">
            Mergit plans the work, picks the agents, asks before risky writes, and settles every finished task as a
            proof.
          </p>
        </div>

        <div className="card nr-composer">
          <textarea
            className="nr-input"
            value={prompt}
            maxLength={LIMIT}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            aria-label="Describe the outcome"
            placeholder="Describe what should be true when the run is done"
          />
          <div className="row g8 nr-bar">
            <button type="button" className="chipo" onClick={notWired}>
              <Icon name="attach" size={14} />
              Attach
            </button>
            <span className="chipo static" title="Repository">
              <Icon name="repo" size={14} />
              {newRunContext.repo}
            </span>
            <span className="chipo static hide-sm" title="Source thread">
              <Icon name="link" size={14} />
              {newRunContext.thread}
            </span>
            <span className="grow" />
            <span className="mono-s c3">
              {prompt.length.toLocaleString()} / {LIMIT.toLocaleString()}
            </span>
            <button
              type="button"
              className="btn primary icon-only"
              onClick={start}
              aria-label="Start run"
              disabled={!prompt.trim()}
            >
              <Icon name="arrowUp" size={16} stroke={2} />
            </button>
          </div>
        </div>

        <div className="nr-grid">
          <div className="card col">
            <div className="hd nr-plan-head">
              <h2 className="title">Draft plan</h2>
              <span className="small c3">
                {draftPlan.length} tasks, {draftPlanApps} apps, planned in {runDetail.plannedIn}
              </span>
            </div>
            <ol className="nr-steps">
              {draftPlan.map((step, i) => (
                <li key={step.task} className="row g12 nr-step rise" style={stagger(i)}>
                  <span className="mono-s c3 w-16">t{i + 1}</span>
                  <AgentAvatar kind={step.agent} size={26} labelled />
                  <div className="col grow">
                    <span className="strong">{step.task}</span>
                    <span className="mono-s c3">{step.tools}</span>
                  </div>
                  {step.gate && <Badge status="Waiting" label="Asks you" />}
                </li>
              ))}
            </ol>
          </div>
          <div className="col g16">
            <div className="card pad col g12">
              <h2 className="title">Ask me before</h2>
              {asks.map((ask, i) => (
                <div key={ask.label} className="row between">
                  <span className="c2">{ask.label}</span>
                  <Switch
                    checked={ask.on}
                    label={ask.label}
                    onChange={(on) => {
                      setAsks((list) => list.map((x, j) => (j === i ? { ...x, on } : x)));
                    }}
                  />
                </div>
              ))}
              <span className="small c3">
                Unanswered asks expire in {ASK_TIMEOUT_SECONDS}s and the task stops instead of guessing.
              </span>
            </div>
            <div className="card pad col g10">
              <h2 className="title">Start from</h2>
              {templates.map((template) => (
                <button
                  key={template}
                  type="button"
                  className="row between nr-template"
                  onClick={() => {
                    setPrompt(`${template}: `);
                  }}
                >
                  <span className="c2">{template}</span>
                  <Icon name="chevronRight" size={14} color="var(--ink3)" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
