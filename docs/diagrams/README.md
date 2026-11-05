# Mergit diagrams

The `.excalidraw` files here are the editable source of every diagram in the [HLD](../HLD.md). Edit
these, not the PNGs. The PNGs in `preview/` are approximate renders (a plain fallback font, no Excalidraw
styling) so the diagrams can be seen on GitHub, which does not render `.excalidraw` files. Re-export from
Excalidraw when you want the real look.

| # | Diagram | What it answers |
|---|---|---|
| 00 | `00-system-overview` | Every layer on one page, and where trust changes |
| 01 | `01-request-flow` | How one goal becomes a validated pull request (steps 1 to 11) |
| 02 | `02-llm-orchestration-and-agent-loop` | Where the LLMs sit; planner, router and the agent's loop |
| 03 | `03-attested-runtime` | What is inside one enclave and how a receipt is sealed |
| 04 | `04-trust-boundaries-and-keys` | The five trust zones, keys K1 to K7, the attestation chain |
| 05 | `05-receipt-and-disclosure` | Receipt anatomy, Merkle commitment, the three disclosure tiers |
| 06 | `06-blockchain-layer` | The six contracts, who calls them, chain gateway and indexer |
| 07 | `07-payment-and-money-flow` | Payment gateway, escrow, release and refund, clawback order, faucet tier |
| 08 | `08-task-lifecycle-and-failures` | Task state machine and what each failure does |
| 09 | `09-verification-and-challenge` | Audit draw, validator checks, bonded challenge, adjudication, deterrence rule |
| 10 | `10-reputation-and-routing` | Posteriors, value density, Thompson sampling, exploration subsidy |
| 11 | `11-delivery-units-and-repos` | Phases P0 to P5, the orchestration track OP1 to OP4, deployable units, repositories, environments |
| 12 | `12-ens-naming-layer` | Where the ENS layer sits: Base Sepolia, Mergit services, Ethereum mainnet ENSv2 ([ENS HLD](../HLD-ens-integration.md)) |
| 13 | `13-ens-agent-registration-and-verification` | Register an agent, the two-way ENS link, the reputation mirror write |
| 14 | `14-ens-build-plan-and-environments` | Build stages, cost model, open blockers, the separate Certora track |

## Edit

- Open <https://excalidraw.com> and drag a `.excalidraw` file onto the canvas, or use Menu, Open.
- Or install the VS Code extension "Excalidraw" and open the file directly. It saves back in place.
- Arrows are bound to their boxes, so moving a box moves its arrows. Box labels are bound text: double-click a
  box to rename it. Loose labels near arrows are separate text and move on their own.

## Save and export

- Menu, Save to disk keeps the editable `.excalidraw` file. Commit this one.
- Menu, Export image, then SVG or PNG. Tick **Embed scene** so the exported image can be dragged back into
  Excalidraw and edited again. Name exports `<same-name>.svg` or `.png` next to the source.

## Colour key

requester or operator purple, entry blue, control plane yellow, execution (trusted) green, evidence and
storage cyan, chain and contracts orange, money pink, reputation violet, human or external grey.
Solid arrow = request path. Dashed = attestation, commitments, feedback, approval. A numbered red circle is a
step. Tags: **OPEN** = undecided (HLD section 11), **PROPOSED** = recommended but not locked,
**EVIDENCE** = a step the predicate depends on.

## Rules

- Only the Validator can mark a task done. Do not draw an arrow that lets an agent do so.
- A diagram holds commitments, amounts and verdicts on chain, never task content.
- Where a diagram and the paper disagree, the paper wins and the diagram is the defect.
- Nothing in a diagram is a measurement. Numbers are illustrations or model arithmetic and are labelled so.
- A step in a diagram that the paper does not require goes in as PROPOSED, not as fact.
