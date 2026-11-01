import type { ReactNode } from "react";

/**
 * The sign-in illustration: one 12 s story on a loop. The person taps their phone, a coin goes into escrow on
 * the big phone, four agents take the task in turn (planner, coder, tester, reviewer), a receipt appears, and the
 * coin is released. All motion is CSS (see signin.css) and stops under `prefers-reduced-motion`. Colours are
 * fixed because the card behind it is white in both themes.
 */
const AGENTS: { x: number; y: number; color: string; wash: string; label: string; glyph: ReactNode; delay: number }[] =
  [
    {
      x: 290,
      y: 66,
      color: "#2457d6",
      wash: "#e5eeff",
      label: "Planner",
      delay: 2.2,
      glyph: <path d="M-8 -6H8M-8 0H3M-8 6H8" />,
    },
    {
      x: 290,
      y: 136,
      color: "#5b45d6",
      wash: "#ece8ff",
      label: "Coder",
      delay: 3.8,
      glyph: <path d="M-5 -7-12 0l7 7M5 -7l7 7-7 7M2 -9-2 9" />,
    },
    {
      x: 290,
      y: 206,
      color: "#946500",
      wash: "#fff1cf",
      label: "Tester",
      delay: 5.4,
      glyph: <path d="M-8 1l5 5 10-11" />,
    },
    {
      x: 290,
      y: 276,
      color: "#c23a5e",
      wash: "#ffe6ec",
      label: "Reviewer",
      delay: 7,
      glyph: (
        <>
          <path d="M-11 0Q0 -10 11 0Q0 10 -11 0z" />
          <circle r="3" />
        </>
      ),
    },
  ];

/** The Ethereum logo: five facets in the logo's own greys, drawn in its 256 x 417 box and centred on 0,0. */
function Eth({ height }: { height: number }) {
  return (
    <g transform={`scale(${String(height / 417)}) translate(-128 -208.5)`}>
      <path d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" fill="#343434" />
      <path d="M127.962 0L0 212.32l127.962 75.639V154.158z" fill="#8C8C8C" />
      <path d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.601L256 236.587z" fill="#3C3C3B" />
      <path d="M127.962 416.905v-104.72L0 236.585z" fill="#8C8C8C" />
      <path d="M127.961 287.958l127.96-75.637-127.96-58.162z" fill="#141414" />
      <path d="M0 212.32l127.96 75.638v-133.8z" fill="#393939" />
    </g>
  );
}

function Coin({ r }: { r: number }) {
  return (
    <>
      <circle r={r} fill="url(#si-gold)" />
      <circle r={r - 3.5} fill="none" stroke="#e59a00" strokeWidth="1.4" opacity="0.8" />
      <Eth height={r * 1.15} />
    </>
  );
}

export function SignInArt() {
  return (
    <svg
      className="si-art"
      viewBox="0 0 560 360"
      role="img"
      aria-label="A person pays into escrow from a phone, four agents (planner, coder, tester, reviewer) do the work, and a verified receipt appears"
    >
      <defs>
        <linearGradient id="si-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd34d" />
          <stop offset="1" stopColor="#f6a800" />
        </linearGradient>
      </defs>

      <ellipse cx="80" cy="332" rx="70" ry="9" fill="#e7ecfb" />
      <ellipse cx="274" cy="350" rx="150" ry="5" fill="#eef1f8" />

      {/* links */}
      <g className="si-art-link">
        <path d="M150 176C205 176 215 66 269 66" />
        <path d="M290 87V115M290 157V185M290 227V255" />
        <path d="M311 276C355 276 365 250 400 250" />
      </g>

      {/* big phone */}
      <g transform="translate(400 24)">
        <rect width="148" height="320" rx="26" fill="#eef3ff" stroke="#2a3ea3" strokeWidth="6" />
        <rect x="48" y="9" width="52" height="9" rx="4.5" fill="#2a3ea3" />
        <g transform="translate(74 82)">
          <Coin r={34} />
        </g>
        <g transform="translate(74 140)">
          <rect x="-34" y="-10" width="68" height="20" rx="10" fill="#fff" stroke="#c9d6f5" />
          <path
            d="M-18 -2v-2.5a4 4 0 0 1 8 0V-2M-20 -2h12v8h-12z"
            fill="none"
            stroke="#2a3ea3"
            strokeWidth="1.6"
            transform="translate(4 0)"
          />
          <text x="2" y="4" className="si-art-pill">
            ESCROW
          </text>
        </g>
        <g transform="translate(14 172)">
          <g className="si-art-receipt">
            <rect width="120" height="82" rx="14" fill="#fff" stroke="#c9d6f5" strokeWidth="1.5" />
            <circle cx="24" cy="24" r="11" fill="#e3f6ef" />
            <path
              d="M18 24l4 4 8-9"
              fill="none"
              stroke="#0e9f74"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x="42" y="22" className="si-art-title">
              PR #134
            </text>
            <text x="42" y="36" className="si-art-mono">
              fix auth flow
            </text>
            <rect x="14" y="52" width="92" height="16" rx="8" fill="#eef3ff" />
            <text x="60" y="63.5" className="si-art-mono" textAnchor="middle">
              0x30af…1c77
            </text>
          </g>
        </g>
        <g transform="translate(74 290)">
          <g className="si-art-settled">
            <rect x="-44" y="-12" width="88" height="24" rx="12" fill="#e3f6ef" />
            <text y="4.5" className="si-art-ok" textAnchor="middle">
              ✓ SETTLED
            </text>
          </g>
        </g>
      </g>

      {/* the person */}
      <image href="/brand/signin-man.png" x="8" y="60" width="144" height="268" />
      <ellipse cx="48" cy="327" rx="15" ry="5" fill="#fff" stroke="#cfd5e3" />
      <ellipse cx="82" cy="327" rx="15" ry="5" fill="#fff" stroke="#cfd5e3" />
      <circle cx="150" cy="176" r="9" className="si-art-tap" />

      {/* agents */}
      {AGENTS.map((a) => (
        <g key={a.label} transform={`translate(${String(a.x)} ${String(a.y)})`}>
          <circle r="21" fill={a.wash} stroke={a.color} strokeWidth="1.6" />
          <g fill="none" stroke={a.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {a.glyph}
          </g>
          <g className="si-art-on" style={{ animationDelay: `${String(a.delay)}s` }}>
            <circle r="26" fill="none" stroke={a.color} strokeWidth="2.2" opacity="0.5" />
            <circle r="21" fill={a.color} />
            <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              {a.glyph}
            </g>
          </g>
          <text y="39" className="si-art-label" textAnchor="middle">
            {a.label}
          </text>
        </g>
      ))}

      {/* coin stack and a coin that bobs */}
      <g transform="translate(352 334)">
        {[0, 1, 2, 3].map((i) => (
          <g key={i} transform={`translate(0 ${String(-i * 6)})`}>
            <ellipse rx="24" ry="7" cy="5" fill="#d58a00" />
            <ellipse rx="24" ry="7" fill="url(#si-gold)" stroke="#e59a00" strokeWidth="1" />
          </g>
        ))}
        <g transform="translate(0 -24)">
          <g className="si-art-topcoin">
            <ellipse rx="24" ry="7" fill="url(#si-gold)" stroke="#e59a00" strokeWidth="1" />
          </g>
        </g>
      </g>
      <g transform="translate(52 40)">
        <g className="si-art-bob">
          <Coin r={22} />
        </g>
      </g>

      {/* the transaction: a coin goes in, a coin comes out */}
      <g className="si-art-fly si-art-in">
        <Coin r={12} />
      </g>
      <g className="si-art-fly si-art-out">
        <Coin r={12} />
      </g>
    </svg>
  );
}
