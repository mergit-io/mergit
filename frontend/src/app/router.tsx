import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { runDetail, proof } from "../mock/data";
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

/**
 * The design has no runs or proofs list screens, so those tabs open the demo
 * run and proof directly.
 */
export const router = createBrowserRouter([
  { path: "/signin", element: <SignIn /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Overview /> },
      { path: "runs", element: <Navigate to={`/runs/${runDetail.id}`} replace /> },
      { path: "runs/new", element: <NewRun /> },
      { path: "runs/:runId", element: <RunWorkspace /> },
      { path: "agents", element: <Agents /> },
      { path: "proofs", element: <Navigate to={`/proofs/${proof.id}`} replace /> },
      { path: "proofs/:proofId", element: <ProofDetail /> },
      { path: "leaderboard", element: <Leaderboard /> },
      { path: "integrations", element: <Integrations /> },
      { path: "wallet", element: <Wallet /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
