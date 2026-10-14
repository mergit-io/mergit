import { Outlet } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";

/** Providers that need the router (auth navigates on sign-in and sign-out). */
export function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
