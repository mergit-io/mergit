import { useCallback, useEffect, useId, useState, type SyntheticEvent } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { Segmented } from "../../components/Segmented";
import { isTrialSession, type IdentityProvider } from "../../auth/account";
import { fetchProviders, oauthStartUrl } from "../../auth/accountApi";
import { useAuth } from "../../auth/context";
import { MergePrompt } from "../../auth/MergePrompt";
import { RedeemCode } from "../../auth/RedeemCode";
import {
  capFromInput,
  capToInput,
  deleteAccount,
  getSettings,
  listSessions,
  putSettings,
  removeIdentity,
  removeWallet,
  revokeOtherSessions,
  updateName,
  type Funding,
  type Preferences,
  type RoutingMode,
  type SessionInfo,
  type SettingsView,
} from "../../auth/settingsApi";
import type { Providers } from "../../auth/signInOptions";
import { useConnectWallet } from "../../auth/useConnectWallet";
import { WalletPicker } from "../../auth/WalletPicker";
import { formatUsdc } from "../../chain/funding";
import { useCredits } from "../../chain/useCredits";
import "../../styles/screens/settings.css";

type Note = { ok: boolean; text: string } | null;

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const PROVIDER_NAME: Record<IdentityProvider, string> = { github: "GitHub", google: "Google", email: "Email" };

function Result({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p className={`small ${note.ok ? "cm" : "cr"}`} role={note.ok ? "status" : "alert"}>
      {note.text}
    </p>
  );
}

/** Runs one action with a busy flag and a message; the section shows what it says. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const run = useCallback((action: () => Promise<string | undefined>) => {
    setBusy(true);
    setNote(null);
    action()
      .then((text) => {
        if (text) setNote({ ok: true, text });
      })
      .catch((e: unknown) => {
        setNote({ ok: false, text: message(e) });
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);
  return { busy, note, run };
}

function Profile({ providers }: { providers: Providers | null }) {
  const { account, refreshAccount } = useAuth();
  const nameId = useId();
  const [name, setName] = useState(account?.name ?? "");
  const save = useAction();
  const unlink = useAction();
  const identities = account?.identities ?? [];
  const linkable = (["github", "google"] as const).filter(
    (p) => providers?.[p] === true && !identities.some((i) => i.provider === p),
  );

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    save.run(async () => {
      const saved = await updateName(name.trim());
      setName(saved);
      await refreshAccount();
      return "Name saved.";
    });
  };

  return (
    <section className="card pad24 col g16" aria-labelledby="st-profile">
      <h2 className="title" id="st-profile">
        Profile
      </h2>
      <form className="col g8" onSubmit={submit}>
        <label className="small strong" htmlFor={nameId}>
          Display name
        </label>
        <div className="row g8">
          <div className="input grow">
            <input
              id={nameId}
              value={name}
              maxLength={80}
              autoComplete="name"
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <button type="submit" className="btn secondary" disabled={save.busy || name.trim() === ""}>
            {save.busy ? "Saving…" : "Save"}
          </button>
        </div>
        <Result note={save.note} />
      </form>
      {account?.email && (
        <div className="col g4">
          <span className="small strong">Email</span>
          <span className="small c2">{account.email}</span>
        </div>
      )}
      <div className="col g8">
        <span className="small strong">Ways to sign in</span>
        {identities.length === 0 && <span className="small c2">No GitHub, Google or email sign-in is linked.</span>}
        {identities.map((i) => (
          <div key={i.provider} className="st-row">
            <span className="grow">
              <span className="strong">{PROVIDER_NAME[i.provider]}</span> <span className="small c2">{i.label}</span>
            </span>
            <button
              type="button"
              className="btn secondary compact"
              disabled={unlink.busy}
              aria-label={`Remove ${PROVIDER_NAME[i.provider]} sign-in`}
              onClick={() => {
                unlink.run(async () => {
                  await removeIdentity(i.provider);
                  await refreshAccount();
                  return `${PROVIDER_NAME[i.provider]} sign-in removed.`;
                });
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <Result note={unlink.note} />
        {linkable.length > 0 && (
          <div className="row g8 st-wrap">
            {linkable.map((p) => (
              <a key={p} className="btn secondary compact" href={oauthStartUrl(p, "register")}>
                Link {PROVIDER_NAME[p]}
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Wallets() {
  const { account, session, refreshAccount } = useAuth();
  const connect = useConnectWallet();
  const remove = useAction();
  const wallets = account?.wallets ?? [];
  return (
    <section className="card pad24 col g16" aria-labelledby="st-wallets">
      <h2 className="title" id="st-wallets">
        Wallets
      </h2>
      {wallets.length === 0 ? (
        <p className="small c2">No wallet is connected. Plans are paid from your free credits.</p>
      ) : (
        <div className="col g8">
          {wallets.map((w) => (
            <div key={w} className="st-row">
              <span className="grow mono-s" title={w}>
                {shortAddress(w)}
              </span>
              {w.toLowerCase() === session?.address.toLowerCase() && <Badge status="Completed" label="In use" />}
              <button
                type="button"
                className="btn secondary compact"
                disabled={remove.busy}
                aria-label={`Remove wallet ${shortAddress(w)}`}
                onClick={() => {
                  remove.run(async () => {
                    await removeWallet(w);
                    await refreshAccount();
                    return "Wallet removed.";
                  });
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <Result note={remove.note} />
      <div className="col g8">
        <span className="small strong">Add a wallet</span>
        {connect.error && (
          <p className="small cr" role="alert">
            {connect.error}
          </p>
        )}
        {connect.offer ? (
          <MergePrompt
            offer={connect.offer}
            busy={connect.busy}
            onMerge={connect.merge}
            onCancel={connect.cancelMerge}
          />
        ) : (
          <WalletPicker busy={connect.busy} onMetaMask={connect.connect} />
        )}
      </div>
    </section>
  );
}

function Plan() {
  const { session, account } = useAuth();
  const trial = isTrialSession(account, session?.address);
  const { credits, error, refresh } = useCredits(session !== null);
  return (
    <section className="card pad24 col g16" aria-labelledby="st-plan">
      <h2 className="title" id="st-plan">
        Plan and credits
      </h2>
      <div className="st-plans">
        <div className="st-plan on">
          <div className="row between">
            <span className="strong">{trial ? "Free trial" : "Pay as you go"}</span>
            <Badge status="Completed" label="Your plan" />
          </div>
          <p className="small c2">
            {trial
              ? "Plans are paid from free test credits. Connect a wallet to pay with your own test USDC."
              : "Plans are paid from your wallet in test USDC. Free credits stay available until they run out."}
          </p>
        </div>
        <div className="st-plan">
          <div className="row between">
            <span className="strong">Pro</span>
            <Badge status="Waiting" label="Coming soon" />
          </div>
          <p className="small c2">Not available yet. Nothing is billed on Mergit while it runs on a test network.</p>
        </div>
      </div>
      {error ? (
        <p className="small c2">{error}</p>
      ) : (
        <p className="small c2">
          Free credits left:{" "}
          <span className="strong" data-testid="settings-credits">
            {credits ? formatUsdc(credits.remaining) : "…"} USDC
          </span>
        </p>
      )}
      <RedeemCode onRedeemed={refresh} />
    </section>
  );
}

const ATTEMPTS = ["1", "2", "3"] as const;

function Preferences({ view, onSaved }: { view: SettingsView; onSaved: (v: SettingsView) => void }) {
  const modelId = useId();
  const perPlanId = useId();
  const dailyId = useId();
  const { session, account } = useAuth();
  const trial = isTrialSession(account, session?.address);
  const p = view.preferences;
  const [model, setModel] = useState(p.planner_model ?? "");
  const [mode, setMode] = useState<RoutingMode>(p.routing_mode);
  const [attempts, setAttempts] = useState(String(p.max_attempts));
  const [funding, setFunding] = useState<Funding>(p.default_funding);
  const [perPlan, setPerPlan] = useState(capToInput(p.per_plan_cap_usdc_units));
  const [daily, setDaily] = useState(capToInput(p.daily_cap_usdc_units));
  const save = useAction();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const a = capFromInput(perPlan);
    const b = capFromInput(daily);
    if (!a.ok || !b.ok) {
      save.run(() => Promise.reject(new Error(a.ok ? (b.ok ? "" : b.error) : a.error)));
      return;
    }
    const next: Preferences = {
      planner_model: model === "" ? null : model,
      routing_mode: mode,
      max_attempts: Number(attempts),
      default_funding: funding,
      per_plan_cap_usdc_units: a.units,
      daily_cap_usdc_units: b.units,
    };
    save.run(async () => {
      onSaved(await putSettings(next));
      return "Preferences saved.";
    });
  };

  return (
    <form className="card pad24 col g16" aria-labelledby="st-prefs" onSubmit={submit}>
      <h2 className="title" id="st-prefs">
        Run preferences
      </h2>
      <div className="col g8">
        <label className="small strong" htmlFor={modelId}>
          Model that drafts your plans
        </label>
        <select
          id={modelId}
          className="st-select"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
          }}
        >
          <option value="">Mergit&apos;s default ({view.defaultPlannerModel})</option>
          {view.plannerModels
            .filter((m) => m !== view.defaultPlannerModel)
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
        <span className="small c2">Only models Mergit has a price for are offered.</span>
      </div>
      <div className="col g8">
        <span className="small strong">Agent suggestions</span>
        <Segmented options={["greedy", "explore"] as const} value={mode} onChange={setMode} label="Suggestion mode" />
        <span className="small c2">
          Greedy suggests the agents with the best record. Explore also tries unproven agents, which can cost more.
        </span>
      </div>
      <div className="col g8">
        <span className="small strong">Agents per task</span>
        <Segmented
          options={ATTEMPTS}
          value={attempts as (typeof ATTEMPTS)[number]}
          onChange={setAttempts}
          label="Agents per task"
        />
        <span className="small c2">The first agent does the work; the others are tried in order if it fails.</span>
      </div>
      <div className="col g8">
        <span className="small strong">Pay with</span>
        <Segmented options={["credits", "wallet"] as const} value={funding} onChange={setFunding} label="Pay with" />
        {trial && funding === "wallet" && (
          <span className="small c2">A free-trial account can only pay from credits until a wallet is connected.</span>
        )}
      </div>
      <h2 className="title" id="st-limits">
        Spend limits
      </h2>
      <p className="small c2">
        Mergit refuses to approve a plan that would go over these. Leave a box empty for no limit.
      </p>
      <div className="row g12 st-wrap">
        <div className="col g8 grow">
          <label className="small strong" htmlFor={perPlanId}>
            Per plan (USDC)
          </label>
          <div className="input">
            <input
              id={perPlanId}
              inputMode="decimal"
              placeholder="No limit"
              value={perPlan}
              onChange={(e) => {
                setPerPlan(e.target.value);
              }}
            />
          </div>
        </div>
        <div className="col g8 grow">
          <label className="small strong" htmlFor={dailyId}>
            Per 24 hours (USDC)
          </label>
          <div className="input">
            <input
              id={dailyId}
              inputMode="decimal"
              placeholder="No limit"
              value={daily}
              onChange={(e) => {
                setDaily(e.target.value);
              }}
            />
          </div>
        </div>
      </div>
      <div className="row g12">
        <button type="submit" className="btn primary" disabled={save.busy}>
          {save.busy ? "Saving…" : "Save preferences"}
        </button>
      </div>
      <Result note={save.note} />
    </form>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const out = useAction();
  const load = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch((e: unknown) => {
        setError(message(e));
      });
  }, []);
  useEffect(load, [load]);
  const others = (sessions ?? []).filter((s) => !s.current).length;
  return (
    <section className="card pad24 col g16" aria-labelledby="st-sessions">
      <h2 className="title" id="st-sessions">
        Devices and sign out
      </h2>
      {error ? (
        <p className="small c2">{error}</p>
      ) : (
        <div className="col g8">
          {(sessions ?? []).map((s) => (
            <div key={`${s.createdAt}-${s.address}`} className="st-row">
              <span className="grow small">
                Signed in {when(s.createdAt)}
                <span className="c3"> · acts as {shortAddress(s.address)}</span>
              </span>
              {s.current && <Badge status="Completed" label="This device" />}
            </div>
          ))}
        </div>
      )}
      <div className="row g12 st-wrap">
        <button
          type="button"
          className="btn secondary"
          disabled={out.busy || others === 0}
          onClick={() => {
            out.run(async () => {
              const n = await revokeOtherSessions();
              load();
              return n === 0
                ? "No other devices were signed in."
                : `Signed out ${String(n)} other ${n === 1 ? "device" : "devices"}.`;
            });
          }}
        >
          Sign out other devices
        </button>
        <SignOutButton />
      </div>
      <Result note={out.note} />
    </section>
  );
}

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <Button variant="secondary" onClick={signOut}>
      Sign out
    </Button>
  );
}

function DangerZone() {
  const { signOut } = useAuth();
  const inputId = useId();
  const [text, setText] = useState("");
  const del = useAction();
  const ready = text.trim().toLowerCase() === "delete";
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready) return;
    del.run(async () => {
      await deleteAccount(text);
      signOut();
      return undefined;
    });
  };
  return (
    <form className="card pad24 col g12 st-danger" aria-labelledby="st-danger" onSubmit={submit}>
      <h2 className="title" id="st-danger">
        Delete account
      </h2>
      <p className="small c2">
        This removes your sign-in methods, wallets and sessions, and blanks the goal and repository of every plan you
        made. What is already on the chain, the settlement records and the receipts stay, because they are public and
        cannot be erased. The free credits are once per person, so signing up again will not give you more. A plan that
        is still running must finish first.
      </p>
      <label className="small strong" htmlFor={inputId}>
        Type delete to confirm
      </label>
      <div className="row g8">
        <div className="input grow">
          <input
            id={inputId}
            value={text}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </div>
        <button type="submit" className="btn st-delete" disabled={!ready || del.busy}>
          {del.busy ? "Deleting…" : "Delete my account"}
        </button>
      </div>
      <Result note={del.note} />
    </form>
  );
}

/** Settings on live data: profile, sign-in methods, wallets, plan, run preferences, devices, and deleting the account. */
export function LiveSettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  useEffect(() => {
    getSettings()
      .then(setView)
      .catch((e: unknown) => {
        setError(message(e));
      });
    void fetchProviders().then(setProviders);
  }, []);

  return (
    <>
      <PageHeader title="Settings" subtitle="Your account, wallets, defaults and limits." />
      <div className="st-grid">
        <Profile providers={providers} />
        <Wallets />
        <Plan />
        {view ? (
          <Preferences key={JSON.stringify(view.preferences)} view={view} onSaved={setView} />
        ) : (
          <section className="card pad24 col g8" aria-busy={error === null}>
            <h2 className="title">Run preferences</h2>
            <p className="small c2" role={error ? "alert" : undefined}>
              {error ?? "Loading…"}
            </p>
          </section>
        )}
        <Sessions />
        <DangerZone />
      </div>
    </>
  );
}
