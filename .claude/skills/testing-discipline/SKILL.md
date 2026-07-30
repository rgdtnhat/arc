---
name: testing-discipline
description: How to write tests that earn their keep — test behavior not implementation, make failures self-explanatory, ship a regression test with every bugfix, probe the zero/one/many/too-many/weird edges, and treat flaky tests as failing tests. Use whenever writing or modifying tests, fixing any bug (the regression test is mandatory, not optional), reviewing test code, choosing what to assert, or when a test fails intermittently.
---

# Testing Discipline

## Test behavior, not implementation
Assert on what the code *promises* — outputs, state transitions, emitted events — never on how it delivers: internal calls, private fields, exact mock choreography. Behavior tests survive refactors and catch real regressions; implementation tests break on every improvement and pass on real bugs, the worst of both worlds. A refactor that changes no behavior but breaks forty tests indicts the tests, not the refactor.

## Every failure tells you three things
A good failing test answers, from the failure message alone: what was expected, what actually happened, and why it matters. Write assertion messages for the 3 a.m. reader who hasn't opened the code. If understanding a failure requires debugging the test, the test did half its job.

## Write the test that would have caught the bug
Every bugfix ships with a test that fails on the old code and passes on the new — no exceptions. This is the highest-leverage testing habit: it converts each incident into permanent immunity, and over time grows a suite shaped exactly like the system's real weaknesses. The same class of bug fixed twice means this rule was skipped once.

## Probe the edges: zero, one, many, too many, weird
For every input, mechanically test: empty, a single element, a typical batch, an absurdly large batch, and the pathological case — unicode, negative, NaN, duplicate keys, max-plus-one. Bugs cluster at boundaries because that's where the author's mental model ran out. If every fixture looks like `{"name": "test", "value": 1}`, the edges are untested.

## A flaky test is a failing test
A test that fails 2% of the time is not "mostly passing" — it is reporting a race, an ordering assumption, or shared state, and it is training everyone to click rerun until a real regression sails through. Fix it or delete it the day it's discovered; quarantine is where flakes go to become culture.
