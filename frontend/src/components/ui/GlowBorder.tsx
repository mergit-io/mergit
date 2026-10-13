import { cn } from '../../utils/cn'

interface GlowBorderProps {
  children: React.ReactNode
  className?: string
  pulse?: boolean
}

export default function GlowBorder({ children, className, pulse }: GlowBorderProps) {
  return (
    <div className={cn(
      'glow-border rounded-lg',
      pulse && 'animate-glow-pulse',
      className
    )}>
      {children}
    </div>
  )
}
