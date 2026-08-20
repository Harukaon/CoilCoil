# Shell execution lifecycle

CoilCoil uses one managed PTY runtime for both ordinary shell commands and background terminals.
The model sees two tools:

- `bash` starts a command and owns the foreground-to-background handoff.
- `terminal` controls an existing managed command with `read`, `await`, `send`, `stop`, and `list`; it can also explicitly start an interactive PTY.

## Bounded foreground wait

`bash` waits for a command to finish for at most `block_until_ms`, which defaults to 30 seconds.
This is a tool-call wait window, not a process timeout. If the window closes while the process is healthy, the process remains alive and the result returns:

- `background_shell_id`
- `is_running_in_background: true`
- `popped_out_into_background: true`
- `output_location`
- the current output and cursor

Known servers, watchers, monitors, and other persistent commands should set `is_background: true`. They return immediately and must not add shell `&` themselves.

`timeout_ms` is separate and optional. It is a hard process lifetime: reaching it terminates the managed process tree and records a failed terminal state.

## Background control

The stable `background_shell_id` is accepted as `terminal.id`:

- `read` returns output since a cursor without blocking by default.
- `await` waits for exit or a literal output match. Its default wait is bounded to 30 seconds.
- `send` writes text or a special key to the PTY.
- `stop` terminates the owned process tree and verifies cleanup.
- `list` reports retained running and recently completed sessions.

Every command writes redacted output to `output_location`, so later reads do not require replaying output through the original tool call.

## Notifications and UI state

Once a Bash command enters the background, natural completion sends a follow-up event to the Agent. `notify_on_output` accepts a regular expression for an additional output notification. Deliberate `terminal stop` does not create a redundant completion turn.

Every event delivered to the Agent costs a full LLM turn, because Pi drains queued messages one at a time. One dispatcher therefore owns all terminal events and keeps that cost proportional to the work, not to the number of terminals:

- **Coalesced.** Events that fire inside one short window become a single message that names every terminal. Ten background shells finishing together cost one turn, not ten. `details.notices` carries the structured copy the UI renders as one card per terminal; a lone event keeps the single-headline shape it always had.
- **Not repeated.** An event a tool call already reported is dropped instead of sent. A background shell the Agent waited for with `terminal await`, or a `terminal start` that returned after its process exited, produces no second announcement of the same exit.
- **Held while the Agent works.** During an agent run nothing is sent: the run is already reading these terminals through its own tool calls. The batch waits for `agent_settled` and then wakes exactly one turn. A run that never settles does not trap events forever — after a minute they steer into the running turn instead, which costs no extra request.

Output in a batched message shares one budget, so a burst of noisy terminals cannot flood the context; each event keeps the tail of its own output, truncated from the front.

Terminal state is also persisted as `coilcoil-terminal-run` session entries. The Runtime projects the Bash handoff as a completed tool call while keeping the stable terminal row in `running` state; later completion updates that same row instead of leaving it permanently running.
