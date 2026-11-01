/**
 * One site, two modes. The demo lives at /demo on the same host as the real app: it runs the same bundle over sample
 * data and never touches the API, the chain or a real session. The mode is decided once, from the URL the page was
 * loaded at, so moving between the demo and the real app is always a full page load (see HardNavigate) and the two
 * can never share state.
 */
export type DataMode = "mock" | "live";

export const DEMO_PREFIX = "/demo";

/** True at /demo and below it, and only there: /demonstration and /app/demo are not the demo. */
export function isDemoPath(pathname: string): boolean {
  return pathname === DEMO_PREFIX || pathname.startsWith(`${DEMO_PREFIX}/`);
}

/** Sample data in the demo whatever the build is; otherwise the build's own mode. */
export function resolveMode(pathname: string, build: DataMode): DataMode {
  return isDemoPath(pathname) ? "mock" : build;
}

/** Where the dashboard's links are rooted. */
export function appBase(inDemo: boolean): "/demo" | "/app" {
  return inDemo ? DEMO_PREFIX : "/app";
}
