/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Unit tests live next to the code; the Playwright suites in e2e/ run separately.
  test: { include: ["src/**/*.test.ts"] },
});
