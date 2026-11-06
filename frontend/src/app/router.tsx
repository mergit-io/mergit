import { Navigate, createBrowserRouter } from "react-router-dom";
import { RequireSession } from "../auth/RequireSession";
import { AppShell } from "../components/AppShell";
import { LandingPage } from "../landing/LandingPage";
import { runDetail } from "../mock/data";
import { Agents } from "../screens/agents/Agents";
import { Integrations } from "../screens/Integrations";
import { Leaderboard } from "../screens/Leaderboard";
import { Pricing } from "../screens/Pricing";
import { NewRun } from "../screens/NewRun";
import { NotFound } from "../screens/NotFound";
import { Overview } from "../screens/Overview";
import { ProofDetail } from "../screens/ProofDetail";
import { ProofLedger } from "../screens/proofs/ProofLedger";
import { RunWorkspace } from "../screens/run/RunWorkspace";
import { SignIn } from "../screens/SignIn";
import { Wallet } from "../screens/Wallet";
import { DATA_MODE, IN_DEMO } from "../config/live";
import { LiveProofDetail } from "../screens/live/LiveProofDetail";
import { LiveProofLedger } from "../screens/live/LiveProofLedger";
import { LiveAgents } from "../screens/live/LiveAgents";
import { LiveLeaderboard } from "../screens/live/LiveLeaderboard";
import { LiveOverview } from "../screens/live/LiveOverview";
import { LiveWallet } from "../screens/live/LiveWallet";
import { LiveNewRun } from "../screens/live/run/LiveNewRun";
import { LiveRunWorkspace } from "../screens/live/run/LiveRunWorkspace";
import { LiveSettings } from "../screens/live/LiveSettings";
import { LiveRuns } from "../screens/live/run/LiveRuns";
import { AgentProfile } from "../screens/agent/AgentProfile";
import { LedgerPage } from "../screens/ledger/LedgerPage";
import { AGENT_ROUTE } from "./agentRoute";
import { HardNavigate } from "./HardNavigate";
import { paths } from "./paths";
import { RootLayout } from "./RootLayout";

const live = DATA_MODE === "live";

/**
 * `/` is the landing page, `/app` the dashboard on live data and `/demo` the same dashboard over sample data. The
 * mode is fixed by the address the page was loaded at, so a route that belongs to the other side loads the page
 * again (HardNavigate) instead of rendering the wrong mode: in the demo that is the home page, sign-in and /app; on
 * the real site it is /demo. The design has no runs list screen, so on sample data that tab opens the demo run
 * directly; on live data it lists the user's plans.
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: paths.landing, element: IN_DEMO ? <HardNavigate /> : <LandingPage /> },
      { path: paths.signIn, element: IN_DEMO ? <HardNavigate /> : <SignIn /> },
      { path: paths.pricing, element: IN_DEMO ? <HardNavigate /> : <Pricing /> },
      // An agent's public ENS profile: no session needed. Live data only; the demo and mock builds fall to not-found.
      ...(live ? [{ path: AGENT_ROUTE, element: <AgentProfile /> }] : []),
      // The public final ledger (ENS record mergit.ledger and the file it commits to): no session, live data only.
      ...(live ? [{ path: paths.ledger, element: <LedgerPage /> }] : []),
      { path: IN_DEMO ? `${paths.liveApp}/*` : `${paths.demo}/*`, element: <HardNavigate /> },
      {
        path: paths.app,
        element: (
          <RequireSession>
            <AppShell />
          </RequireSession>
        ),
        children: [
          { index: true, element: live ? <LiveOverview /> : <Overview /> },
          { path: "runs", element: live ? <LiveRuns /> : <Navigate to={paths.run(runDetail.id)} replace /> },
          { path: "runs/new", element: live ? <LiveNewRun /> : <NewRun /> },
          { path: "runs/:runId", element: live ? <LiveRunWorkspace /> : <RunWorkspace /> },
          { path: "agents", element: live ? <LiveAgents /> : <Agents /> },
          { path: "proofs", element: live ? <LiveProofLedger /> : <ProofLedger /> },
          { path: "proofs/:proofId", element: live ? <LiveProofDetail /> : <ProofDetail /> },
          // The live leaderboard ranks the platform's reputation. No integration is wired, so live data has no
          // Integrations page.
          { path: "leaderboard", element: live ? <LiveLeaderboard /> : <Leaderboard /> },
          { path: "integrations", element: live ? <Navigate to={paths.app} replace /> : <Integrations /> },
          { path: "wallet", element: live ? <LiveWallet /> : <Wallet /> },
          // Settings are about a real account; the demo has none, so it goes back to the dashboard.
          { path: "settings", element: live ? <LiveSettings /> : <Navigate to={paths.app} replace /> },
          { path: "*", element: <NotFound /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
