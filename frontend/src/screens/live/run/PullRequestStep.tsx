import { prHeadline } from "../../../api/pullRequest";
import { usePullRequest } from "../../../api/usePullRequest";
import { Icon } from "../../../components/Icon";

/**
 * A plan whose every task passed its check can become a pull request. The requester reads the combined change first
 * and approves; the worker, the only process holding a GitHub token, opens it. Receipts are linked from its body and
 * are labelled unattested there.
 */
export function PullRequestStep({ planUuid }: { planUuid: string }) {
  const { diff, pr, error, busy, open } = usePullRequest(planUuid, true);
  if (!diff && !pr && !error) return null;
  const waiting = pr?.status === "queued" || pr?.status === "running";

  return (
    <section className="card pad24 col g16 lr-pr" aria-labelledby="pr-title">
      <div className="col g4">
        <h2 id="pr-title" className="title">
          Open a pull request
        </h2>
        <p className="small c2" role="status">
          {prHeadline(pr)}
        </p>
      </div>

      {diff && (
        <div className="col g8">
          <span className="small c2">
            {diff.tasks.length === 1 ? "1 task" : `${String(diff.tasks.length)} tasks`} against{" "}
            <span className="mono">{diff.baseRef}</span> in{" "}
            <span className="mono">{diff.repoUrl.replace("https://github.com/", "")}</span>:{" "}
            <span className="cm">+{diff.lines.added}</span> <span className="cr">-{diff.lines.removed}</span>
          </span>
          <details className="lr-diff">
            <summary>Read the change</summary>
            {/* A scrollable box must be reachable by keyboard, or a keyboard user cannot read past its first lines. */}
            {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex */}
            <pre tabIndex={0} aria-label="The combined change">
              {diff.diff || "No tracked file changed."}
            </pre>
          </details>
        </div>
      )}

      {error && (
        <p className="small cr" role="alert">
          {error}
        </p>
      )}

      {pr?.status === "done" && pr.url ? (
        <a className="btn primary self-start" href={pr.url} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={16} />
          View pull request #{pr.number}
        </a>
      ) : (
        diff && (
          <button type="button" className="btn primary self-start" disabled={busy || waiting} onClick={open}>
            <Icon name="check" size={16} />
            {pr?.status === "error" ? "Try again" : busy || waiting ? "Opening…" : "Open the pull request"}
          </button>
        )
      )}
    </section>
  );
}
