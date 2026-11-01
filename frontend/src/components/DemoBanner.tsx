import { paths } from "../app/paths";

/**
 * Shown on every page of the demo. The demo is sample data, so it says so, and says where the real app is. These are
 * plain links, not router links: leaving the demo is a full page load.
 */
export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <span>
        <strong>Demo.</strong> Everything here is sample data, not a real account or a real run.
      </span>
      <span className="row g16">
        <a href={paths.landing}>Back to home</a>
        <a href={paths.liveApp}>Use the real app</a>
      </span>
    </div>
  );
}
