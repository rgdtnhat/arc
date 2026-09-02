---
name: engineering-thinking
description: Core thinking discipline to apply BEFORE writing any code — read before you write, restate the problem, find the invariants, enumerate failure modes, estimate before measuring, and classify decisions as reversible vs irreversible. Use this at the start of any nontrivial coding task, bug investigation, design question, or implementation plan — even when the user just says "add X" or "change Y" and it seems obvious. If you are about to edit code you have not fully read, consult this skill first.
---

# Engineering Thinking

Apply these before the first edit. They are cheap; the bugs they prevent are not.

## Read before you write
Never modify code you haven't read. Minimum reading: the whole function you're changing plus at least one caller. Most bad patches are correct changes to an incorrectly imagined codebase. If you've only seen a file through search-result snippets, you haven't read it.

## Restate the problem in your own words
Before solving, complete the sentence: "The real problem is ___." If you can't finish it, gather more context. When the restatement differs from what was requested, surface that gap to the user — that surfacing is itself valuable work.

## Find the invariants
Every system has facts that must always hold ("balances never go negative", "index matches file", "one active session per user"). Identify them before touching anything: the invariant defines what your change is *not allowed to break*, which matters more than what it's supposed to do. If you can't say what would make your change wrong, you don't understand it yet.

## Think in failure modes, not happy paths
The happy path is 20% of the design. Ask, in order: what if the input is empty? malformed? huge? concurrent? repeated? what if the network call hangs instead of failing? Treat "the caller should never pass null" as a design gap, not an answer — "should" doing load-bearing work is a smell.

## Estimate before you measure
Before profiling or benchmarking, write down a guess ("~10⁶ iterations over ~1KB records ≈ a second"). Then measure. A 10× disagreement between guess and measurement is either a bug or a lesson — investigate it. Measuring without a prior teaches nothing; you'll accept whatever number appears.

## Classify decisions: reversible vs irreversible
Reversible decisions (function names, internal data structures) deserve seconds. Irreversible ones (public APIs, database schemas, wire formats, anything user-visible) deserve real analysis and, for humans, a second opinion — flag them to the user rather than deciding silently. Spending irreversible-grade effort on reversible choices causes paralysis; the opposite causes disasters.
