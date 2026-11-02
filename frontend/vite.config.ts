/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Unit tests live next to the code; the Playwright suites in e2e/ run separately. The few tests that render
  // components or hooks opt into jsdom with a `// @vitest-environment jsdom` line; the rest stay on node.
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], setupFiles: ["src/test-setup.ts"] },
});
