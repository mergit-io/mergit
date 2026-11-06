import { describe, expect, it } from "vitest";

// Sources are read through Vite (`?raw`), not the file system: the app's tsconfig has no Node types.
// Note: Vitest caches this file's transformed code by content, and the glob's file list is part of it. A NEW source file added
// locally is not seen until this file changes (or `node_modules/.vite` is cleared); a fresh checkout (CI) always sees everything.
const run = import.meta.glob<string>("../../screens/live/run/*.ts", { query: "?raw", import: "default", eager: true });
const ens = import.meta.glob<string>("./*.ts", { query: "?raw", import: "default", eager: true });

/** The module paths a source file imports, from its `import ... from "x"`, `export ... from "x"` and `import("x")` statements. */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g))
    if (m[1]) found.push(m[1]);
  return found;
}

/** E11: ENS values are display data. Nothing that routes or submits work may import them. */
export const forbiddenForRouting = (path: string): boolean => /chain\/ens|useAgentEns|liveEns/.test(path);

/** What a file inside chain/ens/ may import, so the fork tests in ens/ can load it with plain Node. */
export function allowedInEns(path: string, isTest: boolean): boolean {
  if (path === "viem" || path.startsWith("viem/")) return true;
  if (path.startsWith("./") && path.endsWith(".ts")) return true;
  return isTest && path === "vitest";
}

/** Every source file in the app (raw text), keyed by its path inside the app, e.g. `/src/api/client.ts`. */
const everything = import.meta.glob<string>(["../../**/*.ts", "../../**/*.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const appPath = (globKey: string): string => new URL(globKey, "http://x/src/chain/ens/boundary.test.ts").pathname;

/** The file a relative import points at, or null for a package or an unknown file. Handles missing extensions, index files and `.js` specifiers. */
export function resolveImport(importer: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = new URL(spec, `http://x${importer}`).pathname;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.jsx$/, ".tsx"),
  ];
  return candidates.find((c) => known.has(c)) ?? null;
}

/** For each file, the app files it imports. */
export function buildGraph(sources: Record<string, string>): Map<string, string[]> {
  const known = new Set(Object.keys(sources));
  const graph = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sources)) {
    const edges = importsOf(source)
      .map((spec) => resolveImport(path, spec, known))
      .filter((p): p is string => p !== null);
    graph.set(path, edges);
  }
  return graph;
}

/** Everything the roots import, directly or through other modules (and the roots themselves). */
export function reachableFrom(graph: ReadonlyMap<string, string[]>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

describe("the boundary helpers can fail", () => {
  it("finds every kind of import statement", () => {
    const src = `import a from "./a";\nimport { b } from 'b';\nexport * from "./c";\nconst d = await import("./d");\nimport "./e";`;
    expect(importsOf(src)).toEqual(["./a", "b", "./c", "./d", "./e"]);
  });

  it("flags a routing file that imports ENS data", () => {
    expect(importsOf(`import { loadAgentEns } from "../chain/ens/agentEns.ts";`).some(forbiddenForRouting)).toBe(true);
    expect(importsOf(`import { useAgentEns } from "../../chain/useAgentEns";`).some(forbiddenForRouting)).toBe(true);
    expect(importsOf(`import { agentName } from "./useAgents";`).some(forbiddenForRouting)).toBe(false);
  });

  it("flags an ens/ file that imports app config, React or an extensionless path", () => {
    expect(allowedInEns("../../config/live", false)).toBe(false);
    expect(allowedInEns("react", false)).toBe(false);
    expect(allowedInEns("./names", false)).toBe(false);
    expect(allowedInEns("vitest", false)).toBe(false);
    expect(allowedInEns("viem", false)).toBe(true);
    expect(allowedInEns("./names.ts", false)).toBe(true);
    expect(allowedInEns("vitest", true)).toBe(true);
  });
});

describe("transitive reachability (the guard cannot be bypassed through a helper module)", () => {
  const known = new Set([
    "/src/screens/run/suggest.ts",
    "/src/screens/run/helpers.ts",
    "/src/chain/ens/agentEns.ts",
    "/src/lib/util/index.ts",
    "/src/lib/words.ts",
    "/src/ui/Card.tsx",
  ]);

  it("resolves relative imports with or without extensions, index files and .js specifiers, and ignores packages", () => {
    const at = (spec: string) => resolveImport("/src/screens/run/suggest.ts", spec, known);
    expect(at("./helpers")).toBe("/src/screens/run/helpers.ts");
    expect(at("./helpers.ts")).toBe("/src/screens/run/helpers.ts");
    expect(at("../../chain/ens/agentEns.ts")).toBe("/src/chain/ens/agentEns.ts");
    expect(at("../../lib/util")).toBe("/src/lib/util/index.ts");
    expect(at("../../ui/Card")).toBe("/src/ui/Card.tsx");
    expect(at("./helpers.js")).toBe("/src/screens/run/helpers.ts");
    expect(at("react")).toBeNull();
    expect(at("./missing")).toBeNull();
  });

  it("finds ENS code reached through another module, which a direct-import check would miss", () => {
    const sources: Record<string, string> = {
      "/src/screens/run/suggest.ts": `import { rank } from "./helpers";`,
      "/src/screens/run/helpers.ts": `import { loadAgentEns } from "../../chain/ens/agentEns.ts";`,
      "/src/chain/ens/agentEns.ts": ``,
    };
    const graph = buildGraph(sources);
    expect(importsOf(sources["/src/screens/run/suggest.ts"] ?? "").some(forbiddenForRouting)).toBe(false); // the direct check sees nothing
    const reached = reachableFrom(graph, ["/src/screens/run/suggest.ts"]);
    expect([...reached].some(forbiddenForRouting)).toBe(true);
  });

  it("copes with import cycles and leaves unrelated modules out", () => {
    const graph = buildGraph({ "/src/a.ts": `import "./b";`, "/src/b.ts": `import "./a";`, "/src/c.ts": `` });
    expect([...reachableFrom(graph, ["/src/a.ts"])].sort()).toEqual(["/src/a.ts", "/src/b.ts"]);
  });
});

describe("the real source tree", () => {
  // Files that route or submit work. If one is renamed, update this list: the test fails rather than silently checking nothing.
  const routing = ["flow.ts", "draft.ts", "suggest.ts", "useSubmit.ts", "singleFlight.ts"];

  it("finds the routing files it is meant to guard", () => {
    const names = Object.keys(run).map((p) => p.slice(p.lastIndexOf("/") + 1));
    for (const f of routing) expect(names, f).toContain(f);
  });

  it("keeps ENS data out of the API client and out of routing and submission code, directly or through any module they import (E11)", () => {
    const sources = Object.fromEntries(Object.entries(everything).map(([key, source]) => [appPath(key), source]));
    const graph = buildGraph(sources);
    const roots = [
      ...Object.keys(sources).filter((p) => p.startsWith("/src/api/") && !p.endsWith(".test.ts")),
      ...routing.map((f) => `/src/screens/live/run/${f}`),
    ];
    expect(roots.length).toBeGreaterThan(5);
    for (const root of roots) {
      expect(graph.has(root), `${root} must exist`).toBe(true);
      expect([...reachableFrom(graph, [root])].filter(forbiddenForRouting), root).toEqual([]);
    }
  });

  const sourceOf = (path: string): string => {
    const found = Object.entries(everything).find(([key]) => appPath(key) === path)?.[1];
    expect(found, `${path} must exist`).toBeDefined();
    return found ?? "";
  };

  it("lets the agent picker show identity only through EnsIdentity, never by reading ENS itself (E11)", () => {
    const imports = importsOf(sourceOf("/src/screens/live/run/AgentPicks.tsx"));
    expect(imports.filter(forbiddenForRouting)).toEqual([]);
    expect(imports.some((p) => /components\/EnsIdentity$/.test(p))).toBe(true);
  });

  it("keeps ENS code out of the leaderboard ranking and the pick suggestions, through any module (E11)", () => {
    const sources = Object.fromEntries(Object.entries(everything).map(([key, source]) => [appPath(key), source]));
    const graph = buildGraph(sources);
    for (const root of ["/src/screens/live/leaderboard.ts", "/src/screens/live/run/suggest.ts"]) {
      expect(graph.has(root), `${root} must exist`).toBe(true);
      expect([...reachableFrom(graph, [root])].filter(forbiddenForRouting), root).toEqual([]);
    }
  });

  // A tripwire, not a proof: it only catches the obvious mistake of naming ENS values in the code that orders agents or
  // builds the pick options. The import checks above are the real guard.
  // Case matters: "density" must not count as "ens".
  const ENS_WORDS = /\b(?:ENS|ens)\b|\bens[A-Z]|Ens(?:\b|[A-Z])|[Bb]adge|[Ii]dentity/;
  const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("finds no ENS words in the leaderboard ranking code (tripwire)", () => {
    // The tripwire can fire, and does not fire on ordinary words.
    for (const hit of ["byBadge(rows)", "ens.badge", "useAgentEns(a)", "ensName", "AgentIdentity", "liveEns()"])
      expect(ENS_WORDS.test(hit), hit).toBe(true);
    for (const miss of ["valueDensity", "value_density_per_usdc", "lengths", "sense"])
      expect(ENS_WORDS.test(miss), miss).toBe(false);
    const code = withoutComments(sourceOf("/src/screens/live/leaderboard.ts"));
    expect(code.split("\n").filter((line) => ENS_WORDS.test(line))).toEqual([]);
  });

  it("finds no ENS words in the lines that build the pick options (tripwire)", () => {
    const source = sourceOf("/src/screens/live/run/AgentPicks.tsx");
    const select = /<select[\s\S]*?<\/select>/.exec(source)?.[0];
    expect(select, "AgentPicks must still build its options in a <select>").toBeDefined();
    expect((select ?? "").split("\n").filter((line) => ENS_WORDS.test(line))).toEqual([]);
  });

  it("keeps chain/ens/ free of app config, React and extensionless imports", () => {
    const files = Object.entries(ens).filter(([p]) => !p.endsWith("boundary.test.ts")); // this file's own sample strings are not imports
    expect(files.length).toBeGreaterThan(5);
    for (const [path, source] of files) {
      const bad = importsOf(source).filter((p) => !allowedInEns(p, path.endsWith(".test.ts")));
      expect(bad, path).toEqual([]);
    }
  });
});
