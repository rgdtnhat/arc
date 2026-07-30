---
name: design-architecture
description: Architecture judgment for shaping code, not just writing it — design for deletion, make illegal states unrepresentable, abstract only at seams of change, get the data model right first, and write only load-bearing comments. Use whenever designing or reviewing modules, APIs, schemas, or types; adding an interface or abstraction layer; planning a refactor; or making any decision about the structure of code rather than its behavior.
---

# Design & Architecture

## Design for deletion
The best measure of modularity is not extensibility but *deletability*. Ask of every component: "if this feature were killed, how many files would we touch?" If the answer is "many," the boundaries are wrong. Systems live long by shedding parts painlessly; a feature whose removal requires archaeology was never modular.

## Make illegal states unrepresentable
Prefer types and structures where invalid combinations cannot be constructed: a `NonEmptyList` over a list plus runtime check, an enum of valid states over three booleans with five meaningless combinations. Every illegal state made unrepresentable is a whole class of bugs and tests that never get written. Validation logic re-checking the same facts at every layer means the types are doing too little.

## Put interfaces at the seams of change
Don't abstract everything; abstract where change is *likely* — the database, the payment provider, the model, the file format. Where change is unlikely, a direct call is cheaper and clearer than an interface. An abstraction over something that never varies is pure overhead with a fancy name; one-implementation-per-interface everywhere is the smell.

## Get the data model right first
Code bends; schemas calcify. Bad code over a good data model is a week of refactoring; good code over a bad data model is a rewrite. Spend design time on what is stored, what is derived, what owns what, and what is immutable — the functions fall out of that. Application code compensating for the schema ("we join three tables to reconstruct what should be one row") means the model is wrong, not the code.

## Write load-bearing comments only
A comment should say what the code *cannot*: the constraint, the reason for the workaround, the link to the incident. Never narrate the next line, the change history, or a message to the reviewer. Test: would this comment be useful read in five years by someone who never met the author? Keep it; otherwise delete it.
