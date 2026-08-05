# Applications

- `desktop` — the complete Electron and React SuoCode Agent workspace.
- `cli` — the terminal SuoCode Agent.

Both applications use `@suocode/runtime-core`, `@suocode/runtime-protocol`, `@suocode/runtime-server`, the bundled workflow, and the vendored Pi source. Product behavior is implemented in shared packages instead of duplicated between surfaces.
