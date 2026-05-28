#!/usr/bin/env node
/**
 * Human exercise file for the `vab` CLI entry point.
 *
 * You will create `src/cli/main.ts` next to this file and copy the structure by hand.
 * This file is intentionally verbose: the comments explain the responsibility of the
 * CLI layer and how it delegates to `src/runtime` without knowing Virtuoso details.
 */

import { getVirtuosoStatus, runTask, validateTaskFile } from "../index.ts";

/**
 * The CLI layer should stay thin.
 *
 * It converts shell arguments into runtime calls, then prints machine-readable JSON.
 * It should not directly connect to Virtuoso, parse Spectre logs, or implement
 * optimization logic. Those belong in `src/runtime`.
 */
async function main(argv: string[]): Promise<number> {
	const [command, subcommand, pathOrJob] = argv;

	// `vab status --json`
	// For the scaffold, status only proves that the package is wired up.
	if (command === "status") {
		const status = await getVirtuosoStatus();
		console.log(JSON.stringify({ ok: true, value: status }, null, 2));
		return 0;
	}

	// `vab task validate path/to/task.json --json`
	// This checks the task schema without running any external EDA command.
	if (command === "task" && subcommand === "validate" && pathOrJob) {
		const result = await validateTaskFile(pathOrJob);
		console.log(JSON.stringify(result, null, 2));
		return result.ok && result.value.issues.length === 0 ? 0 : 1;
	}

	// `vab run path/to/task.json --json`
	// The real implementation will create a job directory and call OCEAN/Spectre.
	// The scaffold calls a fake runtime workflow so the shape is testable now.
	if (command === "run" && subcommand) {
		const result = await runTask(subcommand);
		console.log(JSON.stringify(result, null, 2));
		return result.ok ? 0 : 1;
	}

	// Keep help text close to the CLI entry point so humans can discover the first commands.
	console.error("Usage:");
	console.error("  vab status --json");
	console.error("  vab task validate <task.json> --json");
	console.error("  vab run <task.json> --json");
	return 1;
}

void main(process.argv.slice(2)).then((exitCode) => {
	process.exitCode = exitCode;
});
