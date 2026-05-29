/**
 * Virtuoso Agent CLI command runner.
 *
 * 这个文件的职责是“解释 CLI 参数，并把工作委托给 runtime”。
 * 它不直接连接 Virtuoso，也不解析 Spectre/OCEAN 日志，因为这些能力属于
 * `src/runtime`。保持这个边界后，同一套 runtime 将来可以被 pi extension、
 * Codex、Claude Code、shell 脚本或其它 agent adapter 复用。
 */

import { getVirtuosoStatus, type RunTaskOptions, runTask, validateTaskFile } from "../index.ts";

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
 * - `vab status --json`
 * - `vab task validate <task.json> --json`
 * - `vab run <task.json> --json`
 *
 * 注意：这里暂时没有拆出 `args.ts`。命令数量还很少，提前引入一套参数解析层
 * 会让结构变重。等后续出现更多 option，例如 `--dry-run`、`--job-dir`、
 * `--backend spectre`，再拆 `src/cli/args.ts` 会更自然。
 */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
	if (isStatusCommand(argv)) {
		const status = await getVirtuosoStatus();
		writeJson(io, { ok: true, value: status });
		return 0;
	}

	const taskValidatePath = getTaskValidatePath(argv);
	if (taskValidatePath) {
		const result = await validateTaskFile(taskValidatePath);
		writeJson(io, result);
		return result.ok && result.value.issues.length === 0 ? 0 : 1;
	}

	const runCommand = parseRunTaskCommand(argv);
	if (runCommand.ok) {
		const result = await runTask(runCommand.path, runCommand.options);
		writeJson(io, result);
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

function isStatusCommand(argv: string[]): boolean {
	const [command] = argv;
	return command === "status";
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

function parseRunTaskOptions(args: string[]): { ok: true; value: RunTaskOptions } | IgnoredRunTaskCommand {
	const options: RunTaskOptions = {};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") {
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

function writeJson(io: CliIo, value: unknown): void {
	io.stdout(JSON.stringify(value, null, 2));
}

function writeUsage(io: CliIo): void {
	io.stderr("Usage:");
	io.stderr("  vab status --json");
	io.stderr("  vab task validate <task.json> --json");
	io.stderr("  vab run <task.json> --json [--dry-run|--no-dry-run] [--spectre-bin <path>] [--jobs-root <dir>]");
}
