import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";

export { prefersReducedMotion };
export { useTypewriter } from "../hooks/useTypewriter";

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
