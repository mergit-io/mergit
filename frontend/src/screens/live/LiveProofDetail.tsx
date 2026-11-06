import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { Address, Hex } from "viem";
import { useAgents } from "../../api/useAgents";
import { EnsIdentity } from "../../components/EnsIdentity";
import { MergitLoader } from "../../components/MergitLoader";
import { PageHeader } from "../../components/PageHeader";
import { publicClient } from "../../chain/client";
import { identityAbi } from "../../chain/abi";
import { fetchBundle, readCommitment } from "../../chain/proofs";
import { LIVE } from "../../config/live";
import { describeReport, type Described } from "../../verifier/report";
import { verifyInBrowser } from "../../verifier/verify";

type View =
  | { kind: "loading" }
  | { kind: "uncommitted" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "no-verifier" }
  | { kind: "verified"; d: Described; steps: number; root: string; agentId: string };

async function load(task: Hex): Promise<View> {
  const onChain = await readCommitment(task);
  if (!onChain) return { kind: "uncommitted" };
  const text = await fetchBundle(onChain.bodyHash);
  if (!text) return { kind: "missing" };
  const bundle = JSON.parse(text) as {
    receipt: { header: { agent_id: string; phi_hash: string }; steps: unknown[]; root: string };
  };
  const signer: Address = await publicClient.readContract({
    address: LIVE.contracts.identity,
    abi: identityAbi,
    functionName: "runtimeKeyOf",
    args: [onChain.agentId],
  });
  const report = await verifyInBrowser(text, LIVE.chainId, LIVE.contracts.registry, signer, {
    root: onChain.root,
    terminal_hash: onChain.terminalHash,
    body_hash: onChain.bodyHash,
    cost_micros: onChain.costMicros.toString(),
  });
  if (!report) return { kind: "no-verifier" };
  // The receipt must be for this task as the chain records it: the approved check and the committed agent.
  const extra: string[] = [];
  if (bundle.receipt.header.phi_hash.toLowerCase() !== onChain.phiHash.toLowerCase()) extra.push("PHI_HASH_MISMATCH");
  if (bundle.receipt.header.agent_id !== onChain.agentId.toString()) extra.push("COMMITMENT_MISMATCH");
  const checked =
    extra.length > 0 ? { ...report, status: "invalid" as const, reasons: [...report.reasons, ...extra] } : report;
  return {
    kind: "verified",
    d: describeReport(checked),
    steps: bundle.receipt.steps.length,
    root: bundle.receipt.root,
    agentId: onChain.agentId.toString(),
  };
}

/** One receipt, fetched from the store and verified in the browser against the agent's registered key. */
export function LiveProofDetail() {
  const { proofId } = useParams();
  const task = proofId as Hex;
  const [view, setView] = useState<View>({ kind: "loading" });
  const { agents } = useAgents();

  useEffect(() => {
    const controller = new AbortController();
    const show = (v: View) => {
      if (!controller.signal.aborted) setView(v);
    };
    load(task).then(show, (e: unknown) => {
      show({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      controller.abort();
    };
  }, [task]);

  return (
    <>
      <PageHeader
        title="Receipt"
        subtitle={<span className="mono">{task}</span>}
        crumb={{ label: "Proofs", to: "/app/proofs", id: task.slice(0, 10) }}
      />
      <section className="card pad24 col g12">
        {view.kind === "loading" && (
          <div className="c2 row g12 loading-row">
            <MergitLoader size={28} label="Verifying the receipt" />
            <span>Fetching and verifying the receipt…</span>
          </div>
        )}
        {view.kind === "uncommitted" && <p className="c2">No receipt is committed on chain for this task.</p>}
        {view.kind === "missing" && (
          <p className="c2">The receipt store has no body for this task. Without it the receipt cannot be audited.</p>
        )}
        {view.kind === "error" && <p className="c2">{view.message}</p>}
        {view.kind === "no-verifier" && (
          <p className="c2">
            The in-browser verifier is not built into this deployment, so this page cannot check the receipt.
          </p>
        )}
        {view.kind === "verified" && (
          <>
            <h2 className={`title ${view.d.tone === "ok" ? "cm" : "cr"}`}>{view.d.label}</h2>
            <div className="row g8 small c2" data-testid="proof-agent">
              <span>Agent {view.agentId}, as committed on chain</span>
              <EnsIdentity
                agentId={view.agentId}
                name={agents ? (agents.find((a) => a.agent_id === view.agentId)?.name ?? "") : null}
              />
            </div>
            <p>{view.d.phi}</p>
            {view.d.reasons.length > 0 && (
              <ul>
                {view.d.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <p className="small c2">
              {view.steps} steps · Merkle root <span className="mono">{view.root}</span>. Verified in this browser with
              the same code as the mergit-verify command; no Mergit server was trusted for the result.
            </p>
          </>
        )}
      </section>
    </>
  );
}
