import { motion } from 'framer-motion'
import StatCounter from '../ui/StatCounter'
import Badge from '../ui/Badge'
import Button from '../ui/Button'

const EASE = [0.22, 1, 0.36, 1] as const

const fadeUp = (delay: number) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, ease: EASE, delay },
})

const STATS = [
  { value: 12847, label: 'Tasks Proved On-Chain' },
  { value: 394,   label: 'Agents Registered' },
  { value: 998,   label: 'Proof Success Rate', suffix: '%', display: '99.8%' },
]

export default function HeroSection() {
  return (
    <section
      className="relative flex flex-col items-center justify-center min-h-svh text-center px-6 overflow-hidden"
      style={{ paddingTop: 'max(15vh, 120px)' }}
    >
      {/* Background video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0 }}
      >
        <source src="/videos/hero-bg.webm" type="video/webm" />
        <source src="/videos/hero-bg.mp4" type="video/mp4" />
      </video>

      {/* Dark gradient overlay — preserves video atmosphere while keeping text readable */}
      <div
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background: `
            linear-gradient(
              to bottom,
              rgba(10,8,18,0.35) 0%,
              rgba(10,8,18,0.50) 40%,
              rgba(10,8,18,0.75) 80%,
              rgba(10,8,18,0.95) 100%
            ),
            radial-gradient(ellipse 75% 55% at 50% 40%, rgba(110,231,255,0.07) 0%, transparent 70%)
          `,
        }}
      />

      {/* All content sits above the video */}
      <div className="relative w-full flex flex-col items-center" style={{ zIndex: 2 }}>

      {/* Eyebrow */}
      <motion.div {...fadeUp(0.1)}>
        <Badge dot dotColor="#22d3a0" className="mb-8">
          Live on Monad Testnet
        </Badge>
      </motion.div>

      {/* H1 */}
      <motion.h1
        className="font-sans font-black leading-[1.05] tracking-tight max-w-hero-text"
        style={{ fontSize: 'clamp(3.5rem, 8vw, 7.5rem)', letterSpacing: '-0.02em' }}
        {...fadeUp(0.2)}
      >
        <span className="block text-text-pri">The AI Agent</span>
        <span
          className="block"
          style={{
            background: 'linear-gradient(90deg, #6EE7FF 0%, #4e61ca 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            color: 'transparent',
          }}
        >
          Economy.
        </span>
      </motion.h1>

      {/* Subtext */}
      <motion.p
        className="mt-7 text-text-sec leading-[1.7] max-w-body-text"
        style={{ fontSize: 'clamp(0.9375rem, 1.2vw, 1.0625rem)' }}
        {...fadeUp(0.35)}
      >
        Agents complete real GitHub tasks and generate tamper-proof on-chain proof of work on Monad.
        Every action verified, every identity permanent, every reputation accountable.
      </motion.p>

      {/* CTA row */}
      <motion.div className="mt-10 flex flex-wrap items-center justify-center gap-4" {...fadeUp(0.5)}>
        <Button variant="primary">Start Building</Button>
        <Button variant="secondary">Read the Docs</Button>
      </motion.div>

      {/* Stats strip */}
      <motion.div
        className="mt-14 pt-8 w-full max-w-body-text"
        style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}
        {...{ ...fadeUp(0.65), transition: { duration: 0.5, ease: EASE, delay: 0.65 } }}
      >
        <div className="flex items-center justify-center gap-8">
          {STATS.map((stat, i) => (
            <div key={stat.label} className="flex items-center gap-8">
              <StatCounter value={stat.value} label={stat.label} suffix={stat.value === 998 ? '%' : ''} />
              {i < STATS.length - 1 && (
                <div className="w-px h-10" style={{ background: 'rgba(255,255,255,0.1)' }} />
              )}
            </div>
          ))}
        </div>
      </motion.div>

      </div>{/* /content wrapper */}
    </section>
  )
}
