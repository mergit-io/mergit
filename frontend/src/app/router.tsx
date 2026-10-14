import { Navigate, createBrowserRouter } from "react-router-dom";
import { RequireSession } from "../auth/RequireSession";
import { AppShell } from "../components/AppShell";
import { LandingPage } from "../landing/LandingPage";
import { proof, runDetail } from "../mock/data";
import { Agents } from "../screens/Agents";
import { Integrations } from "../screens/Integrations";
import { Leaderboard } from "../screens/Leaderboard";
import { NewRun } from "../screens/NewRun";
import { NotFound } from "../screens/NotFound";
import { Overview } from "../screens/Overview";
import { ProofDetail } from "../screens/ProofDetail";
import { RunWorkspace } from "../screens/run/RunWorkspace";
import { SignIn } from "../screens/SignIn";
import { Wallet } from "../screens/Wallet";
import { paths } from "./paths";
import { RootLayout } from "./RootLayout";

/**
 * `/` is the landing page and `/app` the dashboard. The design has no runs or
 * proofs list screens, so those tabs open the demo run and proof directly.
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: paths.landing, element: <LandingPage /> },
      { path: paths.signIn, element: <SignIn /> },
      {
        path: paths.app,
        element: (
          <RequireSession>
            <AppShell />
          </RequireSession>
        ),
        children: [
          { index: true, element: <Overview /> },
          { path: "runs", element: <Navigate to={paths.run(runDetail.id)} replace /> },
          { path: "runs/new", element: <NewRun /> },
          { path: "runs/:runId", element: <RunWorkspace /> },
          { path: "agents", element: <Agents /> },
          { path: "proofs", element: <Navigate to={paths.proof(proof.id)} replace /> },
          { path: "proofs/:proofId", element: <ProofDetail /> },
          { path: "leaderboard", element: <Leaderboard /> },
          { path: "integrations", element: <Integrations /> },
          { path: "wallet", element: <Wallet /> },
          { path: "*", element: <NotFound /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
