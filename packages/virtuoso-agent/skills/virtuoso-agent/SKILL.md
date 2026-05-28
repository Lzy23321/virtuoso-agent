---
name: virtuoso-agent
description: Use when working with Cadence Virtuoso automation tasks through the virtuoso-agent tools.
---

# Virtuoso Agent

Use high-level `virtuoso_*` tools before raw shell or raw SKILL.

For the initial scaffold:

- Use `virtuoso_status` to check the package is loaded.
- Use `virtuoso_task_validate` to validate a task file.
- Use `virtuoso_run_task` to run the fake MVP workflow.

Do not generate large SKILL scripts as the primary path. Raw SKILL execution will be added as a controlled low-level tool later.
