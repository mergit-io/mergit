import { useId, type ReactNode } from "react";
import { prefersReducedMotion } from "../lib/motion";

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

/** The USDC mark: a white ring and a dollar sign, drawn as paths so the labels' text rule (hidden on phones) never removes it. */
function Usdc({ r }: { r: number }) {
  return (
    <g transform={`scale(${String(r / 24)})`} fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
      <circle r="17" strokeWidth="1.6" opacity="0.9" />
      <path d="M-5.5 -6C-5.5 -11 5.5 -11 5.5 -5C5.5 0 -5.5 -1 -5.5 5C-5.5 11 5.5 11 5.5 6" strokeWidth="2.6" />
      <path d="M0 -13V13" strokeWidth="2.2" />
    </g>
  );
}

function Coin({ r, coinFill }: { r: number; coinFill: string }) {
  return (
    <>
      <circle r={r} fill={`url(#${coinFill})`} />
      <circle r={r - 3.5} fill="none" stroke="#fff" strokeWidth="0" opacity="0" />
      <Usdc r={r} />
    </>
  );
}

/** One coin on a path: visible for the first 18% of the 12 s loop from `begin`, hidden the rest. */
function FlyingCoin({ coinFill, path, begin }: { coinFill: string; path: string; begin: string }) {
  return (
    <g opacity="0">
      <Coin r={12} coinFill={coinFill} />
      <animateMotion
        path={path}
        dur="12s"
        begin={begin}
        repeatCount="indefinite"
        keyPoints="0;1;1"
        keyTimes="0;0.18;1"
        calcMode="linear"
      />
      <animate
        attributeName="opacity"
        values="1;1;0;0"
        keyTimes="0;0.18;0.19;1"
        dur="12s"
        begin={begin}
        repeatCount="indefinite"
      />
    </g>
  );
}

export function SignInArt() {
  // Unique per instance, so two of these on a page never share (and collide on) one gradient.
  const coinFill = `si-coinFill-${useId().replace(/:/g, "")}`;
  const still = prefersReducedMotion();
  return (
    <svg
      className="si-art"
      viewBox="0 0 560 360"
      role="img"
      aria-label="Illustration: a payment goes into escrow, four agents do the task in turn, and a verified receipt appears"
    >
      <defs>
        <linearGradient id={coinFill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4c9bf0" />
          <stop offset="1" stopColor="#2775ca" />
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
          <Coin r={34} coinFill={coinFill} />
        </g>
        <g transform="translate(74 140)">
          <rect x="-48" y="-11" width="96" height="22" rx="11" fill="#fff" stroke="#c9d6f5" />
          <path
            d="M-18 -2v-2.5a4 4 0 0 1 8 0V-2M-20 -2h12v8h-12z"
            fill="none"
            stroke="#2a3ea3"
            strokeWidth="1.6"
            transform="translate(-16 0)"
          />
          <text x="-18" y="4" className="si-art-pill">
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
              Your task
            </text>
            <text x="42" y="36" className="si-art-mono">
              plan approved
            </text>
            <rect x="14" y="52" width="92" height="16" rx="8" fill="#eef3ff" />
            <text x="60" y="63.5" className="si-art-mono" textAnchor="middle">
              0x…
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
            <ellipse rx="24" ry="7" cy="5" fill="#1d5fa8" />
            <ellipse rx="24" ry="7" fill={`url(#${coinFill})`} stroke="#1d5fa8" strokeWidth="1" />
          </g>
        ))}
        <g transform="translate(0 -24)">
          <g className="si-art-topcoin">
            <ellipse rx="24" ry="7" fill={`url(#${coinFill})`} stroke="#1d5fa8" strokeWidth="1" />
          </g>
        </g>
      </g>
      <g transform="translate(52 40)">
        <g className="si-art-bob">
          <Coin r={22} coinFill={coinFill} />
        </g>
      </g>

      {/* the transaction: a coin goes in, a coin comes out. SMIL, not CSS motion paths, which are uneven on SVG. */}
      {!still && (
        <>
          <FlyingCoin coinFill={coinFill} path="M150 176C200 10 380 10 474 106" begin="0.4s" />
          <FlyingCoin coinFill={coinFill} path="M474 150C440 230 390 290 356 312" begin="10s" />
        </>
      )}
    </svg>
  );
}
