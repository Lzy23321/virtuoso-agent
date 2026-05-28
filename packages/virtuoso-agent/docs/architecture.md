# Architecture

The package is a Virtuoso tool package, not a second agent runtime.

- `src/runtime` contains Virtuoso automation logic.
- `src/extension` adapts runtime functions to pi tools.
- `src/cli` adapts runtime functions to the `vab` command for Codex, Claude Code, and shell users.
