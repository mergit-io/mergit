import { cn } from '../../utils/cn'

interface BadgeProps {
  children: React.ReactNode
  color?: string
  className?: string
  dot?: boolean
  dotColor?: string
}

export default function Badge({ children, className, dot, dotColor = '#22d3a0' }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-2 text-text-sec font-mono text-xs tracking-[0.15em] uppercase',
      className
    )}>
      {dot && (
        <span
          className="w-1.5 h-1.5 rounded-full inline-block animate-shimmer"
          style={{ backgroundColor: dotColor }}
        />
      )}
      {children}
    </span>
  )
}
