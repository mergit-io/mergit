/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Unit tests live next to the code; the Playwright suites in e2e/ run separately. `.test.tsx` (today just
  // `FundingChoice.test.tsx`) renders a component with `@testing-library/react` and opts into a jsdom
  // environment itself (`// @vitest-environment jsdom`), rather than switching every `.test.ts` file's
  // environment -- several of those (`chain/wallet.ts`'s `pageOrigin`, `config/live.ts`) branch on
  // `typeof window === "undefined"` and are deliberately exercised under Node's real absence of `window`.
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
