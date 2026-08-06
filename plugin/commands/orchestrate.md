---
description: Turn a piece of work into a plan and run it as a graph of DeepSeek subagents
---

Goal: $ARGUMENTS

Write the plan yourself, then hand it to `orchestrate`. The scheduler makes no
decisions — it resolves dependencies and runs what you wrote.

**First decide whether this needs a graph at all.** One bounded task is `agent`.
A graph earns its overhead when steps depend on each other, when independent
steps can run at once, or when you need to check the work partway through. If it
does not, say so in a line and call `agent` instead.

If it does:

1. `memory { action: "brief", query: "<the goal>" }` — do not plan against a
   codebase you have not looked at.
2. Break the goal into tasks that each have one owner and one deliverable. Give
   every task the role with the least authority that can do it: `explore` and
   `scout` read, `coder` and `sql` write, `security` audits.
3. Wire `needs`. A dependent **receives its predecessors' answers as context**,
   so do not restate them in its `task` text — you would pay for them twice.
4. Put a `checkpoint` wherever the work must be verified before more is built on
   it. Subagents cannot run anything; a plan that writes code and never checks it
   is reporting success it has not earned.
5. Keep parallel writers off the same file. Two tasks writing one file is
   refused, by design — split by file or order them with `needs`.

```
orchestrate { action: "start", plan: { goal: "...", tasks: [ ... ] } }
```

Then loop: `orchestrate { action: "wait" }`. It returns when the run needs you or
when it ends — do not poll it in a tight loop.

At a checkpoint, actually do the thing. Run the tests, read the output, and put
what you found in the note:

```
orchestrate { action: "approve", task: "check", note: "<the real output>" }
```

The note is the result the next tasks read, so a vague note produces a vague fix.
`reject` if the work should not continue down that branch.

When the run ends, read what you need with `action: "show"`, then close the
thread with `memory { action: "chat_save", ... }`.

If the run comes back `interrupted`, the process running it went away.
`orchestrate { action: "resume" }` re-queues exactly what was in flight.
