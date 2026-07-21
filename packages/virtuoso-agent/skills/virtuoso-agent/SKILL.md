---
name: virtuoso-agent
description: Use when working with Cadence Virtuoso automation tasks through the virtuoso-agent tools.
---

# Virtuoso Agent

Use high-level `virtuoso_*` tools before raw shell or raw SKILL.

For controlled Virtuoso bridge work, operate only on registered managed instances:

- Use `virtuoso_instances` to list live bridge-managed instances.
- Use `virtuoso_instance_launch` only when a new managed UI instance is explicitly needed.
- Before launching a visible instance, require a real X11 connection. Prefer the `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, and `XDG_RUNTIME_DIR` inherited from the graphical desktop session. Never guess a display from X socket filenames. If the X11 handshake fails, report the error and do not launch Virtuoso.
- Use `virtuoso_inventory` with `action: "libraries"` to discover libraries or `action: "cellviews"` plus `library` to inspect one library. Do not inventory when the user already supplied an exact target.
- Use `virtuoso_inspect_maestro` for read-only Maestro setup inspection. Read the compact result first, then open the JSON artifact only when details are needed.
- Use `virtuoso_cellview` with `action: "show"` when the engineer needs to inspect a cellView in the visible UI, or `action: "current"` to identify the active cellView.
- Use `virtuoso_task` with `action: "validate"` to validate without running, or `action: "run"` to execute a task workflow.

When an operation reports multiple candidates, ask the user to choose and retry that same operation with `instanceId`; a successful operation automatically binds that instance to the pi session. When no instance exists, do not launch one implicitly—ask for authorization first.

Do not generate large SKILL scripts as the primary path. Do not use arbitrary SKILL eval for design database operations.
Do not scan, attach to, or claim control over Virtuoso processes that are not present in `virtuoso_instances`.
