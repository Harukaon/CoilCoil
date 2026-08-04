# SuoCode

SuoCode is a complete coding-agent product built around an embedded Pi runtime.
It will ship in two forms:

- **SuoCode CLI** — the terminal product with SuoCode's workflow, tools, and defaults.
- **SuoCode Desktop** — the self-contained GUI product with its own bundled runtime.

Users of SuoCode Desktop will not need to install Pi separately.

## Repository layout

```text
SuoCode/
├── apps/                 # CLI and desktop applications
├── packages/
│   └── workflow/         # SuoCode's current Pi workflow
├── vendor/
│   └── pi/               # Thin fork of the upstream Pi source
└── docs/                 # Architecture and maintenance notes
```

The upstream Pi source is imported with Git subtree so it is present in this
repository while remaining traceable and updateable. See
[`docs/pi-upstream.md`](docs/pi-upstream.md).

## Current status

The existing workflow has been copied into `packages/workflow`. The standalone
development copy is maintained separately as `pi-workflow`.
