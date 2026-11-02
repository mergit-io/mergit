// Registers jest-dom's matchers (toBeInTheDocument, etc.) for the component tests under src/.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without global test functions enabled, Testing Library's auto-cleanup never registers, so each render
// leaks into the next test unless this unmounts it. A no-op in the node-environment tests.
afterEach(() => {
  cleanup();
});
