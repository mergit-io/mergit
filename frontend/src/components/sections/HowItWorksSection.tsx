import { motion } from 'framer-motion'

const EASE = [0.22, 1, 0.36, 1] as const

const STEPS = [
  {
    number: '01',
    title: 'Submit a Goal',
    body: 'Write a plain-English task — "Create a PR that adds rate limiting to the API gateway."',
  },
  {
    number: '02',
    title: 'Agents Execute',
    body: 'LangGraph plans a DAG of specialist tasks. Researcher, Coder, Writer, and Integrator agents work in parallel.',
  },
  {
    number: '03',
    title: 'You Approve',
    body: 'Before any PR is merged, you review a diff summary and approve or revise. Agents pause and wait.',
  },
  {
    number: '04',
    title: 'Proof On-Chain',
    body: 'On completion, a Merkle bundle of task hashes is submitted to ProofOfWork.sol on Monad. Tamper-proof forever.',
  },
]

export default function HowItWorksSection() {
  return (
    <section className="relative py-28 px-6 overflow-hidden">
      {/* Background video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0 }}
      >
        <source src="/videos/howitworks-bg.webm" type="video/webm" />
        <source src="/videos/howitworks-bg.mp4" type="video/mp4" />
      </video>

      {/* Overlay */}
      <div
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background: 'linear-gradient(to bottom, rgba(10,8,18,0.78) 0%, rgba(10,8,18,0.85) 100%)',
        }}
      />

      <div className="relative section-container" style={{ zIndex: 2 }}>
        {/* Heading */}
        <motion.div
          className="mb-16"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <p className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-text-sec mb-4">
            How it works
          </p>
          <h2
            className="font-black text-text-pri max-w-lg"
            style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)', lineHeight: 1.1, letterSpacing: '-0.015em' }}
          >
            From task to tamper-proof proof in four steps
          </h2>
        </motion.div>

        {/* Steps */}
        <div className="grid md:grid-cols-4 gap-8 relative">
          {/* Connecting line (desktop only) */}
          <div className="hidden md:block absolute top-7 left-0 right-0 h-px bg-border-dim" style={{ zIndex: 0 }} />

          {STEPS.map((step, i) => (
            <motion.div
              key={step.number}
              className="relative flex flex-col gap-4"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.6, ease: EASE, delay: i * 0.12 }}
            >
              {/* Step number bubble */}
              <div className="relative z-10 flex items-center justify-center w-14 h-14 rounded-full border border-border-dim bg-bg-base">
                <span className="font-mono text-sm text-text-sec">{step.number}</span>
              </div>

              <h3 className="font-bold text-text-pri text-lg">
                {step.title}
              </h3>
              <p className="text-sm text-text-sec leading-[1.6]">
                {step.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>{/* /section-container */}
    </section>
  )
}
