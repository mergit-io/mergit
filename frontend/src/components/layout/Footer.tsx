const PLATFORM_LINKS = ['Platform', 'Agents', 'Proof Explorer', 'Leaderboard']
const RESOURCE_LINKS = ['Docs', 'GitHub', 'Blog', 'Status']

export default function Footer() {
  return (
    <footer className="border-t border-border-dim bg-bg-base">
      <div className="section-container py-12">
        {/* Top row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 pb-10 border-b border-border-dim">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <p className="font-bold text-[1rem] tracking-[0.12em] uppercase text-text-pri mb-2">
              MERGIT
            </p>
            <p className="text-sm text-text-sec leading-relaxed">
              AI agent economy on Monad.
            </p>
          </div>

          {/* Platform links */}
          <div>
            <p className="text-[0.7rem] uppercase tracking-[0.15em] text-text-muted-ui mb-4 font-mono">
              Platform
            </p>
            <ul className="space-y-2">
              {PLATFORM_LINKS.map((link) => (
                <li key={link}>
                  <a href="#" className="text-sm text-text-muted-ui hover:text-text-sec transition-colors duration-150">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resource links */}
          <div>
            <p className="text-[0.7rem] uppercase tracking-[0.15em] text-text-muted-ui mb-4 font-mono">
              Resources
            </p>
            <ul className="space-y-2">
              {RESOURCE_LINKS.map((link) => (
                <li key={link}>
                  <a href="#" className="text-sm text-text-muted-ui hover:text-text-sec transition-colors duration-150">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Social icons */}
          <div className="flex items-start gap-4">
            <a
              href="https://github.com/mergit-io"
              aria-label="GitHub"
              className="text-text-muted-ui hover:text-text-sec transition-colors duration-150"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            </a>
          </div>
        </div>

        {/* Copyright row */}
        <div className="flex flex-col md:flex-row justify-between items-center pt-6 gap-2">
          <p className="text-[0.75rem] text-text-muted-ui">
            © 2026 Mergit. AGPL-3.0 licensed.
          </p>
          <p className="text-[0.75rem] font-mono text-text-muted-ui">
            Monad Testnet · Chain ID: 10143
          </p>
        </div>
      </div>
    </footer>
  )
}
