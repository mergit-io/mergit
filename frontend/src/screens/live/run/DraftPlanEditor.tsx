import { useState } from "react";
import { approvePlan, editPlan } from "../../../api/client";
import type { AgentInfo, Funding, Plan } from "../../../api/types";
import { useCandidates } from "../../../api/useCandidates";
import { isTrialSession } from "../../../auth/account";
import { useAuth } from "../../../auth/context";
import { formatUsdc } from "../../../chain/funding";
import { useCredits } from "../../../chain/useCredits";
import { Icon } from "../../../components/Icon";
import { Segmented } from "../../../components/Segmented";
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
  const { byIndex: candidates, error: candidatesError } = useCandidates(plan.plan_uuid);
  const [chosen, setFunding] = useState<FundingOption>("Wallet");
  const funding: FundingOption = trial ? "Free credits" : chosen;
  const { busy, problems, setProblems, submit } = useSubmit();
  const edited = hasEdits(plan, forms);
  const total = totalBudget(forms);

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
        {forms.map((form) => (
          <TaskDraftCard
            key={form.index}
            form={form}
            agents={agents ?? []}
            candidates={candidates?.get(form.index)?.candidates}
            candidatesError={form.routing === "auto" ? candidatesError : undefined}
            onChange={update}
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
        <Problems items={problems} />
        <div className="col g8">
          <button type="button" className="btn primary block" disabled={busy || !agents} onClick={approve}>
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
