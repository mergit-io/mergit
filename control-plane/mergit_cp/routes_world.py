"""World ID (plan `docs/superpowers/plans/2026-11-05-world-human-checkpoints.md`): IDKit proof-of-human for
the free trial and Agent Pass OIDC human-approval checkpoints before a plan is approved or a PR is opened.

Empty for now — this PR only lands the shared settings, schema and this router so the two halves (IDKit,
Agent Pass) can be built against it in parallel without touching the same files. Routes land in later PRs
(plan sec 1.7); until then this is included with no routes, same as before this PR.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/v0/world", tags=["world"])
