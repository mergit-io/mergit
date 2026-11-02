import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getSuggestions } from "./client";
import type { IneligibleAgent, Suggestion, SuggestionsResponse, TaskSuggestions } from "./types";

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readPick(v: unknown): Suggestion | null {
  const p = record(v);
  if (!p || typeof p.agent_id !== "string" || typeof p.name !== "string") return null;
  if (!num(p.assumed_success) || !num(p.assumed_cost_micros) || !num(p.counted_outcomes)) return null;
  return {
    agent_id: p.agent_id,
    name: p.name,
    score_per_usdc: num(p.score_per_usdc) ? p.score_per_usdc : 0,
    assumed_success: p.assumed_success,
    assumed_cost_micros: p.assumed_cost_micros,
    counted_outcomes: p.counted_outcomes,
    // Absent (an older control plane) means nothing vouches for the agent or says its cost was measured.
    unproven: p.unproven !== false,
    cost_is_prior: p.cost_is_prior !== false,
  };
}

function readIneligible(v: unknown): IneligibleAgent | null {
  const a = record(v);
  return a && typeof a.agent_id === "string" && typeof a.name === "string" && typeof a.reason === "string"
    ? { agent_id: a.agent_id, name: a.name, reason: a.reason }
    : null;
}

function readTask(v: unknown): TaskSuggestions | null {
  const t = record(v);
  if (!t || !num(t.index) || !Array.isArray(t.picks)) return null;
  return {
    index: t.index,
    budget_usdc_units: typeof t.budget_usdc_units === "string" ? t.budget_usdc_units : "",
    picks: t.picks.map(readPick).filter((p): p is Suggestion => p !== null),
    // Older control planes (before every left-out agent was listed) send no `ineligible` at all.
    ineligible: Array.isArray(t.ineligible)
      ? t.ineligible.map(readIneligible).filter((a): a is IneligibleAgent => a !== null)
      : [],
    ...(typeof t.reason === "string" ? { reason: t.reason } : {}),
  };
}

/**
 * The answer in the shape the screens rely on, or null when it is not the suggestions service answering.
 * Anything a slightly different control plane (an older or newer version) may omit gets a safe default or
 * drops only that task or pick, so a version skew loses some advice at worst, never the review page.
 */
export function readSuggestions(answer: unknown): SuggestionsResponse | null {
  const a = record(answer);
  if (!a || !Array.isArray(a.tasks)) return null;
  return {
    plan_id: (typeof a.plan_id === "string" ? a.plan_id : "0x") as SuggestionsResponse["plan_id"],
    mode: a.mode === "explore" ? "explore" : "greedy",
    seed: num(a.seed) ? a.seed : null,
    note: typeof a.note === "string" ? a.note : "",
    tasks: a.tasks.map(readTask).filter((t): t is TaskSuggestions => t !== null),
  };
}

type Answer = { suggestions: SuggestionsResponse | null; error?: string; settled: string | null };

/**
 * The control plane's suggested agents for each task of a draft: advice next to the manual picks, never a
 * replacement for them. The ranking (`explore=false`, a plain read) loads on mount and again whenever
 * `saved` changes (pass something that changes when the saved tasks do, e.g. their budgets); that re-read is
 * always the ranking, whatever was shown before. A random draw (`explore=true`) is recorded and rate-limited
 * server-side, so it is only fetched when the requester asks for one through `setExplore(true)`, and never
 * while another request is in flight; nothing here draws on its own.
 *
 * `loading` is true from mount, while a requested draw or ranking is in flight, and while the answer shown is
 * for budgets that are no longer the saved ones. A failure only sets `error`: the suggestions shown before it
 * stay, and the caller keeps manual picking.
 */
export function useSuggestions(planUuid: string, saved: string) {
  const [answer, setAnswer] = useState<Answer>({ suggestions: null, settled: null });
  const [requested, setRequested] = useState(false);
  // Only the latest call's answer lands, so a slow ranking can't overwrite a draw asked for after it.
  const latest = useRef(0);
  // Whether the latest call is still in flight. A ref, so two requests in one render batch see it too.
  const inFlight = useRef(false);

  const load = useCallback(
    (explore: boolean, key: string) => {
      const call = ++latest.current;
      inFlight.current = true;
      let cancelled = false;
      const settle = (next: { suggestions?: SuggestionsResponse; error?: string }) => {
        if (cancelled || call !== latest.current) return;
        inFlight.current = false;
        setRequested(false);
        setAnswer((prev) => ({ suggestions: next.suggestions ?? prev.suggestions, error: next.error, settled: key }));
      };
      getSuggestions(planUuid, explore).then(
        (raw: unknown) => {
          const suggestions = readSuggestions(raw);
          settle(
            suggestions ? { suggestions } : { error: "Mergit's API did not answer like the suggestions service." },
          );
        },
        (e: unknown) => {
          settle({ error: errorMessage(e) });
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [planUuid],
  );

  // `saved` is a dependency on purpose: the ranking is read again when the saved tasks change.
  useEffect(() => load(false, saved), [load, saved]);

  const setExplore = useCallback(
    (explore: boolean) => {
      if (inFlight.current) return; // one request at a time: a double click must not record two draws
      setRequested(true);
      load(explore, saved);
    },
    [load, saved],
  );

  return {
    suggestions: answer.suggestions,
    error: answer.error,
    loading: requested || answer.settled !== saved,
    setExplore,
  };
}
