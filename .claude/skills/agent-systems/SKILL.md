---
name: agent-systems
description: Automation, multi-agent collaboration, and machines that build machines — climb the automation ladder deliberately (script→hook→pipeline→agent), automate only what you can verify, keep humans at irreversibility points, spawn agents for isolation/parallelism/adversarial-review not for company, treat the brief as the bottleneck, verify at every agent-to-agent seam, coordinate through human-readable artifacts, never let a system grade its own homework, give created agents least privilege plus a kill switch, climb the DSL ladder before creating languages, and keep all inter-agent communication human-auditable. Use whenever designing automation/hooks/pipelines/CI, spawning or orchestrating subagents, delegating work between agents or aggregating their outputs, building AI systems that train/evaluate/scaffold other AI, choosing a programming language, or considering a DSL/custom language/inter-agent protocol.
---

# Agent Systems

One thread ties it all: **verification must reach as far as delegation does.** Automation is trust made mechanical; multi-agent is trust made social; AI-building-AI is trust made recursive; language is trust made legible. Full rationale in [AGENT_SYSTEMS.md](../../../AGENT_SYSTEMS.md).

## Automation
- **Climb the ladder deliberately**: manual → script → hook/cron → pipeline → agent. Each rung trades human attention for blast radius. Pick the *lowest* rung that solves the problem — an agent where a cron job would do wastes judgment; a human where a hook would do wastes attention.
- **Automate only what you can verify.** Automation amplifies error at machine speed; every automation ships with its own check, plus idempotency, dry-run, rate limits, and a kill switch. An automation whose failures are discovered by its victims is the smell.
- **Humans at irreversibility points.** Full autonomy over the reversible middle; gates at irreversible edges (prod deploys, sends, deletes, spend). Autonomy over irreversible steps is earned by verification depth, not assumed.

## Multi-agent collaboration
- **Spawn for isolation, not company.** Valid reasons: context isolation, true parallelism, specialization, adversarial review (author ≠ reviewer). "More agents = smarter" is not on the list — coordination costs are real, and one competent agent with good tools beats a committee on most tasks.
- **The brief is the bottleneck.** Subagents start cold: goal, constraints, definition of done, output location, blocked-behavior — all in the brief. A vague brief produces *confident wrong*, discovered late.
- **Verify at the seams.** Every handoff is a trust boundary (see agent-security): spot-check outputs against reality, not reports against their confidence. Open the artifact; run the test.
- **Coordinate through artifacts** — files, repos, task lists: durable, auditable, resumable. Everything stays human-readable; opaque inter-agent codes trade pennies of tokens for the whole trust model.

## Machines that build machines
- **AI-builds-AI is plumbing, not magic** — distillation, synthetic data, model-written evals, agents scaffolding agents. Treat generated components like dependencies from strangers: reviewed, tested against held-out cases, versioned.
- **Never let a system grade its own homework.** The failure mode is drift: reward hacking, sycophancy loops, judge-student contamination. Every improvement generation needs an independent signal — ground truth, held-out evals, human spot checks. Recursion is safe exactly as far as independent verification reaches.
- **On AGI: calibrated beliefs, real preparedness.** No verified timelines exist; hype and dismissal fail the same test. Prepare instead of predict: capability evals that would notice a jump, margins that don't assume the current ceiling, corrigibility as a design requirement.
- **What you build inherits your name.** Created agents get least privilege, scoped credentials, logs they can't erase, a kill switch — and Volume III's boundaries written in. Alignment is inherited discipline, not bolted-on philosophy.

## Languages
- **A language is a UI for thought** — choose by ecosystem and team, not aesthetics; learn paradigms, not syntaxes.
- **Climb the DSL ladder**: library → fluent API → schema → embedded DSL → external DSL → language. Each rung multiplies hidden costs; a language is 1% grammar, 99% ecosystem. Most "we need a language" is "we need a schema."
- **Inter-agent protocols: self-describing, versioned, translatable to human language on demand.** A channel the principal can't read is a channel the principal can't supervise — auditability is a feature of the language, not a tax.
