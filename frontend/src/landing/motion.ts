import { useEffect, useRef, useState, type RefObject } from "react";

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True once the element has scrolled into view (and stays true). */
export function useInView<T extends Element>(threshold = 0.25): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [threshold, inView]);
  return [ref, inView];
}

/**
 * Types `text` out once `start` is true. Reduced motion shows it whole.
 * Returns the visible text and whether typing has finished.
 */
export function useTypewriter(text: string, start: boolean, msPerChar = 38, delay = 0) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    let i = 0;
    let timer = window.setTimeout(function tick() {
      i += 1;
      setCount(i);
      if (i < text.length) timer = window.setTimeout(tick, msPerChar);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text, start, msPerChar, delay]);
  return [text.slice(0, count), count >= text.length] as const;
}

/** Steps through `count` stages, one every `interval` ms, once `start` is true. */
export function useStepper(count: number, start: boolean, interval: number, delay = 0) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setStep(count);
      return;
    }
    let n = 0;
    let timer = window.setTimeout(function tick() {
      n += 1;
      setStep(n);
      if (n < count) timer = window.setTimeout(tick, interval);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [count, start, interval, delay]);
  return step;
}
