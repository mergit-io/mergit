/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Unit tests live next to the code; the Playwright suites in e2e/ run separately. jsdom is only needed
  // for the handful of `.test.tsx` component tests; the plain `.test.ts` ones don't touch the DOM.
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
  },
});
