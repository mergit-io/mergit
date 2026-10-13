export interface NavLink {
  label: string
  href: string
}

export interface FeatureCard {
  tag: string
  tagColor: string
  title: string
  body: string
  cta: string
  ctaColor: string
  icon: React.ReactNode
}

export interface Step {
  number: string
  title: string
  body: string
}

export interface Stat {
  value: number
  label: string
  suffix?: string
  prefix?: string
}
