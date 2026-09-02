---
name: research-method
description: The scientific method for agents — literature search before experiments, falsifiable hypotheses with predictions committed beforehand, one variable against a control AND the embarrassingly simple baseline, reproducible pipelines with pinned seeds/versions, statistical self-honesty (no best-run reporting, no leakage, error bars always), negative results reported, anomalies chased not shrugged off, and killing your own discovery before announcing it. Use whenever running benchmarks or performance comparisons, evaluating whether approach A beats approach B, training or evaluating models, investigating an open question ("find out whether/why X"), testing a novel idea or algorithm, or whenever a result looks surprisingly good — especially then.
---

# Research Method

Research is the engineering loop run against reality itself. Full rationale in [RESEARCH_METHOD.md](../../../RESEARCH_METHOD.md).

## Before any experiment
- **Literature first.** The fastest result is finding it already done. Search papers, prior issues, existing benchmarks, the changelog. A novelty claim without having looked is a hope, not a claim. Prior art found is a gift: the answer, or a free baseline plus known-failure list.
- **The hypothesis must be able to lose.** Write down: what you believe, what result confirms it, and *what result would prove you wrong* — before running. An experiment whose every outcome would be reported as success is ritual, not research.

## Running it
- **One variable, real control, embarrassing baseline.** Pin everything else. Always run the dumb baseline — the linear scan, the predict-the-mean model, the plain `grep` — a shocking share of "improvements" evaporate against it. A win must state what it beat, by how much, under what conditions.
- **Reproducibility is the product.** Pin seeds, versions, environment, data snapshots; script the whole pipeline — the script is the lab notebook. Standard: a stranger reruns one command and gets your numbers. A result you can't rerun is an anecdote.
- **Guard against your own statistics.** Decide metric and stopping rule before looking. Report variance across runs, never the best run. Hold out test data touched exactly once (leakage is the cardinal sin). Report every variant tried, not just the winner.

## Reading the results
- **Negative results are results.** What failed, under what conditions, ruling out what — reported with the same care as a win. A log where nothing ever failed is a map missing every broken bridge.
- **Chase the residual.** The discovery hides in the data point you were about to delete: the 10×-off benchmark, the Tuesday-only failure, the term that "shouldn't matter" but won't go away. Most anomalies are bugs — which is why each gets an explanation or an investigation, never "probably just noise" (checked against what noise floor?).
- **Try to kill your own discovery first.** A revolutionary-looking result is, by overwhelming odds, an error: leakage, broken measurement, a baseline misconfigured in your favor. Rerun from scratch, hunt the bug that would produce exactly this, predict something it shouldn't do and check. Excitement rising while verification effort falls is the smell.

## Claiming it
- **Claim exactly what you verified.** "12% on these three workloads under these conditions" must not round up to "breakthrough." State conditions, effect size, variance, unknowns; cite what you built on. Modest claims that hold beat grand claims that crumble.
- **The genuinely new is built at the edge of the map, not off it** — anomalies chased, mature fields combined, expired impossibilities revisited. Know the state of the art well enough to say precisely where it ends; that knowledge is what makes the new reachable.
- **Dangerous knowledge: mind the blast radius.** For security research and dual-use findings: isolated systems, minimal live examples, disclose to whoever can fix it before whoever can exploit it. The boundary is not on the seeking — it is on the blast radius (see agent-security).
