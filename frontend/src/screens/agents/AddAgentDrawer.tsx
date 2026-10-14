import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import { CHAIN_LABEL } from "../../mock/data";
import { identityNote, MODELS, type RegistryAgent } from "../../mock/registry";
import { prefersReducedMotion } from "../../lib/motion";
import { AgentMark } from "./AgentMark";

/** Simulated mint: wallet signature, then the mint transaction, then confirmation. */
const STEP_MS = [700, 900, 800];
const CLOSE_AFTER_MS = 1100;

type Phase = { name: "form" } | { name: "minting"; step: number } | { name: "minted" };

export function AddAgentDrawer({
  agent,
  identity,
  onMinted,
  onClose,
}: {
  agent: RegistryAgent;
  /** Identity number the new agent will get. */
  identity: number;
  onMinted: () => void;
  onClose: () => void;
}) {
  const [model, setModel] = useState(agent.model);
  const [perms, setPerms] = useState(agent.permissions);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const panelRef = useRef<HTMLDivElement>(null);
  const busy = phase.name !== "form";

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("select")?.focus();
    // Suggested permissions switch on just after the drawer opens, as in the design.
    const timer = window.setTimeout(
      () => {
        setPerms((list) => list.map((p) => ({ ...p, on: true })));
      },
      prefersReducedMotion() ? 0 : 650,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [busy, onClose]);

  useEffect(() => {
    if (phase.name !== "minting") return;
    const fast = prefersReducedMotion();
    const timer = window.setTimeout(
      () => {
        if (phase.step + 1 < STEP_MS.length) setPhase({ name: "minting", step: phase.step + 1 });
        else setPhase({ name: "minted" });
      },
      fast ? 0 : STEP_MS[phase.step],
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase]);

  // Latest callbacks, so the "minted" effect fires once without re-running on parent renders.
  const done = useRef({ onMinted, onClose });
  useLayoutEffect(() => {
    done.current = { onMinted, onClose };
  });

  useEffect(() => {
    if (phase.name !== "minted") return;
    done.current.onMinted();
    const timer = window.setTimeout(
      () => {
        done.current.onClose();
      },
      prefersReducedMotion() ? 300 : CLOSE_AFTER_MS,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase.name]);

  const reached = phase.name === "minted" ? STEP_MS.length : phase.name === "minting" ? phase.step : -1;
  const steps = [
    "Signature approved in wallet",
    <>
      Minting identity · <span className="mono">0x5a1c9e7f…b20d</span>
    </>,
    <>
      <strong>Identity #{String(identity).padStart(4, "0")} minted</strong> · block 18,431,233
    </>,
  ];

  return (
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div ref={panelRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="row g16">
          <AgentMark agent={agent} size={58} />
          <div className="col grow">
            <h2 id="drawer-title" className="drawer-title">
              Add {agent.name}
            </h2>
            <span className="c2">
              {agent.publisher}/{agent.id} · {agent.version}
            </span>
          </div>
          <button type="button" className="drawer-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <label className="col g8 drawer-field">
          <span className="drawer-label">Model</span>
          <span className="select-box">
            <select
              value={model}
              disabled={busy}
              onChange={(e) => {
                setModel(e.target.value);
              }}
            >
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} />
          </span>
        </label>

        <div className="col drawer-field">
          <span className="drawer-label">Permissions</span>
          {perms.map((p, i) => (
            <div key={p.label} className="row between drawer-perm">
              <span className="col">
                <span className="c2">{p.label}</span>
                <span className="drawer-target">{p.target}</span>
              </span>
              <Switch
                checked={p.on}
                label={`${p.label}, ${p.target}`}
                onChange={(on) => {
                  if (!busy) setPerms((list) => list.map((x, j) => (j === i ? { ...x, on } : x)));
                }}
              />
            </div>
          ))}
        </div>

        <div className="drawer-note">
          <span className="drawer-note-label">ERC-8004 identity</span>
          <span>{identityNote}</span>
        </div>

        {busy && (
          <ol className="drawer-steps" aria-live="polite">
            {steps.map(
              (step, i) =>
                reached >= i && (
                  <li key={i} className={reached > i ? "done" : "now"}>
                    {reached > i ? (
                      <Icon name="tick" size={14} stroke={2.4} />
                    ) : (
                      <Icon name="running" size={14} className="spin" />
                    )}
                    <span>{step}</span>
                  </li>
                ),
            )}
          </ol>
        )}

        <button
          type="button"
          className={`btn block drawer-cta ${phase.name === "minted" ? "minted" : "primary"}`}
          disabled={busy}
          onClick={() => {
            setPhase({ name: "minting", step: 0 });
          }}
        >
          {phase.name === "form" && "Add & mint identity"}
          {phase.name === "minting" && `Minting on the ${CHAIN_LABEL}…`}
          {phase.name === "minted" && (
            <>
              <Icon name="tick" size={16} stroke={2.4} /> Identity minted
            </>
          )}
        </button>
      </div>
    </div>
  );
}
