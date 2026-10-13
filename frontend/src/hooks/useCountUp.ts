import { useEffect, useRef, useState } from 'react'

export function useCountUp(target: number, duration = 1800, startDelay = 650): number {
  const [count, setCount] = useState(0)
  const frameRef = useRef<number>(0)

  useEffect(() => {
    const timeout = setTimeout(() => {
      const startTime = performance.now()
      const tick = (now: number) => {
        const elapsed = now - startTime
        const progress = Math.min(elapsed / duration, 1)
        const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)
        setCount(Math.floor(eased * target))
        if (progress < 1) {
          frameRef.current = requestAnimationFrame(tick)
        }
      }
      frameRef.current = requestAnimationFrame(tick)
    }, startDelay)

    return () => {
      clearTimeout(timeout)
      cancelAnimationFrame(frameRef.current)
    }
  }, [target, duration, startDelay])

  return count
}
