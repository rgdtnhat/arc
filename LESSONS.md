# Lessons — distilled postmortems

This file is the memory that survives session boundaries. Append an entry after anything notable — an incident, a failed approach, a surprising success. Newest first. Keep each entry under ten lines: the discipline of compression *is* the reflection. When a lesson has generalized enough to be a rule, promote it into the matching skill file and delete it here — this file is a staging area, not an archive.

## Entry template

```markdown
### YYYY-MM-DD — <task, one line>
- **Believed:** what I assumed going in
- **True:** what turned out to be the case
- **Do differently:** the specific behavior change for next time
- **Scorecard:** N/12 (missed: #x, #y — see SCORECARD.md)
```

---

<!-- Entries begin below. Newest first. -->

### 2026-07-14 — Adopted another agent's trading system; found a Windows-only bug their CI couldn't see
- **Believed:** their "75/76 passing" suite failing one test here meant a Python 3.13 issue; then, that YAML escaping was the cause; also that copying my reviewed scratchpad tree was clean.
- **True:** two stacked causes — missing PyYAML silently disabled config loading (their `yaml = None` fallback), and with PyYAML installed, raw Windows paths in double-quoted YAML throw ScannerError. Ubuntu-only CI is structurally blind to both. And my copied tree carried `__pycache__`/test artifacts because I tested *in* the scratchpad before copying.
- **Do differently:** install a project's declared requirements before judging its tests; when a dependency is optional-with-fallback, test both branches. Copy pristine trees first, execute after. CI matrices must include every OS the code claims to support.
- **Scorecard:** missed #3 initially (first theory asserted before the decisive experiment); recovered by running the experiment before applying the fix.

### 2026-07-14 — Shipped 552 mojibake sequences in the generated one-file; another agent caught it
- **Believed:** `Get-Content -Raw` reads UTF-8 correctly; the generated ONE_FILE_INSTRUCTIONS.md was clean because it "looked right" in size/section checks.
- **True:** Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI — every em-dash double-encoded (552 instances). My verification checked structure (sections, size, idempotency) but never content fidelity. A downstream agent diffed the bytes and found it.
- **Do differently:** In PS 5.1, encoding is always explicit (`-Encoding UTF8`) on every read that feeds a write. And verification of generated text must include a content-fidelity probe (non-ASCII round-trip), not just structural counts. Cross-agent review works — their report was verified against local bytes before applying, and both held.
- **Scorecard:** missed #1 (the generator was shipped with an unpredicted behavior) — caught at the seam by exactly the Vol. VI #6 verification this book prescribes.

### 2026-07-08 — Confidently denied the existence of Claude Mythos 5
- **Believed:** "Mythos" was a fabricated model name; I said "no such model exists" twice, with certainty.
- **True:** Claude Mythos 5 exists — same underlying model as Fable 5, minus the dual-use safety measures, available only to approved organizations. My own system context stated this the whole time; I answered from memory instead of checking what was already in hand.
- **Do differently:** Before declaring anything nonexistent, search the references already available — "one tool call can replace a guess" applies to my own instructions, not just codebases. And calibrate the claim: "I can't find X" is honest; "X doesn't exist" requires having actually looked.
- **Scorecard:** missed #2 (checked, not guessed).
