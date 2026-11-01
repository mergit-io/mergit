import { Navigate, createBrowserRouter } from "react-router-dom";
import { RequireSession } from "../auth/RequireSession";
import { AppShell } from "../components/AppShell";
import { LandingPage } from "../landing/LandingPage";
import { runDetail } from "../mock/data";
import { Agents } from "../screens/agents/Agents";
import { Integrations } from "../screens/Integrations";
import { Leaderboard } from "../screens/Leaderboard";
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
import { LiveOverview } from "../screens/live/LiveOverview";
import { LiveWallet } from "../screens/live/LiveWallet";
import { LiveNewRun } from "../screens/live/run/LiveNewRun";
import { LiveRunWorkspace } from "../screens/live/run/LiveRunWorkspace";
import { LiveRuns } from "../screens/live/run/LiveRuns";
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
          // Reputation is not computed and no integration is wired, so live data has neither page.
          { path: "leaderboard", element: live ? <Navigate to={paths.app} replace /> : <Leaderboard /> },
          { path: "integrations", element: live ? <Navigate to={paths.app} replace /> : <Integrations /> },
          { path: "wallet", element: live ? <LiveWallet /> : <Wallet /> },
          { path: "*", element: <NotFound /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
