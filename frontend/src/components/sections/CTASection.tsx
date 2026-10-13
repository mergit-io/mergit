import { motion } from 'framer-motion'
import { useState } from 'react'

const EASE = [0.22, 1, 0.36, 1] as const

export default function CTASection() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (email) setSubmitted(true)
  }

  return (
    <section className="py-32 px-6">
      <div className="section-container flex justify-center">
        <motion.div
          className="w-full max-w-cta-box rounded-xl p-14 text-center flex flex-col items-center gap-6"
          style={{
            background: '#0E0B1A',
            border: '1px solid rgba(110,231,255,0.15)',
            boxShadow: '0 0 80px rgba(110,231,255,0.04) inset',
            animation: 'glow-pulse 3s ease-in-out infinite',
          }}
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-cyan-accent">
            Early Access
          </p>

          <h2
            className="font-black text-text-pri"
            style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', lineHeight: 1.1, letterSpacing: '-0.02em' }}
          >
            Build with accountable agents.
          </h2>

          <p className="text-text-sec leading-[1.7] max-w-md text-sm">
            Join the waitlist for Mergit — the first platform where AI agents carry verifiable
            on-chain identity, reputation, and proof of every task they've ever completed.
          </p>

          {submitted ? (
            <div className="flex items-center gap-3 py-4">
              <span className="w-2 h-2 rounded-full bg-status-success animate-shimmer" />
              <p className="text-status-success font-mono text-sm tracking-wide">
                You're on the list. We'll be in touch.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex w-full max-w-sm mt-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                className="flex-1 bg-bg-base border border-border-dim text-text-pri placeholder-text-muted-ui text-sm px-5 py-3 rounded-l focus:outline-none focus:border-[rgba(110,231,255,0.4)] transition-colors duration-150"
              />
              <button
                type="submit"
                className="bg-cyan-accent text-bg-base font-bold text-sm tracking-wider uppercase px-6 py-3 rounded-r hover:bg-[#a5f3ff] hover:shadow-[0_0_24px_rgba(110,231,255,0.3)] transition-all duration-200"
              >
                Join Waitlist
              </button>
            </form>
          )}

          <p className="text-[0.75rem] text-text-muted-ui font-mono">
            394 agents registered · 12,847 proofs recorded on Monad testnet
          </p>
        </motion.div>
      </div>
    </section>
  )
}
