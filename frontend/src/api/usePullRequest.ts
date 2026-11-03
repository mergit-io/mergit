import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, getPlanDiff, getPullRequest, openPullRequest } from "./client";
import type { PlanDiff, PullRequest } from "./pullRequest";

const POLL_MS = 3000;

/**
 * The pull-request step of a finished plan: the diff to review, the approval, and the request's progress. While the
 * worker is queued or opening it, the status is asked for every few seconds.
 */
export function usePullRequest(planUuid: string, ready: boolean) {
  const [diff, setDiff] = useState<PlanDiff | null>(null);
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void Promise.all([getPlanDiff(planUuid), getPullRequest(planUuid)]).then(
      ([d, p]) => {
        if (!alive.current) return;
        setDiff(d);
        setPr(p);
      },
      (e: unknown) => {
        // A plan with nothing to review (409) is not an error worth a red box: the page just shows no diff.
        if (alive.current && !(e instanceof ApiError && e.status === 409)) setError(errorMessage(e));
      },
    );
  }, [planUuid, ready]);

  const pending = pr?.status === "queued" || pr?.status === "running";
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      void getPullRequest(planUuid).then(
        (p) => {
          if (alive.current) setPr(p);
        },
        () => undefined, // a missed poll is retried on the next tick
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, planUuid]);

  const open = useCallback(() => {
    setError(null);
    setBusy(true);
    openPullRequest(planUuid)
      .then((p) => {
        if (alive.current) setPr(p);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  }, [planUuid]);

  return { diff, pr, error, busy, open };
}
