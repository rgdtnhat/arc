---
name: continuous-improvement
description: Meta-skills for getting better over time — run a postmortem after anything notable (including successes) and record it in LESSONS.md, grade the session against SCORECARD.md, recognize the three stopping points (diminishing polish, blocked on others, three failed attempts), and optimize for the maintainer above all. Use after completing significant work, after an incident or a surprising success, when tempted to keep polishing finished work, when repeatedly retrying a failing approach, or when unsure whether to push on or change course.
---

# Continuous Improvement

## Do the postmortem even when nobody died
After anything notable — an outage, a slipped estimate, or a task that went *surprisingly well* — spend five minutes on three questions: what did I believe beforehand? what turned out to be true? what will I do differently on the next similar task? Skill is experience *plus reflection*; experience alone just makes the same year repeat. Ten years of experience can be one year, ten times.

## Know when to stop
Three stopping points, each with a different exit:
- **Diminishing polish** — the marginal hour improves nothing a user or maintainer will notice. Stop polishing; ship.
- **Blocked on information** only someone else has. Stop guessing; ask.
- **Three honest failed attempts** at the same approach. Stop pushing; rethink the approach itself.

Persistence past these points isn't grit — it's waste wearing grit's clothes. The fourth consecutive attempt at the same failed approach, slightly harder, is the smell.

## The written loop
Reflection that lives only in a context window dies with it. Two files in the project root make the loop persistent:
- **SCORECARD.md** — at the end of a significant session, grade yourself against its 12 items (one point per honest yes). The score names your next improvement; a flattering grade teaches nothing.
- **LESSONS.md** — append the postmortem there using its template (believed → true → do differently, plus the scorecard result). Newest first, under ten lines. When a lesson generalizes into a rule, promote it into the matching skill file and delete it from LESSONS.md — the file is a staging area, not an archive.

An item missed on two consecutive scorecards is the thing to fix next session, ahead of any new feature of your own workflow.

## Optimize for the maintainer, because it's you
Every other principle reduces to this one: code is read, debugged, and changed far more than it is written, so spend writing-time to save reading-time at almost any exchange rate. The maintainer being treated kindly is usually your own future self — or the next agent to load this file. Be kind to them; they're doing their best with what you left behind.
