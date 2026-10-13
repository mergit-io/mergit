import { cn } from '../../utils/cn'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  as?: 'button' | 'a'
  href?: string
}

export default function Button({ variant = 'primary', className, children, as: Tag = 'button', href, ...props }: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-sans font-bold text-sm tracking-widest uppercase px-8 py-3 rounded transition-all duration-200 cursor-pointer'

  const variants: Record<Variant, string> = {
    primary:   'bg-cyan-accent text-bg-base hover:bg-[#a5f3ff] hover:shadow-[0_0_24px_rgba(110,231,255,0.3)] active:scale-[0.99]',
    secondary: 'bg-transparent border border-border-dim text-text-sec hover:border-border-mid hover:text-text-pri',
    ghost:     'bg-transparent border border-[rgba(110,231,255,0.35)] text-cyan-accent hover:border-[rgba(110,231,255,0.7)] hover:shadow-[0_0_12px_rgba(110,231,255,0.15)]',
  }

  if (Tag === 'a') {
    return (
      <a href={href} className={cn(base, variants[variant], className)} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    )
  }

  return (
    <button className={cn(base, variants[variant], className)} {...props}>
      {children}
    </button>
  )
}
