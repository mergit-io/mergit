import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { DEFAULT_THEME, STORAGE_KEY } from "./theme";

// index.html carries a plain inline script that runs before first paint and cannot import theme.ts, so the two
// are kept in step by this test instead of by comments alone.

describe("the inline boot script in index.html", () => {
  it("reads the same storage key as theme.ts", () => {
    expect(html).toContain(`localStorage.getItem("${STORAGE_KEY}")`);
  });

  it("falls back to the same default as theme.ts, and only a saved dark choice overrides it", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(html).toContain(`var theme = stored === "dark" ? "dark" : "${DEFAULT_THEME}";`);
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("starts the page metas on the default theme and switches both for dark", () => {
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(html).toContain('<meta name="theme-color" content="#F4F5F7" />');
    expect(html).toContain('theme === "dark" ? "#0B0C0F" : "#F4F5F7"');
  });
});
