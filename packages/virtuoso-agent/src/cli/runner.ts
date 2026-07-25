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
	getManagedCurrentCellView,
	getManagedVirtuosoInstanceParameters,
	getManagedVirtuosoInstances,
	inspectManagedVirtuosoMaestro,
	inspectManagedVirtuosoSchematic,
	listManagedVirtuosoCellViewInstances,
	listManagedVirtuosoLibraries,
	listManagedVirtuosoLibraryCellViews,
	type ManagedVirtuosoRequest,
	type RunTaskOptions,
	runTask,
	showManagedVirtuosoCellView,
	showVirtuosoCellViewInSession,
	startVirtuosoUiSession,
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
 * 这里仍然只负责命令解析和结果呈现。读取 Virtuoso 状态的命令默认复用
 * managed session；task 执行、桥接和结果校验继续由 runtime 负责。
 *
 * 参数解析暂时保留在本文件。等 option 和子命令继续增长时，再把纯解析逻辑
 * 移入 `src/cli/args.ts`，不会改变 runtime API。
 */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		writeUsage(io, true);
		return 0;
	}
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

	const sessionListCommand = parseSessionListCommand(argv);
	if (sessionListCommand.ok) {
		const result = await getManagedVirtuosoInstances({ registryDir: sessionListCommand.registryDir });
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (sessionListCommand.error) {
		io.stderr(`Error: ${sessionListCommand.error}`);
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
		const result = await showManagedVirtuosoCellView(openCellViewCommand.request);
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
		const result = await getManagedCurrentCellView(currentCellViewCommand.options);
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
		const result = await listManagedVirtuosoLibraries(inventoryLibrariesCommand.options);
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
		const result = await listManagedVirtuosoLibraryCellViews(inventoryCellViewsCommand.request);
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
		const result = await inspectManagedVirtuosoMaestro(maestroInspectCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (maestroInspectCommand.error) {
		io.stderr(`Error: ${maestroInspectCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const schematicInspectCommand = parseSchematicInspectCommand(argv);
	if (schematicInspectCommand.ok) {
		const result = await inspectManagedVirtuosoSchematic(schematicInspectCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (schematicInspectCommand.error) {
		io.stderr(`Error: ${schematicInspectCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const listInstancesCommand = parseListInstancesCommand(argv);
	if (listInstancesCommand.ok) {
		const result = await listManagedVirtuosoCellViewInstances(listInstancesCommand.request);
		writeJson(io, result, includeProcessOutput);
		return result.ok ? 0 : 1;
	}
	if (listInstancesCommand.error) {
		io.stderr(`Error: ${listInstancesCommand.error}`);
		writeUsage(io);
		return 1;
	}

	const instanceParametersCommand = parseInstanceParametersCommand(argv);
	if (instanceParametersCommand.ok) {
		const result = await getManagedVirtuosoInstanceParameters(instanceParametersCommand.request);
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
		const result = await showManagedVirtuosoCellView(showCellViewCommand.request);
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

interface ParsedSessionListCommand {
	ok: true;
	registryDir?: string;
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
	request: ManagedVirtuosoRequest & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedShowCellViewCommand {
	ok: true;
	request: ManagedVirtuosoRequest & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedCurrentCellViewCommand {
	ok: true;
	options: ManagedVirtuosoRequest;
}

interface ParsedInventoryLibrariesCommand {
	ok: true;
	options: ManagedVirtuosoRequest;
}

interface ParsedInventoryCellViewsCommand {
	ok: true;
	request: ManagedVirtuosoRequest & {
		library: string;
	};
}

interface ParsedInspectCellViewCommand {
	ok: true;
	request: ManagedVirtuosoRequest & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedListInstancesCommand {
	ok: true;
	request: ManagedVirtuosoRequest & {
		library: string;
		cell: string;
		view: string;
		mode?: "r" | "a" | "w";
	};
}

interface ParsedInstanceParametersCommand {
	ok: true;
	request: ManagedVirtuosoRequest & {
		library: string;
		cell: string;
		view: string;
		instanceName: string;
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
			instanceId: getOptionValue(argv, "--instance-id"),
			registryDir: getOptionValue(argv, "--registry-dir"),
		},
	};
}

function parseSessionListCommand(argv: string[]): ParsedSessionListCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "session" || action !== "list") {
		return { ok: false };
	}
	const options = parseManagedVirtuosoOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	return { ok: true, registryDir: options.value.registryDir };
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
	return parseManagedCellViewRefCommand(argv, "cellview open");
}

function parseCurrentCellViewCommand(argv: string[]): ParsedCurrentCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "current") {
		return { ok: false };
	}
	const options = parseManagedVirtuosoOptions(argv.slice(2));
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
	const options = parseManagedVirtuosoOptions(argv.slice(2));
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
	const options = parseManagedVirtuosoOptions(argv.slice(2));
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
	return parseManagedCellViewRefCommand(argv, "maestro inspect");
}

function parseSchematicInspectCommand(argv: string[]): ParsedInspectCellViewCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "schematic" || action !== "inspect") {
		return { ok: false };
	}
	return parseManagedCellViewRefCommand(argv, "schematic inspect");
}

function parseListInstancesCommand(argv: string[]): ParsedListInstancesCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "cellview" || action !== "instances") {
		return { ok: false };
	}
	return parseManagedCellViewRefCommand(argv, "cellview instances");
}

function parseInstanceParametersCommand(argv: string[]): ParsedInstanceParametersCommand | IgnoredCommand {
	const [command, action] = argv;
	if (command !== "instance" || action !== "params") {
		return { ok: false };
	}
	const parsed = parseManagedCellViewRefCommand(argv, "instance params");
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
	return parseManagedCellViewRefCommand(argv, "cellview show");
}

function parseManagedCellViewRefCommand(argv: string[], label: string): ParsedInspectCellViewCommand | IgnoredCommand {
	const options = parseManagedVirtuosoOptions(argv.slice(2));
	if (!options.ok) {
		return options;
	}
	return createParsedCellViewRef(argv, label, options.value);
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
	return createParsedCellViewRef(argv, label, options.value);
}

function createParsedCellViewRef<TOptions extends ManagedVirtuosoRequest | VirtuosoBridgeOptions>(
	argv: string[],
	label: string,
	options: TOptions,
):
	| { ok: true; request: TOptions & { library: string; cell: string; view: string; mode?: "r" | "a" | "w" } }
	| IgnoredCommand {
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
			...options,
			library,
			cell,
			view,
			mode,
		},
	};
}

function parseManagedVirtuosoOptions(args: string[]): { ok: true; value: ManagedVirtuosoRequest } | IgnoredCommand {
	const options: ManagedVirtuosoRequest = {};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--lib" || arg === "--cell" || arg === "--view" || arg === "--mode" || arg === "--name") {
			index++;
			continue;
		}
		if (arg === "--json" || arg === "--include-process-output") {
			continue;
		}
		if (arg === "--instance-id") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--instance-id requires a value." };
			}
			options.instanceId = value;
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
		if (arg === "--registry-dir") {
			const value = args[++index];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "--registry-dir requires a value." };
			}
			options.registryDir = value;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = args[++index];
			const timeoutMs = Number(value);
			if (!value || value.startsWith("-") || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
				return { ok: false, error: "--timeout-ms must be a non-negative number." };
			}
			options.timeoutMs = timeoutMs;
			continue;
		}
		return { ok: false, error: `Unknown managed Virtuoso option: ${arg}` };
	}

	return { ok: true, value: options };
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
			arg === "--result-file" ||
			arg === "--instance-id" ||
			arg === "--registry-dir"
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

function writeUsage(io: CliIo, toStdout = false): void {
	const write = toStdout ? io.stdout.bind(io) : io.stderr.bind(io);
	write("Usage:");
	write(
		"  vab session start --json [--cds-lib <path>] [--session-dir <dir>] [--instance-id <id>] [--registry-dir <dir>] [--work-dir <dir>] [--display <display>] [--xauthority <path>] [--dry-run]",
	);
	write("  vab session list --json [--registry-dir <dir>]");
	write(
		"  vab session cellview show --session-dir <dir> --lib <lib> --cell <cell> --view <view> --json [--mode r|a|w] [--include-process-output]",
	);
	write(
		"  vab inventory libraries --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--timeout-ms <ms>]",
	);
	write(
		"  vab inventory cellviews --lib <lib> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--timeout-ms <ms>]",
	);
	write(
		"  vab maestro inspect --lib <lib> --cell <cell> --view <view> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--timeout-ms <ms>]",
	);
	write(
		"  vab schematic inspect --lib <lib> --cell <cell> --view <view> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--timeout-ms <ms>]",
	);
	write(
		"  vab cellview open --lib <lib> --cell <cell> --view <view> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--mode r|a|w] [--timeout-ms <ms>]",
	);
	write(
		"  vab cellview current --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--timeout-ms <ms>]",
	);
	write(
		"  vab cellview instances --lib <lib> --cell <cell> --view <view> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--mode r|a|w] [--timeout-ms <ms>]",
	);
	write(
		"  vab cellview show --lib <lib> --cell <cell> --view <view> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--mode r|a|w] [--timeout-ms <ms>]",
	);
	write(
		"  vab instance params --lib <lib> --cell <cell> --view <view> --name <instance> --json [--instance-id <id>] [--cds-lib <path>] [--registry-dir <dir>] [--mode r|a|w] [--timeout-ms <ms>]",
	);
	write("  vab task validate <task.json> --json");
	write(
		"  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>] [--include-process-output]",
	);
}
