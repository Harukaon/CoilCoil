# @coilcoil/workflow

CoilCoil's current Pi workflow package. It contains the tools, policies,
project-memory behavior, terminal support, response metrics, and Simplified
Chinese experience migrated from the original personal workflow.

## Project memory

The bundled `project-memory` Pi extension keeps memory inside CoilCoil's private
Agent data directory. Every settled Agent request counts one turn against the
project's persisted counter; only once it reaches `summarizeEveryTurns` (30 by
default, configurable in the memory panel) does the extension start the bundled
headless Pi worker to summarize that session. Summarizing on every turn cost a
full background model run per reply and rarely found anything new.

Memory is stored as an index: `MEMORY.md` holds one line per memory (title, one
sentence, and the file it lives in) and each body sits in its own Markdown file
under `memories/`. Only the index is injected through `before_agent_start`; the
Agent reads a body when the index says it is relevant. A memory written in the
old single-file format is migrated into that layout automatically the next time
the store is opened, without losing any text. The worker is disabled inside
memory-worker sessions to avoid recursion, and `/memory` remains available for a
manual refresh, which also restarts the turn count.

## Development

```bash
npm ci
npm run check
npm test
```
