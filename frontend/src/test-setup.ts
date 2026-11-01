// Registers jest-dom's matchers (toBeInTheDocument, etc.) for the component tests under src/.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without global test functions enabled, Testing Library's auto-cleanup never registers, so each render
// leaks into the next test unless this unmounts it.
afterEach(() => {
  cleanup();
});

// jsdom has no layout engine, so it never implements ResizeObserver. `Segmented`'s sliding-thumb effect
// only needs it to not throw; no test asserts on the thumb's measured position.
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
