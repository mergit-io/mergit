import { useId, useState } from "react";
import { approvePlan, editPlan } from "../../../api/client";
import type { AgentInfo, Funding, Plan, SuggestionsResponse } from "../../../api/types";
import { useSuggestions } from "../../../api/useSuggestions";
import { isTrialSession } from "../../../auth/account";
import { useAuth } from "../../../auth/context";
import { creditProblem } from "../../../chain/creditLimits";
import { formatUsdc, parseUsdc } from "../../../chain/funding";
import { useCredits } from "../../../chain/useCredits";
import { Icon } from "../../../components/Icon";
import { Segmented } from "../../../components/Segmented";
import { Switch } from "../../../components/Switch";
import {
  editProblems,
  hasEdits,
  pickProblems,
  toApproval,
  toEdits,
  toForms,
  totalBudget,
  type TaskForm,
} from "./draft";
import { Problems } from "./Problems";
import { TaskDraftCard } from "./TaskDraftCard";
import { useSubmit } from "./useSubmit";

const FUNDING_OPTIONS = ["Wallet", "Free credits"] as const;
const CREDITS_ONLY = ["Free credits"] as const;
type FundingOption = (typeof FUNDING_OPTIONS)[number];
const FUNDING: Record<FundingOption, Funding> = { Wallet: "wallet", "Free credits": "credits" };

/**
 * What the suggestions under each task are, said once for the whole plan, with the one switch between the
 * ranking and a random draw. A draw is one call for every task (one seed), so the switch lives here rather
 * than on each task. `noteId` labels the answer's own note, which the Unproven badges point to.
 */
function SuggestionsPanel({
  suggestions,
  error,
  loading,
  stale,
  noteId,
  onExplore,
}: {
  suggestions: SuggestionsResponse | null;
  error?: string;
  loading: boolean;
  /** A budget has an unsaved edit, so the suggestions are for a budget that is no longer on screen. */
  stale: boolean;
  noteId: string;
  onExplore: (explore: boolean) => void;
}) {
  if (!suggestions) {
    // Manual picking is the whole task here; a missing suggestion is a footnote, not an error.
    return error ? <p className="small c3">Suggestions are unavailable right now. Pick the agents yourself.</p> : null;
  }
  const exploring = suggestions.mode === "explore";
  return (
    <section className="card pad24 col g8" aria-label="Suggested agents">
      <div className="row between g12">
        <span className="cap">Suggested agents</span>
        <span className="row g8">
          <span className="small c2">Try a random draw</span>
          <Switch
            checked={exploring}
            label="Try a random draw"
            onChange={(on) => {
              onExplore(on);
            }}
          />
        </span>
      </div>
      <p className="small c3">
        {loading
          ? "Updating…"
          : exploring
            ? "Random draw: each agent's place comes from one draw over its record, so a less-tried agent can come first and the order changes with every draw. Turn it off for the ranking."
            : "Ranked by expected success per dollar. A random draw gives less-tried agents a chance; each draw counts toward an hourly limit."}
      </p>
      <p className="small c3" id={noteId}>
        {suggestions.note}
      </p>
      {stale && <p className="small c3">These are for the saved budgets. Save your changes to update them.</p>}
      {error && (
        <p className="small c3" role="status">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Review of a draft plan (plan task O3): the requester edits any task or its check, picks the agents,
 * chooses how to pay, and approves. Approving saves pending edits first, so what is approved is what is
 * on screen; after it, the plan is locked.
 */
export function DraftPlanEditor({
  plan,
  agents,
  onChanged,
}: {
  plan: Plan;
  agents: AgentInfo[] | null;
  onChanged: () => void;
}) {
  const { session, account } = useAuth();
  const { credits, error: creditsError } = useCredits(session !== null);
  // A free-trial account has no wallet: its plans can only be paid from credits, and the API refuses anything else.
  const trial = isTrialSession(account, session?.address);
  const [forms, setForms] = useState<TaskForm[]>(() => toForms(plan));
  const [chosen, setFunding] = useState<FundingOption>("Wallet");
  const funding: FundingOption = trial ? "Free credits" : chosen;
  const { busy, problems, setProblems, submit } = useSubmit();
  const edited = hasEdits(plan, forms);
  const total = totalBudget(forms);
  // The API refuses an over-limit credits plan too; saying so here keeps the button from inviting a refusal.
  const creditLimit = funding === "Free credits" ? creditProblem(credits, total) : null;
  // Advice only: the suggestions can fill the pick slots, and approval still sends whatever the slots hold.
  const saved = plan.tasks.map((t) => t.budget_usdc_units).join(",");
  const advice = useSuggestions(plan.plan_uuid, saved);
  const budgetsEdited = forms.some(
    (f) => parseUsdc(f.budget)?.toString() !== plan.tasks.find((t) => t.index === f.index)?.budget_usdc_units,
  );
  const noteId = useId();

  const update = (next: TaskForm) => {
    setForms((list) => list.map((f) => (f.index === next.index ? next : f)));
  };

  const save = () => {
    const local = editProblems(forms);
    if (local.length > 0) {
      setProblems(local);
      return;
    }
    void submit(async () => {
      await editPlan(plan.plan_uuid, toEdits(forms));
      onChanged();
    });
  };

  const approve = () => {
    const local = [...editProblems(forms), ...pickProblems(forms)];
    if (local.length > 0) {
      setProblems(local);
      return;
    }
    void submit(async () => {
      if (edited) await editPlan(plan.plan_uuid, toEdits(forms));
      await approvePlan(plan.plan_uuid, toApproval(forms, FUNDING[funding]));
      onChanged();
    });
  };

  return (
    <section className="lr-draft">
      <div className="col g16 min0">
        <SuggestionsPanel
          suggestions={advice.suggestions}
          error={advice.error}
          loading={advice.loading}
          stale={budgetsEdited}
          noteId={noteId}
          onExplore={advice.setExplore}
        />
        {forms.map((form) => (
          <TaskDraftCard
            key={form.index}
            form={form}
            agents={agents ?? []}
            onChange={update}
            suggestion={advice.suggestions?.tasks.find((t) => t.index === form.index)}
            mode={advice.suggestions?.mode}
            noteId={noteId}
          />
        ))}
      </div>
      <aside className="card pad24 col g16 lr-approve" aria-label="Approve the plan">
        <h2 className="title">Approve and pay</h2>
        <div className="col g4">
          <span className="small c2">Total for {forms.length} tasks</span>
          <span className="stat" data-testid="plan-total">
            {formatUsdc(total)} <span className="small c2">USDC</span>
          </span>
          <span className="small c3">of {formatUsdc(BigInt(plan.budget_usdc_units))} USDC you offered</span>
        </div>
        <div className="col g8">
          <span className="cap">Pay with</span>
          <Segmented
            options={trial ? CREDITS_ONLY : FUNDING_OPTIONS}
            value={funding}
            onChange={setFunding}
            label="Pay with"
          />
          <span className="small c3">
            {funding === "Wallet"
              ? "You fund the plan from your wallet after approving. Nothing moves until you confirm it there."
              : creditsError
                ? creditsError
                : `Free credits left: ${credits ? formatUsdc(credits.remaining) : "…"} USDC. Tasks paid with credits are always audited.`}
          </span>
        </div>
        {creditLimit && (
          <p className="small ca" role="alert">
            {creditLimit}
          </p>
        )}
        <Problems items={problems} />
        <div className="col g8">
          <button
            type="button"
            className="btn primary block"
            disabled={busy || !agents || creditLimit !== null}
            onClick={approve}
          >
            <Icon name="check" size={16} />
            {busy ? "Working…" : "Approve plan"}
          </button>
          <button type="button" className="btn secondary block" disabled={busy || !edited} onClick={save}>
            Save changes
          </button>
          <span className="small c3">Approving locks the tasks, their checks and your agent picks.</span>
        </div>
      </aside>
    </section>
  );
}
