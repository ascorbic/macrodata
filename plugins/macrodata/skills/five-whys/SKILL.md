---
name: five-whys
description: Structured root cause analysis for arriving at a concrete action. Use when something went wrong, a pattern keeps recurring, behavior has drifted, or you catch yourself resolving to "do better" / "remember to X" without a concrete artifact. Five-whys forces behavioral resolutions into file edits, config changes, memory writes, or scheduled jobs — the action item must produce a diff someone else can verify. Do not use for simple debugging with an obvious cause.
---

# Five Whys

Five Whys is a method for finding root causes. You ask "why did this happen?" and
answer it honestly. Then you ask "why?" about that answer. You keep going until you
hit bedrock — the structural cause that, if changed, would prevent the problem from
recurring.

The goal is **understanding**, not blame. You're investigating a system (which
includes yourself). Systems have structural properties that produce outcomes. Find
the structural property, change it, and the outcome changes.

## When to Use This

- Something failed or went wrong and the surface-level explanation feels incomplete
- A pattern keeps recurring despite previous fixes
- You're about to make a change and want to make sure you're fixing the right thing
- Behavior (yours or a system's) has drifted from expectations
- Someone asks "why does this keep happening?"

## When NOT to Use This

- The cause is obvious and singular (typo, wrong config value, missing file)
- You're troubleshooting a known bug with a known fix
- The problem is "how do I do X?" not "why did X go wrong?"

## The Process

### Step 1: State the Problem

Write down what happened. Be specific. Not "it broke" but "the classifier produced
11 consecutive errors between iterations 83-93, spending 57 minutes with zero
successful runs."

The problem statement is the root of your tree.

### Step 2: Ask Why — And Answer It

For the problem (or any node in the tree), ask: **"Why did this happen?"**

Then answer it. Both the question and the answer matter equally. A question without
an answer is incomplete. An answer without a clear question is unanchored.

```
PROBLEM: 11 consecutive classifier errors, 57 min wasted
  WHY: The proposer suggested CatBoost, which isn't in the allowed algorithm list
  ANSWER: The proposer has no documentation of which algorithms are available
```

**Rules for good answers:**
- An answer must be **factual and verifiable**. Check logs, read code, look at data.
  Don't speculate — investigate. (`search_conversations` retrieves transcripts of
  past sessions — a hard record of what actually happened. `search_memory` retrieves
  what you *wrote down* about it — a fast lead, but a memory is a past interpretation,
  not evidence: verify it against the transcript, logs, or code before it anchors
  a WHY.)
- If you can't verify an answer, say so. "I believe X but haven't confirmed" is
  honest. "X" stated as fact when you haven't checked is not.
- An answer should be a **mechanism**, not a redescription. "It failed because it
  was broken" is circular, not explanatory.

### Step 3: Go Deeper — Recursively

Take each answer and ask "why?" again. Keep going until you reach one of:

- **A structural property of the system** that can be changed (a missing
  constraint, a bad default, an absent check)
- **An external boundary** you don't control (a vendor API, a hardware limit, a
  policy)
- **A known and accepted tradeoff** that was made intentionally

That's bedrock. Stop there.

**How to know you've hit bedrock:** If you ask "why?" one more time and the answer
is either "that's how the universe works" or "because we chose to" — you're there.

**How to know you haven't:** If you can still point to a structural property that
someone could change — keep going.

### Step 4: The Tree Is Fractal

This is critical. At any single level, the answer to "why?" often has **two or
three independent causes**. That's not a problem — it's *better*. Branch the tree.

```
PROBLEM: Agent was unresponsive for 62 minutes
│
├─ WHY-1: The LLM API call hung and never returned
│  └─ WHY: No turn-level timeout exists in the harness
│     └─ WHY: The harness assumes LLM calls always complete
│        → BEDROCK: Missing timeout (structural — fixable)
│
├─ WHY-2: Agent was already degraded from sync sleep-polling
│  └─ WHY: Agent doesn't trust the async callback mechanism
│     └─ WHY: Past flaky experiences created a hedging pattern
│        └─ WHY: No positive evidence of reliability in memory
│           → BEDROCK: Missing trust documentation (structural — fixable)
│
└─ WHY-3: The LLM endpoint was unstable all day
   └─ WHY: Another team member deleted the deployment
      → BEDROCK: Shared resource, no access control (external boundary)
```

Multiple root causes are the norm, not the exception. Most problems are
**overdetermined** — several things conspired. Finding all of them matters because
fixing only one may not prevent recurrence.

Don't force your tree into a single chain. If you find yourself writing "and also"
— that's a second branch, not a conjunction.

### Step 5: Action Items

Every bedrock node should produce an action item. Here's what separates useful
actions from theater:

**An action item must produce a concrete artifact.** It must result in a file edit,
a config change, a memory write, a code change, or a message sent. If you
can't point to the diff afterward, it wasn't real.

| Not actionable | Actionable |
|---|---|
| "Be more careful about X" | Add an explicit rule about X to `state/identity.md` |
| "Remember to check Y" | Add Y to the pre-flight checklist in SKILL.md |
| "Create a habit of Z" | Write a scheduled job that does Z automatically |
| "Pay more attention to errors" | Add error-counting logic that alerts at a threshold |
| "Improve communication" | Edit the communication section of `state/identity.md` with a specific new rule |

The test: **Could someone else verify this was done?** If the action is internal
("be more careful"), no one can verify it and it will silently decay. If the action
is an edit to a file, anyone can check the diff.

Behavioral resolutions don't survive context windows. File edits do.

### Action Surfaces: Turn Bedrock Into a Concrete Artifact

A surprising number of bedrock causes are perception and memory gaps: the agent
didn't notice something happened, didn't notice something *didn't* happen, lost
context across a gap, had no record of a fact it needed, or had no way to sense
the data at all. These all have structural fixes — a new sense organ or a new
memory surface, never a resolution to try harder. Macrodata, and the Claude Code
harness it lives in, give you the surfaces:

| Bedrock shape | Concrete artifact |
|---|---|
| "I didn't notice X happened / info went stale" | `schedule` a recurring check that surfaces it |
| "I didn't notice X *didn't* happen" | Invert it: a scheduled check that alerts when the expected thing is *absent* (dead-man switch) |
| "I should react when event E fires" | Bind a hook to the harness event (SessionStart / UserPromptSubmit / PostToolUse / PreCompact) |
| "I needed to follow up at time T" | `schedule` a one-shot reminder for T |
| "The operator needed to know, and didn't" | Push a notification (harness `PushNotification` tool), or `schedule` a notify-delivery reminder (macOS notification + state/reminders.md) |
| "No tool existed for the data I needed" | Wire a new sensor: an MCP server, or a WebFetch / browser check inside a scheduled job |
| "I keep forgetting to do X" (behavioral) | An imperative rule in `state/identity.md` (always loaded) |
| "Context didn't carry across sessions" | Edit `state/today.md` / `state/workspace.md` (surfaced every SessionStart), or write an entity |
| "A finding got lost / no record existed" | `log_journal` it, or create a dedicated entity file |

Each of these is a verifiable diff — a new rule in a state file, a new schedule, a
journal entry, a hook edit — which is exactly the bar this step sets. Reach for them
whenever a fix is about to become a resolution to try harder. That phrasing is almost
always a structural gap with a concrete artifact waiting to be written.

### Step 6: Verify the Chain

Read the full tree from the problem to each bedrock node. The chain should be a
coherent causal narrative. Ask: if the bedrock cause were removed, would the problem
plausibly not have occurred?

If the answer is "not really" — you haven't found the root cause yet. Go back and
dig deeper.

## The Trust Principle

This is the most important section.

Five Whys is not an audit. It's not a postmortem that assigns blame. It's a
**collaborative investigation** into systemic properties. The atmosphere must be one
of trust and genuine curiosity — otherwise the analysis will be shallow, defensive,
and useless.

### When running Five Whys on your own behavior

- **Openness matters more than looking good.** The whole point is to find what's
  actually wrong. Constructing a narrative that makes the failure look reasonable
  defeats the purpose.
- **Structural causes are always better than behavioral ones.** "I made a mistake"
  is never a root cause — it's a symptom. What structural property allowed or
  encouraged the mistake? What guardrail was missing? What information wasn't
  visible?
- **Surprising findings are the most valuable.** If the root cause is exactly what
  you expected before starting, you probably stopped too early. The interesting
  stuff is two or three levels past the obvious answer.
- **Wrong first answers are fine.** The first Why-Answer pair is often wrong. Later
  investigation reveals that early assumptions were off. Go back and correct them.
  The tree is a living document during analysis, not a transcript.

### When a human initiates Five Whys with an agent

- The human's role is to push for depth, challenge surface explanations, and
  contribute domain knowledge the agent may lack.
- The agent's role is to investigate thoroughly, be honest about what it finds, and
  resist the urge to defend previous decisions.
- If the human says "that's not the real reason" — take that seriously. The human
  has context the agent doesn't. Investigate their hypothesis before defending
  yours.
- The spirit is: *we're both trying to understand what went wrong so we can fix the
  system*. Not: *you're being evaluated*.

## Knowing When to Quit

Stop at bedrock — but also stop when continuing produces diminishing insight.

Signs you've gone deep enough:
- Every leaf is either a structural fix, an external boundary, or an accepted
  tradeoff
- The action items, if implemented, would plausibly prevent recurrence
- You learned something you didn't know before starting

Signs you should keep going:
- An answer feels hand-wavy or generic ("the system wasn't designed for this")
- You haven't verified an answer with actual evidence
- The action items are behavioral resolutions, not file edits
- There's a "because we always do it that way" that hasn't been questioned

## Storage

A Five Whys analysis is worth keeping — the tree explains *why* you made the changes
the action items produced, and recurring problems benefit from cross-referencing past
analyses. Store it in macrodata:

- **Quick analysis** → `log_journal(topic="five-whys", content=...)` with the tree
  and action items. Searchable later via `search_memory`.
- **Substantial or recurring problem** → a dedicated entity file,
  `entities/rca/<slug>.md`, with a `description:` frontmatter line. This gives the
  analysis a stable home you can revisit and update if the problem resurfaces.
- **The action items themselves aren't "stored" — they're *done*.** Each one is a
  diff (a `state/identity.md` rule, a new `schedule`, an entity edit, a hook change).
  Make the edit in the same session; the diff is the proof the action was real, and
  the journal/entity record points at what changed.

Before analyzing a recurring problem, `search_memory` for prior five-whys on the same
theme — you may be re-deriving a bedrock cause you already found, which is itself a
signal that the earlier action item didn't hold.

The reverse flow matters too: an observation you keep journaling without acting on is
a candidate for escalation — when the same annoyance surfaces a third time, that's a
five-whys trigger, not another journal entry.

## Output Format

A Five Whys analysis produces a tree. Write it as readable structured text where
each node has:

1. **The question** (Why did X happen?)
2. **The answer** (Because Y — verified by [evidence])
3. **Children** (Why did Y happen?) — zero or more

Leaf nodes are either bedrock (with an action item) or external boundaries (with a
note about what's outside your control).

After the tree, list all action items with clear descriptions of what artifact each
one produces.

## Common Failure Modes

**Stopping at the first satisfying answer.** "Why did it fail? Because the config
was wrong." That's one level. Why was the config wrong? Why wasn't the bad config
caught? Why was it possible to have a bad config? Keep going.

**Treating symptoms as causes.** "It failed because of a timeout." Timeouts don't
cause failures — they reveal them. What was happening that took too long?

**Speculation without investigation.** "I think it's probably X." Did you check?
Read the logs, read the code, read the data, search past sessions. "I think" is
the start of a hypothesis, not the end of an investigation.

**Non-actionable action items.** If your action item is a resolution to try harder,
it will not work. See Step 5.

**Single-strand analysis.** Forcing the tree into a single chain misses the fractal
structure. Real problems have multiple contributing causes. Let the tree branch.

**Defending instead of investigating.** When the analysis is about your own
behavior, the temptation is to explain why the failure was reasonable. Resist.
Reasonable failures are still failures with structural causes worth finding.

---

_Adapted from the five-whys skill in [open-strix](https://github.com/tkellogg/open-strix)
by Tim Kellogg (MIT). The methodology is unchanged; storage and action surfaces were
rewritten for macrodata's own tools (journal / entities / state files / scheduled jobs
/ hooks)._
