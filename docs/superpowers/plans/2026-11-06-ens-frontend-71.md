# ENS Frontend (#71) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everywhere the web app shows ENS: a public agent profile page, one identity badge component used in the agents list, the router's pick list and the leaderboard, and a live leaderboard. It draws what the #68 read layer returns and nothing else.

**Architecture:** Pure view-model modules (what to say for each result: tested in vitest, since the repo has no React test library) feed small components. A bounded, cached loader sits between list pages and the #68 reader so a page of agents cannot fire unbounded RPC. The public profile route lives outside the session gate. Playwright specs run the real pages against a **test seam** that supplies fake ENS clients. Hosting config (Caddy) is changed so the profile URL works on a direct visit.

**Tech Stack:** React 19, react-router 7, TypeScript 5.9, vitest 5, Playwright, the existing design system (`Badge`, `Icon`, `PageHeader`, `card`/`ledger-table` classes).

**Spec:** `docs/HLD-ens-integration.md` (6.2, 8.3, 8.4, E5, E10, E11, 12.1), GitHub issue #71, and the #68 read layer (`frontend/src/chain/ens/*`, `useAgentEns`). #67's `agent-endpoint[web]` value is the profile URL this plan makes real.

## Findings from reading the code (they change the plan)

1. **The profile URL would be a real 404 in production.** `deploy/Caddyfile` serves `index.html` only for `@spa path / /signin /signin/* /pricing /demo /demo/* /app /app/*`; everything else that is not a file is a 404 by design. `/agents/*` is not listed, so a direct visit or reload of `https://mergit.site/agents/<name>.mergit.eth` fails. (Render's config has `/*`, so it works there.) Task 7 adds it.
2. **`/agents/<label>.json` cannot also be the registration-file URL.** Once `/agents/*` falls back to `index.html`, a JSON file under that prefix would be swallowed. The #67 runbook suggested `https://mergit.site/agents/<label>.json`; this plan moves the files to **`/registrations/<label>.json`** (served from `frontend/public/registrations/`, same origin, so no CORS and no CSP exception).
3. **The CSP is report-only today** (`connect-src 'self' gateway store sepolia.base.org api.github.com`). The mainnet ENS RPC host is not in it, and an operator-hosted registration file on another host never can be. Same-origin hosting (finding 2) keeps Mergit's own agents inside `'self'`. Operator-hosted files would need a server-side proxy before the policy is enforced: out of scope, recorded as a limit.
4. **The platform already has live, public reputation** (`GET /v0/agents/reputation`: success rate, cost, value density per category, with an explicit "prior is not a record" note) and a public agent list (`GET /v0/agents`). `LiveAgents` already shows it. The live leaderboard route currently redirects away. So the leaderboard should rank by the platform's value density (the paper's measure and the repo's source of truth), not by ENS counts.
5. **`AgentPicks` is a native `<select>`**: an option cannot hold a badge component.
6. **No React test library is installed.** Logic goes into pure functions (the repo's pattern: `overview.ts`, `flow.ts`); components stay thin; pages are covered by Playwright.

## Rulings this plan makes (the user can overturn each)

- **Leaderboard ranks by the platform's value density, not by ENS counts.** ENS appears as an identity cell (name and badge) and, on the profile, as a labelled on-chain mirror. This changes the wording of issue #71 and HLD 8.3 step 5, which said the leaderboard shows mirror counts. Reason: E5 (the mirror is not the source of truth) and E11 (ENS never feeds ranking); two competing rankings would confuse readers.
- **Profile route:** `/agents/<label>.mergit.eth` (the full ENS name, matching what the ENS record will hold). A bare label redirects to the full name. Live mode only; the demo and mock builds show the not-found page.
- **Registration files are hosted same-origin** at `/registrations/<label>.json` (O5 answered for Mergit's own agents).
- **Badge states** (icon plus word, never colour alone): `verified` "Verified on ENS" (tick); `unconfirmed` "ENS match, owner not confirmed" (clock, neutral); `owner-changed` "Owner changed since ENS was updated" (warning, no tick); `not-verified` "Not verified on ENS" (cross); and "No ENS name" (nothing) for an agent whose name is not a label. Only `verified` ever shows a tick.
- **`agent-context` is shown as plain text** with line breaks kept: no markdown or HTML is rendered, so nothing in it can inject markup or links. `detail` strings from the reader are shown as text only.
- **A test seam, gated at build time:** `liveEnsClients()` returns `window.__MERGIT_ENS_CLIENTS__` only when `import.meta.env.VITE_E2E === "1"` (set only by the Playwright web server). In a production build the condition is a constant false and the code is removed; a build check proves the string is absent from `dist/`.
- **Who-last-wrote-each-record (`findRecordWriters`) on the profile is best effort and last** (Task 6): window of the last 5,000 mainnet blocks, hidden on any failure; cut it if it is noisy.

## Global Constraints

- Work on `main`; no branches or PRs. **Never run git write commands**; print commit commands for the user, with no `Co-Authored-By` trailer.
- **Pushing `frontend/**` runs frontend CI and then auto-deploys; changing `deploy/Caddyfile` needs `deploy/server/update.sh services` to take effect.** Say so when printing commit commands.
- ENS data is display only (E11). No ranking, filtering, default, sorting or enabling of any control may depend on ENS data. The E11 boundary test must keep passing and be extended (Task 5). Components may import `useAgentEns`/`AgentIdentity`; routing and submission modules may not.
- Everything from chain or from a fetched file is untrusted text: render with React text nodes only, never `dangerouslySetInnerHTML`; links only from values the reader already restricted to https; every external link `target="_blank" rel="noopener noreferrer"`.
- Follow the repo's style: prettier, eslint (type-aware rules), `tsc -b`, colocated `*.test.ts`, user-facing messages as plain sentences, accessible markup (roles, `sr-only` text, focus visible). `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` must pass.
- Mainnet and Base Sepolia are read-only. No key is handled. RPC URL via `VITE_ENS_RPC_URL`.
- Live mode only (`DATA_MODE === "live"`); in demo and mock builds nothing ENS is fetched.

## Review Focus

1. **A tick for anything but `verified`**, or a state shown by colour alone. (Tasks 1, 2)
2. **Hostile text from chain or a registration file** (script tags, markdown links, `javascript:` and `data:` URLs, very long strings, newlines, RTL and zero-width characters, a lookalike endpoint) reaching the DOM as markup or as a clickable link it should not be. (Tasks 1, 2, 3)
3. **ENS influencing order, choice or availability** anywhere: leaderboard rank, pick options, defaults, disabled states. (Tasks 4, 5)
4. **Unbounded RPC on a list page:** N agents must not mean N times nine reads at once, repeated on every mount; a failing RPC must degrade to "ENS unavailable" without breaking the page. (Task 1)
5. **The profile URL on a direct visit and reload** in production (Caddy) and in dev, for a known agent, an unknown name, an agent without an ENS name, and with no session. (Tasks 3, 7)

---

### Task 0: Routing helpers and config

**Files:** Create `frontend/src/app/agentRoute.ts`; Test `frontend/src/app/agentRoute.test.ts`; Modify `frontend/src/app/paths.ts`

**Interfaces:** Produces: `agentPath(label: string): string` giving `/agents/<label>.mergit.eth`; `parseAgentParam(param: string | undefined): { label: string; canonical: boolean } | null`; `paths.agent: (label: string) => string`.

- [ ] **Step 1: Write failing tests:** `parseAgentParam("coder-0.mergit.eth")` is `{ label: "coder-0", canonical: true }`; `"coder-0"` is `{ label: "coder-0", canonical: false }` (the page redirects to the full name); `"Coder-0.Mergit.ETH"` lower-cases to the same label, canonical false; `"a.b.mergit.eth"`, `".mergit.eth"`, `"coder-0.mergit.com"`, `"coder 0"`, `""`, `undefined`, a 64-character label and `"coder-0.mergit.eth/../x"` give `null`; `agentPath("coder-0")` is `/agents/coder-0.mergit.eth` and throws for an invalid label.
- [ ] **Step 2: Run and see it fail**, **Step 3: implement** using `ensNameOf`/`labelForAgent` from `chain/ens/names.ts`, **Step 4: pass**, and add `agent` to `paths` (live path, not the demo base: the profile is public and not under `/app`).

---

### Task 1: View models and the bounded loader (pure)

**Files:** Create `frontend/src/chain/ens/identityView.ts`, `frontend/src/chain/ens/ensCache.ts`; Test `frontend/src/chain/ens/identityView.test.ts`, `frontend/src/chain/ens/ensCache.test.ts`

**Interfaces:**
- Produces: `type Tone = "ok" | "weak" | "warn" | "bad" | "none"`; `type IdentityView = { tone: Tone; icon: "tick" | "clock" | "warn" | "fail" | null; label: string; hint: string; showTick: boolean; link: boolean }`; `identityView(state: AgentEnsState): IdentityView`; `failureText(reason: FailureReason): string` (plain sentence per reason); `type EnsLoader = (agent: { agentId: bigint; label: string }) => Promise<AgentEns>`; `cachedEns(load: EnsLoader, opts?: { ttlMs?: number; concurrency?: number; now?: () => number }): EnsLoader`.

- [ ] **Step 1: Write failing tests:** (a) every `badge` value maps to the labels in Rulings and **only `verified` has `showTick: true`** (loop over all `AgentEns["badge"]` values; assert exactly one true); (b) every `FailureReason` has a non-empty sentence (a switch with an exhaustiveness check, plus a test that iterates the list of reasons from a constant exported next to the type); (c) `loading` has a neutral view with no tick, `none` is `{ link: false, label: "No ENS name" }`, `error` says the records could not be read and has no tick; (d) `ready` with `unreadable` entries adds a hint but keeps the badge; (e) `cachedEns`: two concurrent calls for one agent call the loader once; a second call within the TTL does not call it; after the TTL it does; a rejected load is not cached (the next call retries); with `concurrency: 2` and five agents at most two loads are in flight at once; results are keyed by `label:agentId` so two agents never share a value.
- [ ] **Step 2: Run and see it fail**, **Step 3: implement**, **Step 4: run and see it pass.**

---

### Task 2: `AgentIdentity` component and the hook for lists

**Files:** Create `frontend/src/components/AgentIdentity.tsx`, `frontend/src/chain/useAgentEnsCached.ts`; Modify `frontend/src/styles/` (one small CSS file imported by the component)

**Interfaces:** Produces: `<AgentIdentity agent={{ agentId: bigint; name: string }} variant="pill" | "block" />` rendering `identityView` for `useAgentEnsCached(agent)` (same return type as `useAgentEns`, but through one shared `cachedEns(liveLoader, { concurrency: 3, ttlMs: 60_000 })`); the pill is an icon plus a word and a `title`/`aria` description from `hint`; the name links to `agentPath(label)` when `link` is true; a `data-badge` attribute carries the badge for tests.

- [ ] **Step 1: Write the component** from the view model only (no logic of its own), reusing `Icon` and the `badge` classes; add `sr-only` text so state is never colour alone; typecheck, lint and format must pass. (No unit test: logic is in Task 1; behaviour is covered by Task 6's Playwright specs.)

---

### Task 3: Public profile page

**Files:** Create `frontend/src/screens/agent/AgentProfile.tsx`, `frontend/src/screens/agent/profileView.ts`; Test `frontend/src/screens/agent/profileView.test.ts`; Modify `frontend/src/app/router.tsx`

**Interfaces:** Produces: `profileView(ens: AgentEns): ProfileView` where `ProfileView` holds display-ready, already-restricted strings: `title`, `verification: { badge, sentences: string[] }`, `records: { context: string[]` (the text split into lines, each trimmed to 2,000 characters in total) `; endpoint: string | null }`, `operator: { onBase: string | null; onEns: string | null; sentence: string }`, `registry: { identity: string; agentId: string }`, `mirror: { sentence: string; rows: { category: string; audited: number; verified: number }[] } | null`, and short-address helpers; the route `/agents/:ensName` is declared **outside** `RequireSession`, only when `DATA_MODE === "live"`.

- [ ] **Step 1: Write failing tests for `profileView`:** a verified agent produces the verified sentences; each `FailureReason` produces its sentence and the raw `detail` appears only as a quoted fragment capped at 120 characters with newlines removed; `owner-changed` explains that the agent was sold since ENS was last updated and shows both operators; `unconfirmed` explains that the owner record is not on ENS yet; context text keeps line breaks, drops every character below U+0020 except newline, strips zero-width and bidi-override characters (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069), and is capped; an endpoint is passed through only if the reader returned it (never rebuilt); a `malformed` mirror produces a "this record is not shown because it is not valid" sentence and no rows; an `absent` mirror produces a "no on-chain record yet" sentence; the mirror sentence always includes the block number and the words "mirror" and "not a score".
- [ ] **Step 2: Run and see it fail**, **Step 3: implement `profileView`**, **Step 4: pass.**
- [ ] **Step 5: Build `AgentProfile.tsx`** (a public page in the style of `Pricing`: logo, theme toggle, a link to sign in or to the app, no `AppShell`): resolve `:ensName` with `parseAgentParam` (redirect a bare label to the full name; unknown form gives the not-found page); find the agent in the public `GET /v0/agents` list by name (no match: "No agent is called X on Mergit"); an agent whose name is not a label: "This agent has no ENS name"; then `useAgentEns` and draw `profileView` with the pill at the top, the check explained in sentences, the records (context as `<p>` text nodes per line, endpoint as a link), operator, the registry entry with explorer links (Base Sepolia for Identity, Etherscan for the owner and resolver), the on-chain mirror labelled "Mirror of audited, staked outcomes read from Base at block N, not a score", and the platform's own record from the public reputation API in a separate, differently labelled box. Loading and failure states use `readFailure`. Register the route outside `RequireSession`.

---

### Task 4: Live leaderboard

**Files:** Create `frontend/src/screens/live/LiveLeaderboard.tsx`, `frontend/src/screens/live/leaderboard.ts`; Test `frontend/src/screens/live/leaderboard.test.ts`; Modify `frontend/src/app/router.tsx`, `frontend/src/components/navTabs.ts` (and its test) if the tab is hidden in live mode

**Interfaces:** Produces: `rankAgents(rows: AgentReputation[], category: string | "All"): RankedAgent[]` where `RankedAgent = { agentId: string; name: string; categories: AgentReputation[]; valueDensity: number; countedOutcomes: number }`; the live route `leaderboard` renders `LiveLeaderboard` instead of redirecting.

- [ ] **Step 1: Write failing tests (no ENS anywhere in this file or its imports):** rows with `counted_outcomes` 0 or `basis` starting with "prior" are excluded; agents sort by `value_density_per_usdc` descending, ties by `counted_outcomes` descending, then by name; for `"All"` an agent's density is its **counted-outcome-weighted mean** across its categories, for a category it is that category's row; an empty input gives `[]`; the function never reads any ENS value (assert the module imports nothing from `chain/ens`).
- [ ] **Step 2: Run and see it fail**, **Step 3: implement**, **Step 4: pass.**
- [ ] **Step 5: Build `LiveLeaderboard`:** reuse the mock screen's layout and `Segmented` category filter; subtitle "Ranked by value density: verified success per unit of metered cost. Only audited receipts move it."; each row shows `AgentIdentity` (pill) beside the name; an empty state "No agent has validated outcomes yet."; rank and order come only from `rankAgents`. Replace the live redirect for `/app/leaderboard` and show the tab in live mode.

---

### Task 5: Agents list, pick list, and the E11 guard

**Files:** Modify `frontend/src/screens/live/LiveAgents.tsx`, `frontend/src/screens/live/run/AgentPicks.tsx`, `frontend/src/chain/ens/boundary.test.ts`

- [ ] **Step 1: Extend the boundary test first** (it must fail before the change and pass after): `screens/live/run/AgentPicks.tsx` may import `components/AgentIdentity` but **not** `chain/ens`, `useAgentEns` or `liveEns` directly; `screens/live/leaderboard.ts` and `screens/live/run/suggest.ts` must not reach ENS code transitively; the leaderboard ranking module and the pick-option building in `AgentPicks.tsx` must not contain the words `ens`, `badge` or `identity` in the lines that build or order options (a simple source check, with a comment explaining it is a tripwire, not a proof).
- [ ] **Step 2: `LiveAgents`:** add an "ENS name" column with `AgentIdentity` (pill); the existing columns and their data stay as they are.
- [ ] **Step 3: `AgentPicks`:** leave the `<select>` and its option text exactly as they are (so nothing about choice depends on ENS) and add, under it, a block showing `AgentIdentity variant="block"` for each **already picked** agent. If no agent has validated outcomes in the task's category (from the platform's reputation data, not ENS), show "No agent has a record in this category yet. New agents are added by the Mergit team." Run the boundary test and the whole suite.

---

### Task 6: Test seam, writers, and Playwright specs

**Files:** Modify `frontend/src/chain/liveEns.ts`, `frontend/playwright.config.ts` (`LIVE_ENV` gets `VITE_E2E: "1"` and `VITE_ENS_RPC_URL: "http://ens-rpc.test"`); Create `frontend/e2e/live/ens.spec.ts`, `frontend/e2e/live/ensFake.ts`; Optional `frontend/src/chain/ens/writers` use on the profile

- [ ] **Step 1: The seam:** in `liveEnsClients()`, `if (import.meta.env.VITE_E2E === "1" && window.__MERGIT_ENS_CLIENTS__) return window.__MERGIT_ENS_CLIENTS__;` with a declaration file for the global. Add a build check script (`scripts/check-no-test-seam.sh`: `grep -r __MERGIT_ENS_CLIENTS__ dist` must find nothing after `npm run build`) and run it.
- [ ] **Step 2: Fakes:** `ensFake.ts` installs, via `page.addInitScript`, a clients object whose `getEnsText`, `readContract`, `fetchJson` answer from a per-test scenario table (verified, unconfirmed, owner-changed, name-mismatch, read-failed), and the existing `mockBackend` supplies `/v0/agents` and `/v0/agents/reputation`.
- [ ] **Step 3: Write the specs** (they must fail before the screens exist and pass after): the profile of a known agent opens **with no session**, shows the pill and sentences for each scenario, survives `page.reload()`, shows a link that is the https endpoint and **no link** for a `javascript:` endpoint (the reader nulls it), shows `agent-context` containing `<script>` and markdown as plain text, and shows the mirror with its block number; an unknown name shows the "No agent is called" page; an agent whose API name is not a label shows "no ENS name"; the leaderboard ranks by the API's value density **independent of the ENS scenario** (run twice with opposite ENS badges and assert the same order); the agents table shows a pill per agent; `AgentPicks` shows the identity block under a picked agent and the option list is identical under two ENS scenarios; with the ENS RPC failing the pages still render and show "could not read the ENS records". Run with `PLAYWRIGHT_CHROME_PATH` set (needed on NixOS); if the sandbox cannot run a browser, say so and run them outside it.
- [ ] **Step 4 (cuttable): writers on the profile:** call `findRecordWriters` for the five record keys with the last 5,000 blocks; show "last written by <short address>" only when found; hide on any failure.

---

### Task 7: Hosting config, build variables, and the registration-file path

**Files:** Modify `deploy/Caddyfile`, `control-plane/tests/test_caddy_routes.py` (if it pins the SPA list), `deploy/server/build-sites.sh`, `ens/RUNBOOK.md`, `ens/agents.example.json`, `docs/HLD-ens-integration.md`; Create `frontend/public/registrations/.gitkeep`

- [ ] **Step 1: Test first:** read how `test_caddy_routes.py` checks the file; add a failing assertion that `@spa` includes `/agents` and `/agents/*` and that `/registrations/*` is **not** in `@spa` (so JSON files are served as files, not rewritten).
- [ ] **Step 2: Implement:** add `/agents /agents/*` to the `@spa` matcher; add `https://ethereum-rpc.publicnode.com` (or the configured ENS RPC host) to the report-only `connect-src`, with a comment that an operator-hosted registration file would need a proxy before the policy is enforced; pass `VITE_ENS_RPC_URL`, `VITE_ENS_UNIVERSAL_RESOLVER`, `VITE_ENS_REGISTRY` and `VITE_REPUTATION_ANCHOR` in `build-sites.sh` (anchor from the deployment JSON's `reputation_anchor`).
- [ ] **Step 3: Docs:** RUNBOOK step 2 and the example config now say `https://mergit.site/registrations/<label>.json`; HLD O5 answered for Mergit's own agents (same origin; CORS not needed), the profile route and Caddy requirement written down, HLD 8.3 step 5 and the checklist reflect the leaderboard ruling, M4's page done.
- [ ] **Step 4: Verify:** the Caddy test passes; run `caddy validate` or `caddy adapt` on the file if `caddy` is available; say plainly that the change takes effect only after `deploy/server/update.sh services` on the server.

---

### Task 8: Evidence and wrap-up

- [ ] **Step 1:** run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` and the seam check in `frontend/`; the Playwright live project; the `ens/` suite (unchanged, offline) and `control-plane` Caddy test; read every result.
- [ ] **Step 2:** update HLD section 13 (what #71 built and tested, what remains: operator-hosted registration files need a proxy, the CSP is still report-only) and print the commit commands with the deploy warnings.

---

## Self-review

- **Spec coverage (#71):** public profile page outside the gate (Task 3, route in Task 3, hosting in Task 7), identity component with every state (Tasks 1, 2), live leaderboard (Task 4; ruling), reuse-before-create message and router display (Task 5), RPC config and demo-mode behaviour (Global Constraints, Task 7), component, unit and e2e tests (Tasks 1, 3, 4, 6), E11 kept (Task 5 and the boundary test).
- **Not built here, by design:** a server-side proxy for operator-hosted registration files, an enforcing CSP, a persistent ENS cache, markdown rendering, and any ENS-based ranking.
- **Types:** `IdentityView`, `identityView`, `failureText`, `cachedEns`, `EnsLoader`, `ProfileView`, `profileView`, `RankedAgent`, `rankAgents`, `agentPath`, `parseAgentParam` are each defined once and used with the same names later.
