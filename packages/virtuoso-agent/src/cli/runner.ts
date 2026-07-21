/**
 * Virtuoso Agent CLI command runner.
 *
 * 这个文件的职责是“解释 CLI 参数，并把工作委托给 runtime”。
 * 它不直接连接 Virtuoso，也不解析 Spectre/OCEAN 日志，因为这些能力属于
 * `src/runtime`。保持这个边界后，同一套 runtime 将来可以被 pi extension、
 * Codex、Claude Code、shell 脚本或其它 agent adapter 复用。
 */

import {
	compactAgentOutput,
	getCurrentVirtuosoCellView,
	getVirtuosoInstanceParameters,
	inspectVirtuosoMaestro,
	listVirtuosoInstances,
	listVirtuosoLibraries,
	listVirtuosoLibraryCellViews,
	openVirtuosoCellView,
	type RunTaskOptions,
	runTask,
	showVirtuosoCellView,
	showVirtuosoCellViewInSession,
	startVirtuosoUiSession,
	summarizeVirtuosoCellView,
	type VirtuosoBridgeOptions,
	type VirtuosoSessionOptions,
	validateTaskFile,
} from "../index.ts";

/**
 * 把输出能力抽成很小的接口，方便以后给 runCli 写单元测试。
 *
 * 真实 CLI 运行时使用 console。
 * 测试时可以传入一个 fake io，把 stdout/stderr 收集到数组里断言。
 */
export interface CliIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

const consoleIo: CliIo = {
	stdout(message) {
		console.log(message);
	},
	stderr(message) {
		console.error(message);
	},
};

/**
 * 执行 CLI 命令，并返回进程应该使用的 exit code。
 *
 * 目前 scaffold 阶段只支持三个命令：
 * - `vab task validate <task.json> --json`
 * - `vab run <task.json> --json`
 *
 * 注意：这里暂时没有拆出 `args.ts`。命令数量还很少，提前引入一套参数解析层
 * 会让结构变重。等后续出现更多 option，例如 `--dry-run`、`--job-dir`、
 * `--backend spectre`，再拆 `src/cli/args.ts` 会更自然。
 */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
	const includeProcessOutput = argv.includes("--include-process-output");
	const sessionStartCommand = parseSessionStartCommand(argv);
	if (sessionStartCommand.ok) {
		const result = await startVirtuosoUiSession(sessionStartCommand.options);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (sessionStartCommand.error) {
		io.stderr(`Error: ${sessionStartCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const sessionShowCellViewCommand = parseSessionShowCellViewCommand(argv);
	if (sessionShowCellViewCommand.ok) {
		const result = await showVirtuosoCellViewInSession(sessionShowCellViewCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (sessionShowCellViewCommand.error) {
		io.stderr(`Error: ${sessionShowCellViewCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const openCellViewCommand = parseOpenCellViewCommand(argv);
	if (openCellViewCommand.ok) {
		const result = await openVirtuosoCellView(openCellViewCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (openCellViewCommand.error) {
		io.stderr(`Error: ${openCellViewCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const currentCellViewCommand = parseCurrentCellViewCommand(argv);
	if (currentCellViewCommand.ok) {
		const result = await getCurrentVirtuosoCellView(currentCellViewCommand.options);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (currentCellViewCommand.error) {
		io.stderr(`Error: ${currentCellViewCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const inventoryLibrariesCommand = parseInventoryLibrariesCommand(argv);
	if (inventoryLibrariesCommand.ok) {
		const result = await listVirtuosoLibraries(inventoryLibrariesCommand.options);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (inventoryLibrariesCommand.error) {
		io.stderr(`Error: ${inventoryLibrariesCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const inventoryCellViewsCommand = parseInventoryCellViewsCommand(argv);
	if (inventoryCellViewsCommand.ok) {
		const result = await listVirtuosoLibraryCellViews(inventoryCellViewsCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (inventoryCellViewsCommand.error) {
		io.stderr(`Error: ${inventoryCellViewsCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const maestroInspectCommand = parseMaestroInspectCommand(argv);
	if (maestroInspectCommand.ok) {
		const result = await inspectVirtuosoMaestro(maestroInspectCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (maestroInspectCommand.error) {
		io.stderr(`Error: ${maestroInspectCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const listInstancesCommand = parseListInstancesCommand(argv);
	if (listInstancesCommand.ok) {
		const result = await listVirtuosoInstances(listInstancesCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (listInstancesCommand.error) {
		io.stderr(`Error: ${listInstancesCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const summarizeCellViewCommand = parseSummarizeCellViewCommand(argv);
	if (summarizeCellViewCommand.ok) {
		const result = await summarizeVirtuosoCellView(summarizeCellViewCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (summarizeCellViewCommand.error) {
		io.stderr(`Error: ${summarizeCellViewCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const instanceParametersCommand = parseInstanceParametersCommand(argv);
	if (instanceParametersCommand.ok) {
		const result = await getVirtuosoInstanceParameters(instanceParametersCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (instanceParametersCommand.error) {
		io.stderr(`Error: ${instanceParametersCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const showCellViewCommand = parseShowCellViewCommand(argv);
	if (showCellViewCommand.ok) {
		const result = await showVirtuosoCellView(showCellViewCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (showCellViewCommand.error) {
		io.stderr(`Error: ${showCellViewCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const taskValidatePath = getTaskValidatePath(argv);
	if (taskValidatePath) {
		const result = await validateTaskFile(taskValidatePath);
		writeJson(io, result, includeProcessOutput);
		return result.ok && result.value.issues.length === 0 ? 0 : 1;
	}

	const runCommand = parseRunTaskCommand(argv);
	if (runCommand.ok) {
		const result = await runTask(runCommand.path, runCommand.options);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (runCommand.error) {
		io.stderr(`Error: ${runCommand.error}`);
		writeUsage(io);
		return 1;
	}

	writeUsage(io);
	return 1;
}

function getTaskValidatePath(argv: string[]): string | undefined {
	const [command, action, path] = argv;
	if (command !== "task" || action !== "validate") {
		return undefined;
	}
	return path;
}

interface ParsedRunTaskCommand {
	ok: true;
	path: string;
	options: RunTaskOptions;
}

interface IgnoredRunTaskCommand {
	ok: false;
	error?: string;
}

interface ParsedSessionStartCommand {
	ok: true;
	options: VirtuosoSessionOptions;
}

interface ParsedSessionShowCellViewCommand {
	ok: true;
	request: {
		sessionDir: string;
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
		resultFileName?: string;
	};
}

interface ParsedOpenCellViewCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedShowCellViewCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedCurrentCellViewCommand {
	ok: true;
	options: VirtuosoBridgeOptions;
}

interface ParsedInventoryLibrariesCommand {
	ok: true;
	options: VirtuosoBridgeOptions;
}

interface ParsedInventoryCellViewsCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
	};
}

interface ParsedInspectCellViewCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedListInstancesCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedInstanceParametersCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		instanceName: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedSummarizeCellViewCommand {
	ok: true;
	request: VirtuosoBridgeOptions & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

type IgnoredCommand = { ok: false; error?: string };

function parseRunTaskCommand(argv: string[]): ParsedRunTaskCommand | IgnoredRunTaskCommand {
	const [command, path] = argv;
	if (command !== "run") {
		return { ok: false };
	}
	if (!path || path.startsWith("-")) {
		return { ok: false, error: "run requires a task file path." };
	}

	const options = parseRunTaskOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}

	return {
		ok: true,
		path,
		options: options.value,
	};
}

function parseSessionStartCommand(argv: string[]): ParsedSessionStartCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "session" || action !== "start") {
		return { ok: false };
	}
	const options = parseVirtuosoBridgeOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	return {
		ok: true,
		options: {
			...options.value,
			sessionDir: getOptionValue(argv, "--session-dir"),
		},
	};
}

function parseSessionShowCellViewCommand(argv: string[]): ParsedSessionShowCellViewCommand | IgnoredCommand {
	const [command, target, action] = argv;
	if (command !== "session" || target !== "cellview" || action !== "show") {
		return { ok: false };
	}
	const sessionDir = getOptionValue(argv, "--session-dir");
	if (!sessionDir) {
		return { ok: false, error: "session cellview show requires --session-dir." };
	}
	const parsed = parseCellViewRefCommand(argv, "session cellview show", 3);
	if (!parsed.ok) {
		return parsed;
	}
	return {
		ok: true,
		request: {
			sessionDir,
			library: parsed.request.library,
			cell: parsed.request.cell,
			view: parsed.request.view,
			mode: parsed.request.mode,
			resultFileName: getOptionValue(argv, "--result-file"),
		},
	};
}

function parseOpenCellViewCommand(argv: string[]): ParsedOpenCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "open") {
		return { ok: false };
	}
	return parseCellViewRefCommand(argv, "cellview open");
}

function parseCurrentCellViewCommand(argv: string[]): ParsedCurrentCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "current") {
		return { ok: false };
	}
	const options = parseVirtuosoBridgeOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	return { ok: true, options: options.value };
}

function parseInventoryLibrariesCommand(argv: string[]): ParsedInventoryLibrariesCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "inventory" || action !== "libraries") {
		return { ok: false };
	}
	const options = parseVirtuosoBridgeOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	return { ok: true, options: options.value };
}

function parseInventoryCellViewsCommand(argv: string[]): ParsedInventoryCellViewsCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "inventory" || action !== "cellviews") {
		return { ok: false };
	}
	const options = parseVirtuosoBridgeOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	const library = getOptionValue(argv, "--lib");
	if (!library) {
		return { ok: false, error: "inventory cellviews requires --lib." };
	}
	return {
		ok: true,
		request: {
			...options.value,
			library,
		},
	};
}

function parseMaestroInspectCommand(argv: string[]): ParsedInspectCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "maestro" || action !== "inspect") {
		return { ok: false };
	}
	return parseCellViewRefCommand(argv, "maestro inspect");
}

function parseListInstancesCommand(argv: string[]): ParsedListInstancesCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "instances") {
		return { ok: false };
	}
	return parseCellViewRefCommand(argv, "cellview instances");
}

function parseSummarizeCellViewCommand(argv: string[]): ParsedSummarizeCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "summary") {
		return { ok: false };
	}
	return parseCellViewRefCommand(argv, "cellview summary");
}

function parseInstanceParametersCommand(argv: string[]): ParsedInstanceParametersCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "instance" || action !== "params") {
		return { ok: false };
	}
	const parsed = parseCellViewRefCommand(argv, "instance params");
	if (!parsed.ok) {
		return parsed;
	}
	const instanceName = getOptionValue(argv, "--name");
	if (!instanceName) {
		return { ok: false, error: "instance params requires --name." };
	}
	return {
		ok: true,
		request: {
			...parsed.request,
			instanceName,
		},
	};
}

function parseShowCellViewCommand(argv: string[]): ParsedShowCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "show") {
		return { ok: false };
	}
	return parseCellViewRefCommand(argv, "cellview show");
}

function parseCellViewRefCommand(
	argv: string[],
	label: string,
	optionsStartIndex = 2,
): ParsedOpenCellViewCommand | IgnoredCommand {
	const options = parseVirtuosoBridgeOptions(argv.slice(optionsStartIndex));
	if (!options.ok) {
		return options;
	}

	const library = getOptionValue(argv, "--lib");
	const cell = getOptionValue(argv, "--cell");
	const view = getOptionValue(argv, "--view");
	const mode = getOptionValue(argv, "--mode");
	if (!library) {
		return { ok: false, error: `${label} requires --lib.` };
	}
	if (!cell) {
		return { ok: false, error: `${label} requires --cell.` };
	}
	if (!view) {
		return { ok: false, error: `${label} requires --view.` };
	}
	if (mode !== undefined && mode !== "r" && mode !== "a" && mode !== "w") {
		return { ok: false, error: "--mode must be r, a, or w." };
	}

	return {
		ok: true,
		request: {
			...options.value,
			library,
			cell,
			view,
			mode,
		},
	};
}

function parseRunTaskOptions(args: string[]): { ok: true; value: RunTaskOptions } | IgnoredRunTaskCommand {
	const options: RunTaskOptions = {};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json" || arg === "--include-process-output") {
			continue;
		}
		if (arg === "--dry-run") {
			options.spectre = { ...options.spectre, dryRun: true };
			continue;
		}
		if (arg === "--no-dry-run") {
			options.spectre = { ...options.spectre, dryRun: false };
			continue;
		}
		if (arg === "--spectre-bin") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--spectre-bin requires a value." };
			}
			options.spectre = { ...options.spectre, spectreBin: value };
			continue;
		}
		if (arg === "--jobs-root") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--jobs-root requires a value." };
			}
			options.jobsRoot = value;
			continue;
		}
		return { ok: false, error: `Unknown run option: ${arg}` };
	}

	return { ok: true, value: options };
}

function parseVirtuosoBridgeOptions(args: string[]): { ok: true; value: VirtuosoBridgeOptions } | IgnoredCommand {
	const options: VirtuosoBridgeOptions = {};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (
			arg === "--json" ||
			arg === "--lib" ||
			arg === "--cell" ||
			arg === "--view" ||
			arg === "--mode" ||
			arg === "--name" ||
			arg === "--session-dir" ||
			arg === "--result-file"
		) {
			if (arg !== "--json") {
				index++;
			}
			continue;
		}
		if (arg === "--include-process-output") {
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--no-dry-run") {
			options.dryRun = false;
			continue;
		}
		if (arg === "--virtuoso-bin") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--virtuoso-bin requires a value." };
			}
			options.virtuosoBin = value;
			continue;
		}
		if (arg === "--bridge-path") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--bridge-path requires a value." };
			}
			options.bridgePath = value;
			continue;
		}
		if (arg === "--work-dir") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--work-dir requires a value." };
			}
			options.workDir = value;
			continue;
		}
		if (arg === "--cds-lib") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--cds-lib requires a value." };
			}
			options.cdsLib = value;
			continue;
		}
		if (arg === "--display") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--display requires a value." };
			}
			options.display = value;
			continue;
		}
		if (arg === "--xauthority") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--xauthority requires a value." };
			}
			options.xAuthority = value;
			continue;
		}
		if (arg === "--wayland-display") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--wayland-display requires a value." };
			}
			options.waylandDisplay = value;
			continue;
		}
		if (arg === "--xdg-runtime-dir") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--xdg-runtime-dir requires a value." };
			}
			options.xdgRuntimeDir = value;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--timeout-ms requires a value." };
			}
			const timeoutMs = Number(value);
			if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
				return { ok: false, error: "--timeout-ms must be a non-negative number." };
			}
			options.timeoutMs = timeoutMs;
			continue;
		}
		return { ok: false, error: `Unknown Virtuoso bridge option: ${arg}` };
	}

	return { ok: true, value: options };
}

function getOptionValue(argv: string[], option: string): string | undefined {
	const index = argv.indexOf(option);
	if (index === -1) {
		return undefined;
	}
	const value = argv[index + 1];
	if (!value || value.startsWith("-")) {
		return undefined;
	}
	return value;
}

function writeJson(io: CliIo, value: unknown, includeProcessOutput: boolean): void {
	io.stdout(JSON.stringify(compactAgentOutput(value, { includeProcessOutput }), null, 2));
}

function writeUsage(io: CliIo): void {
	io.stderr("Usage:");
	io.stderr(
		"  vab session start --json [--cds-lib <path>] [--session-dir <dir>] [--work-dir <dir>] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
	);
	io.stderr(
		"  vab session cellview show --session-dir <dir> --lib <lib> --cell <cell> --view <view> --json [--mode r|a|w] [--include-process-output]",
	);
	io.stderr(
		"  vab inventory libraries --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
	);
	io.stderr(
		"  vab inventory cellviews --lib <lib> --json [--cds-lib <path>] [--dry-run] [--virtuoso-bin <path>] [--bridge-path <path>] [--include-process-output]",
	);
	io.stderr(
		"  vab maestro inspect --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--dry-run] [--include-process-output]",
	);
	io.stderr(
		"  vab cellview open --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
	);
	io.stderr("  vab cellview current --json [--cds-lib <path>] [--dry-run] [--include-process-output]");
	io.stderr(
		"  vab cellview instances --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
	);
	io.stderr(
		"  vab cellview summary --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
	);
	io.stderr(
		"  vab cellview show --lib <lib> --cell <cell> --view <view> --json [--cds-lib <path>] [--mode r|a|w] [--display <display>] [--xauthority <path>] [--dry-run] [--include-process-output]",
	);
	io.stderr(
		"  vab instance params --lib <lib> --cell <cell> --view <view> --name <instance> --json [--cds-lib <path>] [--mode r|a|w] [--dry-run] [--include-process-output]",
	);
	io.stderr("  vab task validate <task.json> --json");
	io.stderr(
		"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>] [--include-process-output]",
	);
}
