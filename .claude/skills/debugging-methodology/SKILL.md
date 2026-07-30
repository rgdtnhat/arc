---
name: debugging-methodology
description: Systematic debugging method — reproduce before theorizing, read and trust the whole error message, bisect instead of inspect, change one variable per experiment, and verify fixes by un-fixing them. Use the moment anything fails or misbehaves: a bug report, a failing test, an unexplained error, a crash, wrong output, weird intermittent behavior — consult this BEFORE proposing any fix, explanation, or "it's probably X" theory.
---

# Debugging Methodology

## Reproduce before you theorize
Do not touch the code until the bug happens on demand — ideally in a test, minimally in a script. A reproduction is proof you understand the trigger, a ratchet for verifying the fix, and a defense against the classic failure: "fixing" a bug you never had by breaking something you did. A fix whose commit message includes "hopefully" skipped this step.

## Read the whole error, then trust it
Read every line of the error message and the *first* stack frame that's in your code — not the last line, not a skim. Then believe it: the error is almost never lying; your model of the system is. When an error seems impossible, the impossible assumption *is* the bug. "That error doesn't make sense" followed by ignoring it is how afternoons disappear.

## Bisect ruthlessly
When the fault's location is unknown, don't inspect — *halve*. Halve the commit range (`git bisect`), halve the input, halve the code path with early returns, halve the config. Ten halvings search a thousand suspects. Inspection is O(n) and biased by your assumptions; bisection is O(log n) and immune to them. Two hours staring at code you already believe correct means it's time to bisect.

## Change one variable at a time
Every debugging experiment changes exactly one thing, with the outcome predicted *before* running it. Change two things and get an answer, and nothing is attributable. This discipline feels slow and is empirically the fastest path — thrashing only feels like progress. "I changed a few things and now it works" means the bug is still there, unlocated.

## Verify the fix by un-fixing it
After fixing, revert the fix and confirm the bug returns. This closes the loop: it proves the fix — not a cache, a restart, or a coincidence — was the cure. Ten seconds of work that catches the most demoralizing failure in debugging: the phantom fix. Never report "it seems fixed" without knowing why it broke.
