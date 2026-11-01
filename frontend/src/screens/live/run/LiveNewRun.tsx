import { useEffect, useState, type SyntheticEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { paths } from "../../../app/paths";
import { createPlan } from "../../../api/client";
import { parseRepo, repoUrl } from "../../../api/github";
import { useAgents } from "../../../api/useAgents";
import { fetchProviders, oauthStartUrl } from "../../../auth/accountApi";
import { isTrialSession } from "../../../auth/account";
import { useAuth } from "../../../auth/context";
import { creditBudget, creditProblem, MAX_BUDGET } from "../../../chain/creditLimits";
import { formatUsdc, parseUsdc, usdcText } from "../../../chain/funding";
import { useCredits } from "../../../chain/useCredits";
import { Icon, type IconName } from "../../../components/Icon";
import { Combo, type ComboOption } from "./Combo";
import { Problems } from "./Problems";
import { useBranches, useRepoList } from "./useGitHub";
import { useSubmit } from "./useSubmit";
import "../../../styles/screens/live-run.css";
import "../../../styles/screens/live-new-run.css";

const GOAL_LIMIT = 8000;
const LIST_LIMIT = 8;

/** Kinds of work. The planner is told the kind (its prompt names the task category); the API takes any slug. */
const KINDS: { value: string; label: string; icon: IconName; placeholder: string }[] = [
  {
    value: "test-repair",
    label: "Fix failing tests",
    icon: "flask",
    placeholder: "The refund test in payments/ passes again",
  },
  { value: "bug-fix", label: "Fix a bug", icon: "bug", placeholder: "Expired sessions no longer log users out" },
  {
    value: "security",
    label: "Security",
    icon: "shield",
    placeholder: "The upload endpoint rejects paths outside the uploads folder",
  },
  {
    value: "performance",
    label: "Performance",
    icon: "bolt",
    placeholder: "The search endpoint answers in under 200 ms on the test data",
  },
  { value: "refactor", label: "Refactor", icon: "wrench", placeholder: "The billing module has no circular imports" },
  { value: "docs", label: "Docs", icon: "book", placeholder: "Every public function in api/ has a docstring" },
];

/** Starting points: each fills the goal with a sentence to finish, and picks its kind of work. */
const STARTERS: { kind: string; title: string; goal: string }[] = [
  {
    kind: "test-repair",
    title: "Make a failing test pass",
    goal: "The failing test in <path to the test> passes again, without weakening the test.",
  },
  {
    kind: "bug-fix",
    title: "Fix a bug, with a regression test",
    goal: "<What goes wrong> no longer happens, and a regression test covers it.",
  },
  {
    kind: "security",
    title: "Close a security hole",
    goal: "<Code path> no longer allows <the problem>, and a test proves it.",
  },
];

/** The <…> blanks in the starting points, which must be filled in before a plan is drafted. */
const PLACEHOLDERS = STARTERS.flatMap((st) => st.goal.match(/<[^<>]+>/g) ?? []);

/** How a run goes, as the run page will show it. */
const STEPS: { icon: IconName; label: string }[] = [
  { icon: "sparkle", label: "Mergit drafts tasks, each with a check" },
  { icon: "agents", label: "You review them and pick agents" },
  { icon: "wallet", label: "You fund it; USDC waits in escrow" },
  { icon: "checks", label: "Agents work until each check passes" },
  { icon: "proofs", label: "Every finished task gets a receipt on chain" },
  { icon: "github", label: "You approve the pull request" },
];

type Fields = { goal: string; repo: string; ref: string; budget: string; category: string };

const INITIAL: Fields = { goal: "", repo: "", ref: "main", budget: "5", category: "test-repair" };

/** Problems the form can catch itself; the API checks the repository, branch and category again. */
function fieldProblems(f: Fields): string[] {
  const problems: string[] = [];
  if (!f.goal.trim()) problems.push("Describe the goal.");
  else if (PLACEHOLDERS.some((ph) => f.goal.includes(ph)))
    problems.push("Replace the <…> parts of the goal with your own words.");
  if (!f.repo.trim()) problems.push("Choose a repository, or type its owner/name or https URL.");
  if (!f.ref.trim()) problems.push("Give the branch, tag or commit to start from.");
  const budget = parseUsdc(f.budget);
  if (budget === null || budget <= 0n) problems.push("The budget must be a positive USDC amount.");
  else if (budget > MAX_BUDGET) problems.push(`The budget can be at most ${formatUsdc(MAX_BUDGET)} USDC for one plan.`);
  return problems;
}

/** What the API takes as the repository: a typed owner/name or GitHub URL becomes its https URL. */
const toRepoUrl = (typed: string) => {
  const parsed = parseRepo(typed);
  return parsed ? repoUrl(parsed) : typed.trim();
};

/** New run on live data, laid out like a coding agent's composer: repository and branch, the goal, the kind of work. */
export function LiveNewRun() {
  const navigate = useNavigate();
  const { account, session } = useAuth();
  const [fields, setFields] = useState<Fields>(INITIAL);
  const { busy, problems, setProblems, submit } = useSubmit();
  const [githubOn, setGithubOn] = useState(false);
  const [browse, setBrowse] = useState<string | null>(null);
  const { agents } = useAgents();
  const { credits } = useCredits(session !== null);
  // A free-trial account can only pay from credits, which cover a plan up to a cap: start there, and say so if
  // the budget goes over, instead of letting the plan be drafted and then refused at approval.
  const trial = isTrialSession(account, session?.address);
  const [budgetTouched, setBudgetTouched] = useState(false);
  const startBudget = trial ? creditBudget(credits) : null;
  // Until the budget is edited by hand, it is the credit-covered amount once the credits are known.
  const budget = !budgetTouched && startBudget !== null ? usdcText(startBudget) : fields.budget;
  const budgetUnits = parseUsdc(budget);
  const budgetNote = trial && budgetUnits !== null && budgetUnits > 0n ? creditProblem(credits, budgetUnits) : null;

  useEffect(() => {
    let live = true;
    void fetchProviders().then((p) => {
      if (live) setGithubOn(p?.github === true);
    });
    return () => {
      live = false;
    };
  }, []);

  const githubLogin = account?.identities.find((i) => i.provider === "github")?.label ?? null;
  const owner = browse ?? githubLogin;
  const { repos, error: reposError, loading: reposLoading } = useRepoList(owner);
  const chosen = parseRepo(fields.repo);
  const { branches, defaultBranch, error: branchesError, loading: branchesLoading } = useBranches(chosen);
  // A repository typed rather than picked starts on its own default branch, until a branch is chosen by hand.
  const [refTouched, setRefTouched] = useState(false);
  const ref = refTouched ? fields.ref : (defaultBranch ?? fields.ref);
  const kind = KINDS.find((k) => k.value === fields.category) ?? KINDS[0];

  const set = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
  };

  // Repository suggestions: the listed repositories matching what is typed, then the typed one itself if it is new.
  const query = fields.repo.trim().toLowerCase();
  const listed = (repos ?? []).filter(
    (r) => !query || r.fullName.toLowerCase().includes(query) || query.includes(r.fullName.toLowerCase()),
  );
  const repoOptions: ComboOption[] = listed.slice(0, LIST_LIMIT).map((r) => ({
    id: `repo:${r.fullName}`,
    label: r.fullName,
    detail: r.description ?? undefined,
    meta: r.language ?? undefined,
  }));
  const typedNew =
    chosen && !listed.some((r) => r.fullName.toLowerCase() === `${chosen.owner}/${chosen.name}`.toLowerCase());
  if (typedNew) {
    repoOptions.push({
      id: `use:${chosen.owner}/${chosen.name}`,
      label: `${chosen.owner}/${chosen.name}`,
      detail: "Use this repository",
    });
  }
  const bareOwner = !chosen && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(fields.repo.trim()) ? fields.repo.trim() : null;
  // Offered only when nothing listed matches: a typed owner, to list that owner's public repositories instead.
  if (bareOwner && listed.length === 0 && bareOwner.toLowerCase() !== owner?.toLowerCase()) {
    repoOptions.push({
      id: `owner:${bareOwner}`,
      label: `${bareOwner}/…`,
      detail: `List public repositories of ${bareOwner}`,
    });
  }

  const pickRepo = (o: ComboOption) => {
    if (o.id.startsWith("owner:")) {
      setBrowse(o.id.slice("owner:".length));
      set("repo")("");
      return;
    }
    // A new repository starts on its default branch (a listed one's is known; a typed one's is read with its branches).
    const full = o.id.slice(o.id.indexOf(":") + 1);
    const found = repos?.find((r) => r.fullName === full);
    setRefTouched(false);
    setFields((f) => ({ ...f, repo: full, ref: found?.defaultBranch ?? f.ref }));
  };

  const reposNote = reposLoading
    ? `Loading ${owner ?? ""}'s repositories from GitHub…`
    : reposError
      ? reposError
      : repos && repos.length === 0
        ? `${owner ?? ""} has no public repositories.`
        : !owner
          ? "Type owner/name or paste a GitHub URL. Type just an owner to list their public repositories."
          : undefined;

  const branchQuery = ref.trim().toLowerCase();
  const branchOptions: ComboOption[] = (branches ?? [])
    .filter((b) => !branchQuery || b.toLowerCase().includes(branchQuery) || branches?.includes(ref))
    .slice(0, LIST_LIMIT)
    .map((b) => ({ id: b, label: b }));
  const notABranch = branches && ref.trim() && !branches.includes(ref.trim()) && !/^[0-9a-f]{7,40}$/i.test(ref.trim());
  const branchNote = !chosen
    ? "Choose a repository to list its branches. A tag or commit also works."
    : branchesLoading
      ? "Loading branches…"
      : (branchesError ??
        (notABranch
          ? `${ref.trim()} is not a branch of ${chosen.owner}/${chosen.name}. A tag also works.`
          : undefined));

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const local = fieldProblems({ ...fields, ref, budget });
    if (budgetNote) local.push(budgetNote);
    if (local.length > 0) {
      setProblems(local);
      return;
    }
    void submit(async () => {
      const plan = await createPlan({
        goal: fields.goal.trim(),
        repo_url: toRepoUrl(fields.repo),
        ref: ref.trim(),
        budget_usdc_units: (budgetUnits ?? 0n).toString(),
        category: fields.category,
      });
      await navigate(paths.run(plan.plan_uuid));
    });
  };

  const githubChip = githubLogin ? (
    <span className="nr-link" title="Your public repositories are listed from GitHub">
      <Icon name="github" size={15} /> @{githubLogin}
    </span>
  ) : (
    githubOn && (
      <a className="nr-link" href={oauthStartUrl("github", "login")}>
        <Icon name="github" size={15} /> Connect GitHub
      </a>
    )
  );

  return (
    <section className="nr">
      <div className="nr-hero rise">
        <span className="nr-eyebrow">
          <Icon name="sparkle" size={13} /> Agents that prove their work
        </span>
        <h1 className="nr-title">
          What should be <span className="nr-grad">true</span> when the run is done?
        </h1>
        <p className="c2">
          Describe the outcome. Mergit drafts the tasks and a check for each; you review them before anything is paid.
        </p>
      </div>

      <form className="nr-box rise" style={{ animationDelay: "60ms" }} onSubmit={onSubmit} noValidate>
        <label className="sr-only" htmlFor="nr-goal">
          Goal
        </label>
        <textarea
          id="nr-goal"
          className="nr-goal"
          value={fields.goal}
          maxLength={GOAL_LIMIT}
          placeholder={kind?.placeholder}
          onChange={(e) => {
            set("goal")(e.target.value);
          }}
        />
        <div className="nr-tools">
          <Combo
            label="Repository"
            icon="repo"
            className="nr-repo"
            value={fields.repo}
            onChange={(v) => {
              setRefTouched(false);
              set("repo")(v);
            }}
            onPick={pickRepo}
            options={repoOptions}
            note={reposNote}
            placeholder={githubLogin ? `${githubLogin}/repository` : "owner/repository"}
          />
          <Combo
            label="Branch"
            icon="branch"
            className="nr-branch"
            value={ref}
            onChange={(v) => {
              setRefTouched(true);
              set("ref")(v);
            }}
            onPick={(o) => {
              setRefTouched(true);
              set("ref")(o.id);
            }}
            options={branchOptions}
            note={branchNote}
          />
          <label className="nr-budget" title="The most this run may spend">
            <Icon name="wallet" size={15} />
            <input
              aria-label="Budget (USDC)"
              inputMode="decimal"
              maxLength={12}
              value={budget}
              onChange={(e) => {
                setBudgetTouched(true);
                set("budget")(e.target.value);
              }}
            />
            <span className="mono-s c3">USDC</span>
          </label>
          <span className="grow" />
          <span className="small c3 hide-md nr-count">
            {fields.goal.length > 0 ? `${String(fields.goal.length)} / ${String(GOAL_LIMIT)}` : ""}
          </span>
          <button type="submit" className="nr-send" disabled={busy}>
            <Icon name={busy ? "running" : "sparkle"} size={16} className={busy ? "spin" : undefined} />
            {busy ? "Planning…" : "Draft the plan"}
          </button>
        </div>
      </form>

      {chosen && branchesError && (
        <p className="small ca nr-center">
          {branchesError} A private repository still works if the agents can reach it.
        </p>
      )}
      {budgetNote && problems.length === 0 && (
        <p className="small ca nr-center" role="status">
          {budgetNote}
        </p>
      )}
      <Problems items={problems} />

      <fieldset className="nr-kinds">
        <legend className="sr-only">Kind of work</legend>
        {KINDS.map((k, i) => (
          <label
            key={k.value}
            className={`nr-kind rise${fields.category === k.value ? " on" : ""}`}
            style={{ animationDelay: `${String(100 + i * 40)}ms` }}
          >
            <input
              type="radio"
              name="category"
              value={k.value}
              checked={fields.category === k.value}
              onChange={() => {
                set("category")(k.value);
              }}
            />
            <Icon name={k.icon} size={15} />
            {k.label}
          </label>
        ))}
      </fieldset>

      <div className="nr-starters">
        {STARTERS.map((s, i) => {
          const k = KINDS.find((x) => x.value === s.kind);
          return (
            <button
              key={s.title}
              type="button"
              className="nr-starter rise"
              style={{ animationDelay: `${String(120 + i * 60)}ms` }}
              onClick={() => {
                setFields((f) => ({ ...f, goal: s.goal, category: s.kind }));
                document.getElementById("nr-goal")?.focus();
              }}
            >
              <span className="nr-starter-icon">{k && <Icon name={k.icon} size={16} />}</span>
              <span className="col g4 min0">
                <span className="strong">{s.title}</span>
                <span className="small c3">{s.goal}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="nr-foot">
        {githubChip}
        <Link to={paths.wallet} className="nr-link">
          <Icon name="wallet" size={15} />
          {credits ? `${formatUsdc(credits.remaining)} USDC in free credits` : "Free credits"}
        </Link>
        <Link to={paths.agents} className="nr-link">
          <Icon name="agents" size={15} />
          {agents ? `${String(agents.length)} agent${agents.length === 1 ? "" : "s"} available` : "Agents"}
        </Link>
        <Link to={paths.runs} className="nr-link">
          <Icon name="runs" size={15} />
          Your runs
        </Link>
        <span className="grow" />
        <span className="small c3">Nothing is paid until you approve and fund the plan.</span>
      </div>

      <ol className="nr-steps" aria-label="How a run works">
        {STEPS.map((s, i) => (
          <li key={s.label} className="rise" style={{ animationDelay: `${String(200 + i * 50)}ms` }}>
            <span className="nr-step-n mono-s">{i + 1}</span>
            <Icon name={s.icon} size={16} />
            <span className="small c2">{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
