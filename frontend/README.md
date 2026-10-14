# Mergit frontend

The Mergit dashboard, built from the approved Figma designs:
[Porcelain, light](https://www.figma.com/design/neI67DQPihvv95wNsatkmW) and
[Porcelain Night, dark](https://www.figma.com/design/yV9dTpC723weK7Dyqx2YYg).

Vite, React 19, TypeScript and React Router. No backend yet: every screen reads from
`src/mock/data.ts`, and no number on it is measured.

## Run it

Node 22.12 or newer.

```sh
npm install
npm run dev           # http://localhost:5173
npm run build         # type-check and production build
npm run lint          # ESLint: strict type-checked rules, React hooks, accessibility
npm run format:check  # Prettier
npm run test:e2e      # Playwright; add PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome
```

CI runs all of these on every pull request that touches `frontend/`.

## Layout

| Folder                                |                                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
| `src/screens`                         | One file per screen; the run workspace is split into `screens/run`    |
| `src/components`                      | Shared UI: buttons, badges, segmented control, nav, theme toggle      |
| `src/hooks`, `src/lib`                | Small hooks and helpers                                               |
| `src/theme`, `src/toast`, `src/state` | Theme switching, toasts, and approvals shared by the nav and Overview |
| `src/mock/data.ts`                    | Every number and string the screens show                              |
| `src/styles`                          | Tokens, base and component styles, one stylesheet per screen          |
| `e2e`                                 | Playwright tests                                                      |

Controls whose action needs a backend (Fund wallet, Create agent and so on) say so in a toast
instead of doing nothing.

## Screens

| Route           | Screen                                 |
| --------------- | -------------------------------------- |
| `/`             | Overview                               |
| `/runs/:id`     | Run workspace, task graph and live log |
| `/runs/new`     | New run                                |
| `/agents`       | Agents                                 |
| `/proofs/:id`   | Work proof                             |
| `/leaderboard`  | Leaderboard                            |
| `/integrations` | Integrations                           |
| `/wallet`       | Wallet and identity                    |
| `/signin`       | Sign in                                |

## Light and dark

- Both palettes live in `src/styles/tokens.css` as CSS variables under `data-theme` on `<html>`.
  Components only use tokens, so a theme switch is one attribute change.
- The first visit follows the OS. Choosing a theme saves it; choosing the one the OS already uses
  clears the saved choice, so the app follows the OS again.
- An inline script in `index.html` sets the theme before first paint, so there is no flash.
- Open tabs stay in sync through the `storage` event, and the app follows OS changes live
  while no choice is saved.
- The toggle reveals the new theme in a circle from the button (View Transitions API). Browsers
  without it, and theme changes from another tab or the OS, cross-fade instead.
  `prefers-reduced-motion` switches instantly.

## Copy

The designs predate the current paper, so a few labels differ on purpose: Monad testnet and MON
became an unnamed L2 testnet and ETH, the contracts are Identity, ReceiptRegistry and
ReputationAnchor, and reputation reads as value density.
