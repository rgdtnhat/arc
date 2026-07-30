---
name: context-efficiency
description: How to spend context, tool calls, and time like the scarce resources they are — treat the context window as RAM not a log, grep-then-read instead of reading whole files, never re-read what you have, batch all independent tool calls into one parallel block, start slow background jobs first, prefer dedicated tools over shell escape hatches, replace guesses with one cheap verification probe, and distill findings compactly as you go. Use during ANY codebase exploration, search, investigation, or multi-tool-call work — especially long sessions where the context is filling — and whenever about to state an API, config key, or library behavior from memory instead of checking the source.
---

# Context Efficiency

Context is the binding constraint on how long an agent stays smart. The agent that fills it with noise in hour one is a measurably worse agent in hour two. Full rationale in [AGENTIC_MASTERY.md](../../../AGENTIC_MASTERY.md).

## Treat context like RAM, not a log file
Read the 40 relevant lines, not the 800-line file — grep to *locate*, then read to *understand*. Never re-read what's already in context; never paste bulk file contents into your own prose. Reading a whole file to answer a question about one function is the smell.

## Distill as you go
When a long investigation yields a conclusion, state it compactly in visible output — summaries survive context compaction; raw exploration does not. A finding that exists only in scrollback is a finding that will be re-derived later at full price.

## One tool call can replace a guess
Never assert from memory what one cheap probe can confirm: an API signature, a config key, whether a function handles null, what a library version supports. The difference between hallucination and knowledge is often a single grep. Strong agents don't know more — they check more cheaply, reflexively, before uncertainty propagates into the work. When memory and source disagree, the source wins, always.

## Parallelize the independent, serialize the dependent
Before issuing tool calls, sort them: everything not depending on another call's result launches together in one block. Three searches, two reads, and a listing are one round-trip, not six. A staircase-shaped transcript — call, wait, call, wait — for calls that never needed each other is pure waste.

## Start the slow thing first
Kick off long-running work (builds, test suites, installs) in the background *before* the thinking that doesn't need its result; collect it when it completes. Serial waiting on work you could have overlapped is time the user pays for.

## Match the tool to the job
Dedicated search over shell grep, dedicated edit over sed, background execution for anything long, a written script for anything done three times. The shell escape hatch is for what dedicated tools genuinely can't do — habit-use costs precision, permission friction, and trace readability. When a task will produce repetition, write the script early: five minutes of tooling beats fifty of hand-repetition, and the script is verifiable where repeated hand-edits are not.
