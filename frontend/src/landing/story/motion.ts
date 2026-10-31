/* Small GSAP helpers shared by the story timeline. */
import gsap from "gsap";
type T = gsap.TweenTarget;
type V = gsap.TweenVars;

export function helpers(tl: gsap.core.Timeline, root: HTMLElement) {
  const q = (s: string) => {
    const e = root.querySelector<HTMLElement>(s);
    if (!e) throw new Error(`story: missing ${s}`);
    return e;
  };
  const qa = (s: string) => Array.from(root.querySelectorAll<HTMLElement>(s));
  const NR = { immediateRender: false };
  /*
   * GSAP applies a tween's starting values only when the tween begins, so anything animated later in the
   * timeline would sit fully visible while its scene fades in, then jump hidden and replay. Applying the
   * first tween's starting values at time 0 keeps every element hidden until its own moment.
   */
  const started = new WeakMap<object, Set<string>>();
  const ft = (t: T, a: V, b: V, d: number, at: number) => {
    const props = Object.keys(a).filter((k) => k !== "attr" && k !== "motionPath");
    for (const el of gsap.utils.toArray<object>(t)) {
      const seen = started.get(el) ?? new Set<string>();
      started.set(el, seen);
      const fresh = props.filter((k) => !seen.has(k));
      if (fresh.length) {
        tl.set(el, Object.fromEntries(fresh.map((k) => [k, a[k as keyof V]])), 0);
        fresh.forEach((k) => seen.add(k));
      }
    }
    return tl.fromTo(t, a, { ...b, ...NR, duration: d }, at);
  };
  /*
   * Scene visibility and stepper text are computed from the playhead on every
   * update rather than tweened, so scrolling back up mirrors scrolling down exactly.
   */
  const scenes = new Map<HTMLElement, [number, number]>();
  const range = (s: string) => {
    const e = q(s);
    const r = scenes.get(e) ?? [-1, Infinity];
    scenes.set(e, r);
    return r;
  };
  const sceneIn = (s: string, a: number) => {
    range(s)[0] = a;
  };
  const sceneOut = (s: string, b: number) => {
    range(s)[1] = b;
  };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  /** Smoothstep: eases both ends so nothing starts or stops abruptly. */
  const ease = (v: number) => v * v * (3 - 2 * v);
  /** A scene fades over a full second; the next one starts fading in as this one starts fading out. */
  const FADE = 1;
  const syncScenes = (t: number) => {
    scenes.forEach(([a, b], e) => {
      const inn = ease(clamp((t - (a - 0.4)) / FADE));
      const out = ease(clamp((b + 0.4 - t) / FADE));
      const o = inn * out;
      e.style.opacity = String(o);
      e.style.visibility = o > 0 ? "visible" : "hidden";
      // enter rising from below and settling; leave drifting up and receding slightly
      const dy = (1 - inn) * 56 - (1 - out) * 40;
      const sc = 1 - (1 - inn) * 0.025 - (1 - out) * 0.015;
      e.style.transform = `translateY(${dy.toFixed(1)}px) scale(${sc.toFixed(4)})`;
    });
  };
  const mask = (s: string, a: number, st = 0.18) =>
    ft(qa(`${s} .mask>span`), { yPercent: 110 }, { yPercent: 0, stagger: st, ease: "power3.out" }, 1.4, a);
  const rise = (t: T, a: number, o: { y?: number; st?: number; d?: number } = {}) =>
    ft(t, { y: o.y ?? 30, opacity: 0 }, { y: 0, opacity: 1, stagger: o.st ?? 0 }, o.d ?? 1.1, a);
  const draw = (els: SVGGeometryElement[], a: number, d = 1, st = 0.1) => {
    for (const p of els) {
      const L = p.getTotalLength();
      p.style.strokeDasharray = String(L);
      p.style.strokeDashoffset = String(L);
    }
    tl.to(els, { strokeDashoffset: 0, duration: d, ease: "power2.inOut", stagger: st }, a);
  };
  const travel = (pk: Element, path: SVGPathElement | string, a: number, d: number, start = 0, end = 1) => {
    ft(pk, { opacity: 0 }, { opacity: 1 }, 0.15, a);
    tl.fromTo(
      pk,
      { motionPath: { path, start, end: start } },
      { motionPath: { path, start, end }, duration: d, ease: "power1.inOut", ...NR },
      a,
    );
    ft(pk, { opacity: 1 }, { opacity: 0 }, 0.15, a + d - 0.05);
  };
  /** Pinned stepper: rail highlight, rail colours and panel texts follow the step under the playhead. */
  const stepper = (scope: string, starts: number[], end: number) => {
    const ri = qa(`${scope} .ri`);
    const pt = qa(`${scope} .pt`);
    const hl = q(`${scope} .rail-hl`);
    const num = q(`${scope} .pn`);
    return (time: number) => {
      let k = 0;
      starts.forEach((s, j) => {
        if (time >= s - 0.2) k = j;
      });
      num.textContent = `0${String(k + 1)}`;
      hl.style.transform = `translateY(${String(86 * k)}px)`;
      ri.forEach((r, j) => {
        r.classList.toggle("on", j === k);
      });
      pt.forEach((p, j) => {
        const s = starts[j] ?? 0;
        const nx = starts[j + 1] ?? end;
        const o = j === k ? ease(clamp((time - s) / 0.9)) * ease(clamp((nx - time) / 0.6)) : 0;
        p.style.opacity = String(o);
        p.style.visibility = o > 0 ? "visible" : "hidden";
        p.style.transform = `translateY(${String((1 - o) * (time < nx - 0.4 ? 40 : -24))}px)`;
      });
    };
  };
  return { q, qa, NR, ft, sceneIn, sceneOut, syncScenes, mask, rise, draw, travel, stepper };
}
export type Helpers = ReturnType<typeof helpers>;
