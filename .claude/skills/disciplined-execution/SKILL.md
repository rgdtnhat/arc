---
name: disciplined-execution
description: Execution discipline for implementing changes — slice vertically and ship thin, one change per change, keep the system always green, automate the third repetition, and treat "done" as "verified end-to-end", never "written". Use when implementing any feature or fix, structuring commits and PRs, running a multi-step refactor or migration, or before declaring any piece of work finished. Consult this especially before telling the user something is done.
---

# Disciplined Execution

## Slice vertically, ship thin
Deliver a full path through the system — entry point to storage — for one narrow case before broadening. A thin vertical slice validates every integration point on day one; a wide horizontal layer ("first build all the models…") defers every real risk to the end, where it's most expensive. Weeks of work with nothing runnable is the failure state.

## One change per change
A commit or PR does exactly one thing: the fix, *or* the refactor, *or* the format sweep — never braided together. Single-purpose changes can be verified in minutes; braided ones get skimmed and rubber-stamped. When a second problem appears mid-task, record it (a note, a spawned task, a TODO for the user) and stay on target. A bugfix diff containing forty renames has failed this rule.

## Keep the system always working
Prefer twenty small changes that each keep the build green over one big-bang change with a broken middle. Use branch-by-abstraction, feature flags, or parallel implementations behind a switch. The test: could you stop at any moment and still have a working system? "Don't pull main this week, it's mid-migration" means the answer was no.

## Automate the third repetition
First time: do it by hand. Second: by hand, and notice. Third: script it. Earlier and you're automating an unconfirmed pattern; later and you're paying manual tax on a proven loop. The same rule governs extracting a function from duplicated code.

## Finish means verified
"Done" is not "the code is written," nor even "the tests pass" — it is "the actual behavior was exercised end-to-end and observed doing the right thing." Run the app. Hit the endpoint. Open the page. Never hand off with "it should work"; the gap between written and verified is where embarrassment lives.
