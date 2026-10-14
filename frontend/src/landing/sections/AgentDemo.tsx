import { useCallback, useEffect, useState } from "react";
import { BrandMark, Icon } from "../../components/Icon";
import { agentDemo } from "../content";
import { LIcon, LinearMark } from "../LIcon";
import { prefersReducedMotion, useTypewriter } from "../motion";

/** Milliseconds between steps landing, and how long the finished card holds before replaying. */
const STEP_MS = 900;
const HOLD_MS = 7000;

function StepIcon({ icon }: { icon: (typeof agentDemo.steps)[number]["icon"] }) {
  if (icon === "github") return <Icon name="github" size={20} />;
  if (icon === "linear") return <LinearMark size={18} />;
  return <LIcon name="thread" size={18} />;
}

/**
 * The hero's scripted agent card: the prompt types itself, the three
 * results land one by one, then the run completes. Each round remounts, so
 * the replay starts from a clean card.
 */
export function AgentDemo({ start }: { start: boolean }) {
  const [round, setRound] = useState(0);
  // Stable, so re-renders of the hero don't restart a round in progress.
  const next = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  return <AgentRun key={round} start={start} onFinished={next} />;
}

function AgentRun({ start, onFinished }: { start: boolean; onFinished: () => void }) {
  const [prompt, typed] = useTypewriter(agentDemo.prompt, start, 34, 250);
  const [landed, setLanded] = useState(0);

  useEffect(() => {
    if (!typed) return;
    if (prefersReducedMotion()) {
      setLanded(agentDemo.steps.length + 1);
      return;
    }
    let n = 0;
    let timer = window.setTimeout(function next() {
      n += 1;
      setLanded(n);
      if (n <= agentDemo.steps.length) timer = window.setTimeout(next, STEP_MS);
      else timer = window.setTimeout(onFinished, HOLD_MS);
    }, 450);
    return () => {
      window.clearTimeout(timer);
    };
  }, [typed, onFinished]);

  const done = landed > agentDemo.steps.length;

  return (
    <div className="agent-card">
      <div className="row g12">
        <BrandMark size={36} />
        <div className="col">
          <span className="agent-name">Mergit Agent</span>
          <span className={`agent-status${done ? " done" : ""}`}>
            {done ? (
              <>
                <LIcon name="check" size={12} stroke={2.6} /> {agentDemo.done}
              </>
            ) : (
              <>
                <i className="live-dot" /> Working…
              </>
            )}
          </span>
        </div>
      </div>
      <div className="agent-prompt">
        <LIcon name="user" size={16} />
        <span>
          {prompt}
          {!typed && start && <i className="caret" />}
        </span>
      </div>
      <div className={`agent-arrow${landed > 0 ? " on" : ""}`}>
        <LIcon name="arrowDown" size={14} />
      </div>
      <ul className="agent-steps">
        {agentDemo.steps.map((step, i) => (
          <li key={step.title} className={`agent-step${landed > i ? " on" : ""}`}>
            <span className="agent-step-icon">
              <StepIcon icon={step.icon} />
            </span>
            <span className="col grow">
              <span className="agent-step-title">{step.title}</span>
              <span className="agent-step-detail">{step.detail}</span>
            </span>
            <span className={`l-pill ${step.tone}`}>{step.badge}</span>
            {landed === i + 1 && <i className="agent-ping" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
