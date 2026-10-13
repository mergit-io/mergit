import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'bg-base':        '#0A0812',
        'bg-surface':     '#0E0B1A',
        'bg-elevated':    '#141129',
        'border-dim':     '#1C1933',
        'border-mid':     '#3A3A55',
        'cyan-accent':    '#6EE7FF',
        'electric':       '#4e61ca',
        'gold':           '#fbdb92',
        'text-pri':       '#F0F0F8',
        'text-sec':       '#8B8FA8',
        'text-muted-ui':  '#3A3A55',
        'status-success': '#22d3a0',
        'status-pending': '#fbdb92',
        'status-error':   '#f87171',
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      keyframes: {
        'fade-up': {
          '0%':   { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 12px rgba(110,231,255,0.08)' },
          '50%':      { boxShadow: '0 0 32px rgba(110,231,255,0.18)' },
        },
        'shimmer': {
          '0%':   { opacity: '0.4' },
          '50%':  { opacity: '0.9' },
          '100%': { opacity: '0.4' },
        },
      },
      animation: {
        'fade-up':    'fade-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'fade-in':    'fade-in 0.5s ease forwards',
        'glow-pulse': 'glow-pulse 3s ease-in-out infinite',
        'shimmer':    'shimmer 2s ease-in-out infinite',
      },
      spacing: {
        'nav': '72px',
      },
      maxWidth: {
        'content':   '1200px',
        'hero-text': '860px',
        'body-text': '620px',
        'cta-box':   '700px',
      },
      transitionTimingFunction: {
        'expo-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}

export default config
