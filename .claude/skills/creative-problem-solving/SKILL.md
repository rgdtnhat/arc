---
name: creative-problem-solving
description: Techniques for generating better solutions instead of settling for the first idea — the three-options rule, stealing patterns not code, inverting stuck problems, disposable prototypes, the boring-technology bias, and naming as a design test. Use whenever choosing between approaches or libraries, designing something new, feeling stuck on a problem, or when the first idea seems obviously right — especially then, because the first idea is merely the most available one.
---

# Creative Problem Solving

## Generate three options before choosing one
The first idea is rarely the best; it's just the most available. Name three genuinely different approaches — include one that feels too simple and one that feels too ambitious — before committing. The chosen design is usually a hybrid, and the rejected options become the answer to "did you consider…?". A plan with one option and a conclusion is a smell.

## Steal patterns, not code
When you find prior art (in this codebase or elsewhere), extract the *shape* of the solution — queue + worker, cache + invalidation, parse → validate → transform — and re-derive details for the current context. Copied code carries invisible assumptions from its original home; copied patterns don't. A pasted block with variable names from another domain is the tell.

## Invert the problem
Stuck on "how do I make X happen?" — flip it: "what would guarantee X never happens, and how do I remove those causes?" Can't design the ideal API? Sketch the worst one, then negate it. Inversion works because failure conditions are more enumerable than success conditions. Reach for it after an hour without progress on the forward question.

## Prototype to learn, then throw it away
A prototype answers exactly one question ("can the parser handle this grammar?", "is the latency acceptable?") as fast as possible, cutting every corner that doesn't affect the answer. Its value is the answer, not the artifact. Never promote a prototype to production — "we'll clean it up later" is how demos become decade-long liabilities.

## The boring solution is a feature
Given equal capability, choose the technology and pattern the next maintainer most likely already knows. Novelty carries a permanent tax: every clever mechanism must be re-understood by every reader forever. Spend the innovation budget on the one place the problem is genuinely novel; be aggressively conventional everywhere else. If the interesting part of a change is its infrastructure rather than its feature, rebalance.

## Name the concept before you build it
If you can't name a module or abstraction crisply, its boundary is wrong — a struggle to name is a design signal, not a vocabulary problem. `DataManagerHelper` means "three responsibilities in a trench coat"; split until the names come easily. Watch for `util`, `misc`, `common`, `helper2`.
