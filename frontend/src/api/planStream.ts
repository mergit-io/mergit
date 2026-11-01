import type { Attempt, MoneyEvent, NeedsRequester, PlanDetail, PlanState, StepEvent } from "./types";

/**
 * The live state of one plan: the detail from `GET /v0/plans/{id}`, kept current by the events from
 * `GET /v0/plans/{id}/events`. A pure reducer, so the merge rules are unit-tested apart from React.
 *
 * The stream starts with a full snapshot and may reconnect at any time, so every event is merged
 * idempotently: a repeated attempt, money event or step changes nothing.
 */

export const PLAN_EVENT_NAMES = [
  "plan.state",
  "task.state",
  "needs_requester",
  "verdict",
  "money",
  "step.recorded",
] as const;

export type PlanStreamEvent =
  | { name: "plan.state"; data: { state: PlanState } }
  | { name: "task.state"; data: Attempt }
  | { name: "needs_requester"; data: { needs_requester: NeedsRequester[] } }
  | { name: "verdict" | "money"; data: MoneyEvent }
  | { name: "step.recorded"; data: StepEvent };

export type PlanStreamState = {
  detail: PlanDetail | null;
  /** Live agent steps. Not part of the detail: they are only ever streamed, never stored. */
  steps: StepEvent[];
  /** Events that arrived before the detail did, or while a reload is in flight, applied once it lands. */
  backlog: PlanStreamEvent[];
  error: string | null;
  /**
   * A GET is in flight (usePlan's `reload`, called after this client's own edit or approval). While
   * true, an SSE event is held in `backlog` instead of applied straight to the current `detail`: that
   * GET's response is about to replace `detail` wholesale, and without this an event the stream
   * delivers in that window would be silently lost the moment "loaded" overwrites it.
   */
  reloading: boolean;
};

export type PlanAction =
  | { type: "loaded"; detail: PlanDetail }
  | { type: "failed"; error: string }
  | { type: "event"; event: PlanStreamEvent }
  | { type: "reloading" };

export const initialPlanStream: PlanStreamState = {
  detail: null,
  steps: [],
  backlog: [],
  error: null,
  reloading: false,
};

const byIndexThenAttempt = (a: Attempt, b: Attempt) => a.index - b.index || a.attempt - b.attempt;
const moneyKey = (m: MoneyEvent) => `${m.type}|${m.at}|${JSON.stringify(m.payload)}`;

const sameNeeds = (a: NeedsRequester[], b: NeedsRequester[]) => JSON.stringify(a) === JSON.stringify(b);

const sameAttempt = (a: Attempt, b: Attempt) =>
  a.status === b.status &&
  a.phi_holds === b.phi_holds &&
  a.receipt_root === b.receipt_root &&
  a.notes === b.notes &&
  a.finished_at === b.finished_at;

function upsertAttempt(attempts: Attempt[], next: Attempt): Attempt[] {
  const i = attempts.findIndex((a) => a.task_id === next.task_id);
  if (i === -1) return [...attempts, next].sort(byIndexThenAttempt);
  const current = attempts[i];
  if (current && sameAttempt(current, next)) return attempts;
  return attempts.map((a, j) => (j === i ? next : a));
}

/** Applies one event to the detail. Returns the same object when nothing changed. */
export function applyToDetail(detail: PlanDetail, event: PlanStreamEvent): PlanDetail {
  switch (event.name) {
    case "plan.state":
      return detail.state === event.data.state ? detail : { ...detail, state: event.data.state };
    case "task.state": {
      const attempts = upsertAttempt(detail.attempts, event.data);
      return attempts === detail.attempts ? detail : { ...detail, attempts };
    }
    case "needs_requester": {
      // Sent whole, so it replaces the list rather than merging into it.
      const next = event.data.needs_requester;
      return sameNeeds(detail.needs_requester, next) ? detail : { ...detail, needs_requester: next };
    }
    case "verdict":
    case "money": {
      const key = moneyKey(event.data);
      if (detail.money_events.some((m) => moneyKey(m) === key)) return detail;
      return { ...detail, money_events: [...detail.money_events, event.data] };
    }
    case "step.recorded":
      // Unreachable: planReducer's "event" case routes step.recorded into `steps` before it would
      // ever reach the backlog (the only caller of this function with a queued event), so this arm
      // exists only to keep the switch exhaustive over PlanStreamEvent, never to run.
      return detail;
  }
}

function addStep(steps: StepEvent[], step: StepEvent): StepEvent[] {
  return steps.some((s) => s.task_id === step.task_id && s.seq === step.seq) ? steps : [...steps, step];
}

export function planReducer(state: PlanStreamState, action: PlanAction): PlanStreamState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        detail: state.backlog.reduce(applyToDetail, action.detail),
        backlog: [],
        error: null,
        reloading: false,
      };
    case "failed":
      return { ...state, error: action.error, reloading: false };
    case "reloading":
      return { ...state, reloading: true };
    case "event": {
      const { event } = action;
      if (event.name === "step.recorded") {
        const steps = addStep(state.steps, event.data);
        return steps === state.steps ? state : { ...state, steps };
      }
      if (!state.detail || state.reloading) return { ...state, backlog: [...state.backlog, event] };
      const detail = applyToDetail(state.detail, event);
      return detail === state.detail ? state : { ...state, detail };
    }
  }
}
