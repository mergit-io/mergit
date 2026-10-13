import { useCountUp } from '../../hooks/useCountUp'

interface StatCounterProps {
  value: number
  label: string
  suffix?: string
}

export default function StatCounter({ value, label, suffix = '' }: StatCounterProps) {
  const count = useCountUp(value)

  return (
    <div className="flex flex-col gap-1 items-center">
      <span className="font-bold text-2xl text-text-pri font-sans tabular-nums">
        {count.toLocaleString()}{suffix}
      </span>
      <span className="text-[0.7rem] text-text-sec font-mono uppercase tracking-[0.12em]">
        {label}
      </span>
    </div>
  )
}
