import { useScrollPosition } from '../../hooks/useScrollPosition'
import { cn } from '../../utils/cn'

const NAV_LINKS = ['Platform', 'Agents', 'Docs', 'Blog']

export default function Navbar() {
  const scrollY = useScrollPosition()
  const scrolled = scrollY > 80

  return (
    <nav
      className={cn(
        'fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 transition-all duration-300',
        'h-[var(--nav-height)]',
        scrolled
          ? 'bg-[rgba(10,8,18,0.88)] backdrop-blur-xl border-b border-border-dim'
          : 'bg-transparent'
      )}
    >
      {/* Logo */}
      <a
        href="/"
        className="font-bold text-[1.125rem] tracking-[0.1em] text-text-pri uppercase select-none"
        style={{ letterSpacing: '0.12em' }}
      >
        MERGIT
      </a>

      {/* Nav links */}
      <div className="hidden md:flex items-center gap-8">
        {NAV_LINKS.map((link) => (
          <a
            key={link}
            href="#"
            className="text-[0.8rem] font-medium tracking-[0.12em] uppercase text-text-sec hover:text-text-pri transition-colors duration-150"
          >
            {link}
          </a>
        ))}
      </div>

      {/* CTA */}
      <a
        href="#"
        className={cn(
          'hidden md:inline-flex items-center text-cyan-accent border border-[rgba(110,231,255,0.35)]',
          'text-[0.8rem] font-bold tracking-[0.1em] uppercase px-5 py-2 rounded transition-all duration-200',
          'hover:border-[rgba(110,231,255,0.7)] hover:shadow-[0_0_12px_rgba(110,231,255,0.15)]'
        )}
      >
        Launch App
      </a>
    </nav>
  )
}
