# CoilCoil Desktop

CoilCoil Desktop is the self-contained GUI distribution of CoilCoil. It provides a real Agent workspace rather than an editor shell: persistent conversations, live model output, tools, plans, Git changes, terminal activity, and project files are all backed by the embedded runtime.

## Runtime boundary

The React renderer has no Node.js access. Electron's main process starts the bundled runtime as a child process, exposes a narrow typed IPC bridge through the sandboxed preload, and forwards runtime events to the UI.

## Development

Run setup once from the repository root, then start Desktop:

```bash
npm run setup
npm run dev
```

## Verification and packaging

```bash
npm run check
npm test
npm run smoke
npm run package:desktop
```

Packaged artifacts are generated in `apps/desktop/release/`.
