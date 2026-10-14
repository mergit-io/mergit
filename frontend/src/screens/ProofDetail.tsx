import { useState } from "react";
import { useParams } from "react-router-dom";
import { AgentAvatar } from "../components/AgentAvatar";
import { AppTile } from "../components/AppTile";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { changedFiles, proof, type ChangedFile, type DiffLine } from "../mock/data";
import { useCopy } from "../hooks/useCopy";
import { NotFound } from "./NotFound";
import "../styles/screens/proof.css";

const TABS = ["Diff", "Canonical output", "Tool results"] as const;
type Tab = (typeof TABS)[number];

const FACT_CLASS = { tx: "mono cz", mono: "mono", text: undefined } as const;

function Line({ line }: { line: DiffLine }) {
  const kind = line.sign === "+" ? "add" : line.sign === "-" ? "rem" : "";
  return (
    <div className={`diff-line ${kind}`}>
      <span className="line-no">{line.n}</span>
      <span className={`diff-sign ${line.sign === "+" ? "cm" : line.sign === "-" ? "cr" : "c3"}`}>{line.sign}</span>
      <pre className={line.sign === " " ? "c2" : "ink"}>{line.text}</pre>
    </div>
  );
}

function FileDiff({ file }: { file: ChangedFile }) {
  return (
    <>
      <div className="row g8 pf-file">
        <Icon name="file" size={14} color="var(--ink3)" />
        <span className="mono grow">{file.path}</span>
        <span className="mono-s cm">+{file.added}</span>
        {file.removed > 0 && <span className="mono-s cr">−{file.removed}</span>}
        {file.isNew && <span className="mono-s c3">new test</span>}
      </div>
      <div className="code pf-code">
        {file.lines.map((line) => (
          <Line key={`${line.sign}${line.n}`} line={line} />
        ))}
      </div>
    </>
  );
}

export function ProofDetail() {
  const { proofId } = useParams();
  const copy = useCopy();
  const [tab, setTab] = useState<Tab>("Diff");

  if (proofId !== proof.id) return <NotFound />;

  return (
    <>
      <PageHeader
        title="Work proof"
        crumb={{ label: "Proofs", id: `#${proof.id}` }}
        badge={<Badge status="Verified" />}
        subtitle="A public receipt anyone can check against the chain."
        actions={
          <>
            <Button
              icon="link"
              onClick={() => {
                copy(window.location.href, "Proof link copied");
              }}
            >
              Copy link
            </Button>
            <Button variant="primary" icon="external">
              View on explorer
            </Button>
          </>
        }
      />

      <section className="pf-grid fill">
        <div className="card col pf-receipt">
          <div className="mesh col g16 pf-hero">
            <div className="row g12">
              <span className="ring pf-ring">
                <Icon name="tick" size={22} color="var(--mint)" stroke={2.4} />
              </span>
              <div className="col">
                <h2 className="title">Hashes match</h2>
                <span className="small c2">Recomputed from the canonical output just now</span>
              </div>
            </div>
            <div className="col g6">
              <span className="cap c3">Artifact hash, SHA-256</span>
              <button
                type="button"
                className="row between pf-hash"
                aria-label="Copy artifact hash"
                onClick={() => {
                  copy(proof.artifactHashFull, "Hash copied");
                }}
              >
                <span className="mono">{proof.artifactHash}</span>
                <Icon name="copy" size={15} color="var(--ink3)" />
              </button>
            </div>
          </div>
          <div className="pad24 col scroll pf-facts">
            <dl>
              {proof.facts.map(([label, value, kind]) => (
                <div key={label} className="kv">
                  <dt className="c3">{label}</dt>
                  <dd className={FACT_CLASS[kind]}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="col g8 pf-section">
              <span className="cap c3">Agent identity</span>
              <div className="inner pad-md row g12">
                <AgentAvatar kind={proof.agent.kind} size={36} />
                <div className="col grow">
                  <span className="strong">{proof.agent.name}</span>
                  <span className="mono-s c3">{proof.agent.address}</span>
                </div>
                <Badge status="Verified" label="ERC-8004" />
              </div>
            </div>
            <div className="col g8 pf-section">
              <span className="cap c3">Settlement</span>
              <ol className="row pf-steps">
                {proof.timeline.map(([label, time], i) => (
                  <li key={label} className="col g4">
                    <div className="row">
                      <span className="pf-dot" />
                      {i < proof.timeline.length - 1 && <i className="pf-line" />}
                    </div>
                    <span className="small strong">{label}</span>
                    <span className="mono-s c3">{time}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>

        <div className="col g16 min0">
          <div className="card row g16 pad">
            <AppTile icon="github" />
            <div className="col grow">
              <h2 className="title">{proof.pr.title}</h2>
              <span className="small c2">
                {proof.pr.repo}, commit {proof.pr.commit}, generated by {proof.agent.name} {proof.pr.ago}
              </span>
            </div>
            <Badge status="Completed" label="Merged" />
          </div>

          <div className="card col pf-artifact">
            <div className="hd">
              <h2 className="title">Artifact</h2>
              <Segmented options={TABS} value={tab} onChange={setTab} label="Artifact view" />
            </div>
            <div className="scroll page-enter" key={tab}>
              {tab === "Diff" && changedFiles.map((file) => <FileDiff key={file.path} file={file} />)}
              {tab === "Canonical output" && (
                <div className="code pf-code">
                  {proof.canonical.map((text, i) => (
                    <Line key={i} line={{ n: i + 1, sign: " ", text }} />
                  ))}
                </div>
              )}
              {tab === "Tool results" &&
                proof.toolResults.map(([tool, result]) => (
                  <div key={tool} className="tr medium-row">
                    <span className="mono w-200">{tool}</span>
                    <span className="small c2 grow">{result}</span>
                    <Icon name="check" size={16} color="var(--mint)" stroke={2} />
                  </div>
                ))}
            </div>
            <ul className="row g16 pf-checks">
              {proof.checks.map((check) => (
                <li key={check} className="row g6 small c2">
                  <Icon name="check" size={14} color="var(--mint)" stroke={2} />
                  {check}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
