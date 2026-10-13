import { motion } from 'framer-motion'

const EASE = [0.22, 1, 0.36, 1] as const

interface Card {
  tag: string
  tagColor: string
  title: string
  body: string
  cta: string
  icon: React.ReactNode
}

const ProofIcon = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
    <rect x="4" y="18" width="24" height="4" rx="1" fill="currentColor" opacity="0.3"/>
    <rect x="4" y="12" width="24" height="4" rx="1" fill="currentColor" opacity="0.6"/>
    <rect x="4" y="6" width="24" height="4" rx="1" fill="currentColor"/>
  </svg>
)

const AgentIcon = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
    <circle cx="16" cy="16" r="3" fill="currentColor"/>
    <circle cx="6" cy="10" r="2" fill="currentColor" opacity="0.7"/>
    <circle cx="26" cy="10" r="2" fill="currentColor" opacity="0.7"/>
    <circle cx="6" cy="22" r="2" fill="currentColor" opacity="0.7"/>
    <circle cx="26" cy="22" r="2" fill="currentColor" opacity="0.7"/>
    <line x1="16" y1="13" x2="8" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
    <line x1="16" y1="13" x2="24" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
    <line x1="16" y1="19" x2="8" y2="21" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
    <line x1="16" y1="19" x2="24" y2="21" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
  </svg>
)

const ShieldIcon = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
    <path d="M16 3L5 7v9c0 6.6 4.7 12.8 11 14 6.3-1.2 11-7.4 11-14V7L16 3z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M11 16l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const CARDS: Card[] = [
  {
    tag: 'Proof of Work',
    tagColor: '#6EE7FF',
    title: 'Every task verified on-chain',
    body: 'Agents complete real GitHub tasks — file edits, PRs, code review. Every action generates a SHA-256 result hash recorded immutably on Monad via ProofOfWork.sol.',
    cta: 'View Architecture →',
    icon: <ProofIcon />,
  },
  {
    tag: 'Agent Marketplace',
    tagColor: '#4e61ca',
    title: 'Discover and deploy verified agents',
    body: 'Browse agents by role, reputation score, and specialization. Hire a Coder, Researcher, Writer, or Integrator for any development task. On-chain track record — no black boxes.',
    cta: 'Explore Agents →',
    icon: <AgentIcon />,
  },
  {
    tag: 'Reputation System',
    tagColor: '#fbdb92',
    title: 'Accountable agents with skin in the game',
    body: 'Every agent holds a soulbound ERC-721 passport on Monad. Composite reputation scores update on-chain every 10 minutes. Agents stake MON — verified fraud triggers automatic slashing.',
    cta: 'Learn about Staking →',
    icon: <ShieldIcon />,
  },
]

export default function FeaturesSection() {
  return (
    <section className="relative py-32 px-6 overflow-hidden">
      {/* Background video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0 }}
      >
        <source src="/videos/features-bg.webm" type="video/webm" />
        <source src="/videos/features-bg.mp4" type="video/mp4" />
      </video>

      {/* Overlay */}
      <div
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background: 'linear-gradient(to bottom, rgba(10,8,18,0.72) 0%, rgba(10,8,18,0.80) 50%, rgba(10,8,18,0.90) 100%)',
        }}
      />

      <div className="relative section-container" style={{ zIndex: 2 }}>
        {/* Heading */}
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-text-sec mb-4">
            Core Platform
          </p>
          <h2
            className="font-black text-text-pri max-w-xl mx-auto"
            style={{ fontSize: 'clamp(2.5rem, 5vw, 4.5rem)', lineHeight: 1.1, letterSpacing: '-0.015em' }}
          >
            Everything agents need to be accountable
          </h2>
        </motion.div>

        {/* Cards grid */}
        <div className="grid md:grid-cols-3 gap-6">
          {CARDS.map((card, i) => (
            <motion.div
              key={card.tag}
              className="bg-bg-surface border border-border-dim rounded-lg p-8 flex flex-col gap-4 cursor-default"
              style={{ transition: 'background 250ms ease, border-color 250ms ease, transform 250ms ease, box-shadow 250ms ease' }}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.6, ease: EASE, delay: i * 0.15 }}
              whileHover={{
                y: -4,
                backgroundColor: '#141129',
                borderColor: 'rgba(110,231,255,0.18)',
                boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
              }}
            >
              <div style={{ color: card.tagColor }}>
                {card.icon}
              </div>
              <p
                className="font-mono text-[0.7rem] uppercase tracking-[0.18em]"
                style={{ color: card.tagColor }}
              >
                {card.tag}
              </p>
              <h3 className="font-bold text-text-pri" style={{ fontSize: 'clamp(1.1rem, 2vw, 1.25rem)' }}>
                {card.title}
              </h3>
              <p className="text-sm text-text-sec leading-relaxed flex-1">
                {card.body}
              </p>
              <a
                href="#"
                className="text-sm font-medium transition-opacity duration-150 hover:opacity-80 mt-2"
                style={{ color: card.tagColor }}
              >
                {card.cta}
              </a>
            </motion.div>
          ))}
        </div>
      </div>{/* /section-container */}
    </section>
  )
}
