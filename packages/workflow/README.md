# @suocode/workflow

SuoCode's current Pi workflow package. It contains the tools, policies,
project-memory behavior, terminal support, response metrics, and Simplified
Chinese experience migrated from the original personal workflow.

## Project memory

The bundled `project-memory` Pi extension keeps memory inside SuoCode's private
Agent data directory. After an Agent request is fully settled, it starts the
bundled headless Pi worker to summarize that session. A later conversation in
the same project receives the current project `MEMORY.md` through
`before_agent_start`. The worker is disabled inside memory-worker sessions to
avoid recursion, and `/memory` remains available for a manual refresh.

## Development

```bash
npm ci
npm run check
npm test
```
