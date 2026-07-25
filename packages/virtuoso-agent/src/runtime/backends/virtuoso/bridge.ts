import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProcessExecutor, type ProcessRunResult, runProcess } from "../../core/process-runner.ts";
import { fail, ok, type RuntimeResult } from "../../core/result.ts";
import {
	getDefaultVirtuosoInstanceRegistryDir,
	registerManagedVirtuosoInstance,
	validateManagedVirtuosoInstanceId,
} from "./instance-registry.ts";

export interface VirtuosoBridgeRunRequest {
	expression: string;
	bridgePath?: string;
	virtuosoBin?: string;
	workDir?: string;
	cdsLib?: string;
	timeoutMs?: number;
	dryRun?: boolean;
	executor?: ProcessExecutor;
}

export interface VirtuosoBridgeUiRequest {
	expression: string;
	bridgePath?: string;
	virtuosoBin?: string;
	workDir?: string;
	cdsLib?: string;
	display?: string;
	xAuthority?: string;
	waylandDisplay?: string;
	xdgRuntimeDir?: string;
	dryRun?: boolean;
	launcher?: VirtuosoUiLauncher;
	displayProbe?: VirtuosoDisplayProbe;
}

export interface VirtuosoBridgeSessionStartRequest {
	bridgePath?: string;
	virtuosoBin?: string;
	workDir?: string;
	cdsLib?: string;
	sessionDir?: string;
	display?: string;
	xAuthority?: string;
	waylandDisplay?: string;
	xdgRuntimeDir?: string;
	dryRun?: boolean;
	launcher?: VirtuosoUiLauncher;
	displayProbe?: VirtuosoDisplayProbe;
	instanceId?: string;
	registryDir?: string;
	readyTimeoutMs?: number;
}

export interface VirtuosoBridgeSessionCommandRequest {
	sessionDir: string;
	expression: string;
	resultFileName?: string;
}

export interface VirtuosoBridgeSessionExecuteRequest {
	sessionDir: string;
	heartbeatPath: string;
	expression(resultPath: string): string;
	resultFileName?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface VirtuosoBridgeRunResult<TValue> {
	value: TValue;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
}

export interface VirtuosoBridgeSessionStartResult extends VirtuosoUiLaunchResult {
	instanceId: string;
	sessionDir: string;
	commandDir: string;
	resultDir: string;
	processedDir: string;
	metadataPath: string;
	readyPath: string;
	heartbeatPath: string;
	registryPath?: string;
	cdsLib?: string;
}

export interface VirtuosoBridgeSessionCommandResult {
	sessionDir: string;
	commandPath: string;
	resultPath: string;
	queuedAt: string;
}

export interface VirtuosoBridgeSessionExecutionResult<TValue> extends VirtuosoBridgeSessionCommandResult {
	value: TValue;
	completedAt: string;
}

export interface VirtuosoUiLaunchResult {
	command: string[];
	cwd: string;
	pid?: number;
	startedAt: string;
	detached: true;
	dryRun: boolean;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
	stdoutLogPath?: string;
	stderrLogPath?: string;
}

export interface VirtuosoUiLauncher {
	start(request: RequiredVirtuosoUiLaunchRequest): Promise<Omit<VirtuosoUiLaunchResult, "scriptPath" | "bridgePath">>;
}

export interface VirtuosoDesktopEnvironment {
	display: string;
	xAuthority?: string;
	waylandDisplay?: string;
	xdgRuntimeDir?: string;
}

export interface VirtuosoDisplayProbe {
	check(environment: VirtuosoDesktopEnvironment): Promise<{ ok: boolean; message?: string }>;
}

export interface RequiredVirtuosoUiLaunchRequest {
	command: string;
	args: string[];
	cwd: string;
	desktopEnvironment: VirtuosoDesktopEnvironment;
	dryRun: boolean;
}

interface BridgeEnvelope<TValue> {
	ok: boolean;
	value?: TValue;
	error?: {
		type?: string;
		message?: string;
	};
}

export function getDefaultVirtuosoBridgePath(): string {
	return fileURLToPath(new URL("../../../../skill-runtime/bridge.il", import.meta.url));
}

export async function runVirtuosoBridgeExpression<TValue>(
	request: VirtuosoBridgeRunRequest,
): Promise<RuntimeResult<VirtuosoBridgeRunResult<TValue>>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const launchContext = await resolveVirtuosoLaunchContext(request);
	if (!launchContext.ok) {
		return launchContext;
	}
	const script = await createVirtuosoBridgeScript({
		bridgePath,
		cdsLib: launchContext.value.cdsLib,
		expression: request.expression,
		workDir: launchContext.value.workDir,
		exitAfterExpression: true,
	});
	if (!script.ok) {
		return script;
	}

	const processResult = await runProcess(
		{
			command: request.virtuosoBin ?? "virtuoso",
			args: ["-nograph", "-restore", script.value.scriptPath],
			cwd: script.value.workDir,
			timeoutMs: request.timeoutMs,
			dryRun: request.dryRun,
		},
		{ executor: request.executor },
	);
	if (!processResult.ok) {
		return processResult;
	}
	if (processResult.value.dryRun) {
		return ok({
			value: undefined as TValue,
			process: processResult.value,
			scriptPath: script.value.scriptPath,
			bridgePath,
			cdsLib: launchContext.value.cdsLib,
		});
	}

	const envelope = parseBridgeEnvelope<TValue>(processResult.value.stdout);
	if (envelope.ok) {
		return ok({
			value: envelope.value,
			process: processResult.value,
			scriptPath: script.value.scriptPath,
			bridgePath,
			cdsLib: launchContext.value.cdsLib,
		});
	}
	if (processResult.value.exitCode !== 0) {
		return fail({
			type: "virtuoso_process_error",
			stage: "virtuoso_bridge_run",
			message: `Virtuoso exited with code ${processResult.value.exitCode} before returning a complete bridge result.`,
			details: { process: processResult.value, scriptPath: script.value.scriptPath, bridgePath },
		});
	}
	return envelope;
}

export async function startVirtuosoBridgeUi(
	request: VirtuosoBridgeUiRequest,
): Promise<RuntimeResult<VirtuosoUiLaunchResult>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const launchContext = await resolveVirtuosoLaunchContext(request);
	if (!launchContext.ok) {
		return launchContext;
	}
	const desktopEnvironment = await resolveVirtuosoDesktopEnvironment(request, "virtuoso_ui_launch");
	if (!desktopEnvironment.ok) {
		return desktopEnvironment;
	}
	const script = await createVirtuosoBridgeScript({
		bridgePath,
		cdsLib: launchContext.value.cdsLib,
		expression: request.expression,
		workDir: launchContext.value.workDir,
		exitAfterExpression: false,
	});
	if (!script.ok) {
		return script;
	}

	const command = request.virtuosoBin ?? "virtuoso";
	const launchRequest: RequiredVirtuosoUiLaunchRequest = {
		command,
		args: ["-restore", script.value.scriptPath],
		cwd: script.value.workDir,
		desktopEnvironment: desktopEnvironment.value,
		dryRun: request.dryRun ?? false,
	};
	const launcher = request.launcher ?? nodeVirtuosoUiLauncher;

	try {
		const launched = launchRequest.dryRun
			? createDryRunUiLaunchResult(launchRequest)
			: await launcher.start(launchRequest);
		return ok({
			...launched,
			scriptPath: script.value.scriptPath,
			bridgePath,
			cdsLib: launchContext.value.cdsLib,
		});
	} catch (error) {
		return fail({
			type: "virtuoso_ui_launch_error",
			stage: "virtuoso_ui_launch",
			message: error instanceof Error ? error.message : String(error),
			details: {
				command: [launchRequest.command, ...launchRequest.args],
				cwd: launchRequest.cwd,
				scriptPath: script.value.scriptPath,
				bridgePath,
			},
		});
	}
}

export async function startVirtuosoBridgeSession(
	request: VirtuosoBridgeSessionStartRequest,
): Promise<RuntimeResult<VirtuosoBridgeSessionStartResult>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const launchContext = await resolveVirtuosoLaunchContext(request, "virtuoso-agent-session-work-");
	if (!launchContext.ok) {
		return launchContext;
	}
	const workDir = launchContext.value.workDir;
	const desktopEnvironment = await resolveVirtuosoDesktopEnvironment(request, "virtuoso_session_start");
	if (!desktopEnvironment.ok) {
		return desktopEnvironment;
	}
	const instanceId = request.instanceId ?? `vui-${randomUUID()}`;
	const validatedInstanceId = validateManagedVirtuosoInstanceId(instanceId);
	if (!validatedInstanceId.ok) {
		return validatedInstanceId;
	}
	const sessionDir = request.sessionDir ?? join(workDir, ".virtuoso-agent", "instances", instanceId);
	const dirs = await prepareVirtuosoSessionDirs(sessionDir);
	if (!dirs.ok) {
		return dirs;
	}
	const metadata = await writeVirtuosoSessionMetadata({
		sessionDir,
		workDir,
		cdsLib: launchContext.value.cdsLib,
	});
	if (!metadata.ok) {
		return metadata;
	}

	const readyPath = join(sessionDir, "ready.json");
	const heartbeatPath = join(sessionDir, "heartbeat.json");
	const script = await createVirtuosoBridgeScript({
		bridgePath,
		cdsLib: launchContext.value.cdsLib,
		expression: `vaStartSessionBridge(${skillString(sessionDir)} ${skillString(readyPath)} ${skillString(heartbeatPath)})`,
		workDir,
		exitAfterExpression: false,
	});
	if (!script.ok) {
		return script;
	}

	const command = request.virtuosoBin ?? "virtuoso";
	const launchRequest: RequiredVirtuosoUiLaunchRequest = {
		command,
		args: ["-restore", script.value.scriptPath],
		cwd: script.value.workDir,
		desktopEnvironment: desktopEnvironment.value,
		dryRun: request.dryRun ?? false,
	};
	const launcher = request.launcher ?? nodeVirtuosoUiLauncher;

	try {
		const launched = launchRequest.dryRun
			? createDryRunUiLaunchResult(launchRequest)
			: await launcher.start(launchRequest);
		let registryPath: string | undefined;
		if (!launchRequest.dryRun) {
			const registration = await registerManagedVirtuosoInstance(
				{
					protocolVersion: 1,
					instanceId,
					pid: launched.pid,
					processStartedAt: launched.startedAt,
					mode: "ui",
					state: "starting",
					cwd: launched.cwd,
					cdsLib: launchContext.value.cdsLib,
					display: desktopEnvironment.value.display,
					sessionDir,
					commandDir: dirs.value.commandDir,
					resultDir: dirs.value.resultDir,
					processedDir: dirs.value.processedDir,
					readyPath,
					heartbeatPath,
					bridgePath,
				},
				request.registryDir ?? getDefaultVirtuosoInstanceRegistryDir(),
			);
			if (!registration.ok) {
				return registration;
			}
			registryPath = registration.value.path;
			const ready = await waitForFile(readyPath, request.readyTimeoutMs ?? 60_000);
			if (!ready.ok) {
				return ready;
			}
			const readyRegistration = await registerManagedVirtuosoInstance(
				{
					protocolVersion: 1,
					instanceId,
					pid: launched.pid,
					processStartedAt: launched.startedAt,
					mode: "ui",
					state: "ready",
					cwd: launched.cwd,
					cdsLib: launchContext.value.cdsLib,
					display: desktopEnvironment.value.display,
					sessionDir,
					commandDir: dirs.value.commandDir,
					resultDir: dirs.value.resultDir,
					processedDir: dirs.value.processedDir,
					readyPath,
					heartbeatPath,
					bridgePath,
				},
				request.registryDir ?? getDefaultVirtuosoInstanceRegistryDir(),
			);
			if (!readyRegistration.ok) {
				return readyRegistration;
			}
		}
		return ok({
			...launched,
			instanceId,
			sessionDir,
			commandDir: dirs.value.commandDir,
			resultDir: dirs.value.resultDir,
			processedDir: dirs.value.processedDir,
			metadataPath: metadata.value.metadataPath,
			readyPath,
			heartbeatPath,
			registryPath,
			cdsLib: launchContext.value.cdsLib,
			scriptPath: script.value.scriptPath,
			bridgePath,
		});
	} catch (error) {
		return fail({
			type: "virtuoso_session_launch_error",
			stage: "virtuoso_session_start",
			message: error instanceof Error ? error.message : String(error),
			details: {
				command: [launchRequest.command, ...launchRequest.args],
				cwd: launchRequest.cwd,
				sessionDir,
				scriptPath: script.value.scriptPath,
				bridgePath,
			},
		});
	}
}

export async function enqueueVirtuosoBridgeSessionCommand(
	request: VirtuosoBridgeSessionCommandRequest,
): Promise<RuntimeResult<VirtuosoBridgeSessionCommandResult>> {
	const dirs = await prepareVirtuosoSessionDirs(request.sessionDir);
	if (!dirs.ok) {
		return dirs;
	}
	const resultFileName = normalizeSessionResultFileName(request.resultFileName ?? `${randomUUID()}.json`);
	if (!resultFileName.ok) {
		return resultFileName;
	}
	const commandFileName = `${resultFileName.value.slice(0, -".json".length)}.il`;
	const commandPath = join(dirs.value.commandDir, commandFileName);
	const temporaryCommandPath = `${commandPath}.tmp`;
	const resultPath = join(dirs.value.resultDir, resultFileName.value);
	try {
		await stat(resultPath);
		return fail({
			type: "virtuoso_session_result_conflict",
			stage: "virtuoso_session_enqueue",
			message: `Managed Virtuoso result already exists: ${resultFileName.value}`,
			details: { sessionDir: request.sessionDir, resultPath },
		});
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			return fail({
				type: "virtuoso_session_result_check_error",
				stage: "virtuoso_session_enqueue",
				message: error instanceof Error ? error.message : String(error),
				details: { sessionDir: request.sessionDir, resultPath },
			});
		}
	}
	try {
		await writeFile(
			temporaryCommandPath,
			[`; Generated by virtuoso-agent session bridge.`, request.expression, ""].join("\n"),
			"utf8",
		);
		await rename(temporaryCommandPath, commandPath);
		return ok({
			sessionDir: request.sessionDir,
			commandPath,
			resultPath,
			queuedAt: new Date().toISOString(),
		});
	} catch (error) {
		return fail({
			type: "virtuoso_session_command_write_error",
			stage: "virtuoso_session_enqueue",
			message: error instanceof Error ? error.message : String(error),
			details: { sessionDir: request.sessionDir, commandPath, resultPath },
		});
	}
}

export async function executeVirtuosoBridgeSessionCommand<TValue>(
	request: VirtuosoBridgeSessionExecuteRequest,
): Promise<RuntimeResult<VirtuosoBridgeSessionExecutionResult<TValue>>> {
	const normalizedResultFileName = normalizeSessionResultFileName(request.resultFileName ?? `${randomUUID()}.json`);
	if (!normalizedResultFileName.ok) {
		return normalizedResultFileName;
	}
	const resultPath = join(request.sessionDir, "results", normalizedResultFileName.value);
	const queued = await enqueueVirtuosoBridgeSessionCommand({
		sessionDir: request.sessionDir,
		resultFileName: normalizedResultFileName.value,
		expression: request.expression(resultPath),
	});
	if (!queued.ok) {
		return queued;
	}

	const timeoutMs = request.timeoutMs ?? 120_000;
	const pollIntervalMs = request.pollIntervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const parsed = await readBridgeResult<TValue>(queued.value.resultPath);
		if (parsed !== undefined) {
			if (!parsed.ok) {
				return parsed;
			}
			return ok({ ...queued.value, value: parsed.value, completedAt: new Date().toISOString() });
		}
		const heartbeat = await fileAgeMs(request.heartbeatPath);
		if (heartbeat === undefined || heartbeat > 15_000) {
			return fail({
				type: "virtuoso_instance_lost",
				stage: "virtuoso_session_execute",
				message: "Managed Virtuoso instance stopped updating its heartbeat before the operation completed.",
				details: { sessionDir: request.sessionDir, heartbeatPath: request.heartbeatPath },
			});
		}
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
	}
	return fail({
		type: "virtuoso_session_command_timeout",
		stage: "virtuoso_session_execute",
		message: `Timed out after ${timeoutMs} ms waiting for the managed Virtuoso result.`,
		details: { sessionDir: request.sessionDir, resultPath: queued.value.resultPath },
	});
}

function normalizeSessionResultFileName(value: string): RuntimeResult<string> {
	const fileName = value.endsWith(".json") ? value : `${value}.json`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.json$/.test(fileName)) {
		return fail({
			type: "virtuoso_session_result_name_invalid",
			stage: "virtuoso_session_validation",
			message:
				"Managed Virtuoso resultFileName must be a single safe JSON file name using only letters, numbers, dots, underscores, or hyphens.",
			details: { resultFileName: value },
		});
	}
	return ok(fileName);
}

async function resolveVirtuosoLaunchContext(
	request: { workDir?: string; cdsLib?: string },
	tmpPrefix = "virtuoso-agent-bridge-",
): Promise<RuntimeResult<{ workDir: string; cdsLib?: string }>> {
	if (!request.cdsLib) {
		return ok({ workDir: request.workDir ?? (await mkdtemp(join(tmpdir(), tmpPrefix))) });
	}

	const cdsLib = resolve(request.cdsLib);
	try {
		const file = await stat(cdsLib);
		if (!file.isFile()) {
			return fail({
				type: "cds_lib_invalid",
				stage: "virtuoso_launch_context",
				message: `cds.lib path is not a file: ${cdsLib}`,
				details: { cdsLib },
			});
		}
	} catch (error) {
		return fail({
			type: "cds_lib_not_found",
			stage: "virtuoso_launch_context",
			message: error instanceof Error ? error.message : String(error),
			details: { cdsLib },
		});
	}

	return ok({
		cdsLib,
		workDir: request.workDir ?? dirname(cdsLib),
	});
}

async function writeVirtuosoSessionMetadata(request: {
	sessionDir: string;
	workDir: string;
	cdsLib?: string;
}): Promise<RuntimeResult<{ metadataPath: string }>> {
	const metadataPath = join(request.sessionDir, "metadata.json");
	try {
		await writeFile(
			metadataPath,
			`${JSON.stringify(
				{
					workDir: request.workDir,
					cdsLib: request.cdsLib,
					createdAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		return ok({ metadataPath });
	} catch (error) {
		return fail({
			type: "virtuoso_session_metadata_write_error",
			stage: "virtuoso_session_start",
			message: error instanceof Error ? error.message : String(error),
			details: { sessionDir: request.sessionDir, metadataPath },
		});
	}
}

export function skillString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function prepareVirtuosoSessionDirs(sessionDir: string): Promise<
	RuntimeResult<{
		commandDir: string;
		resultDir: string;
		processedDir: string;
	}>
> {
	const commandDir = join(sessionDir, "commands");
	const resultDir = join(sessionDir, "results");
	const processedDir = join(sessionDir, "processed");
	try {
		await mkdir(commandDir, { recursive: true });
		await mkdir(resultDir, { recursive: true });
		await mkdir(processedDir, { recursive: true });
		return ok({ commandDir, resultDir, processedDir });
	} catch (error) {
		return fail({
			type: "virtuoso_session_prepare_error",
			stage: "virtuoso_session_prepare",
			message: error instanceof Error ? error.message : String(error),
			details: { sessionDir, commandDir, resultDir, processedDir },
		});
	}
}

async function createVirtuosoBridgeScript(request: {
	bridgePath: string;
	cdsLib?: string;
	expression: string;
	workDir?: string;
	exitAfterExpression: boolean;
}): Promise<RuntimeResult<{ scriptPath: string; workDir: string }>> {
	try {
		const workDir = request.workDir ?? (await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-")));
		const scriptPath = join(workDir, `bridge-call-${randomUUID()}.il`);
		await writeFile(
			scriptPath,
			[
				`; Generated by virtuoso-agent. Do not edit.`,
				...(request.cdsLib ? [`ddSetForcedLib(${skillString(request.cdsLib)})`, "ddUpdateLibList()"] : []),
				`load(${skillString(request.bridgePath)})`,
				request.expression,
				...(request.exitAfterExpression ? ["exit()"] : []),
				"",
			].join("\n"),
			"utf8",
		);
		return ok({ scriptPath, workDir });
	} catch (error) {
		return fail({
			type: "virtuoso_bridge_script_error",
			stage: "virtuoso_bridge_prepare",
			message: error instanceof Error ? error.message : String(error),
			details: { bridgePath: request.bridgePath, workDir: request.workDir },
		});
	}
}

function createDryRunUiLaunchResult(
	request: RequiredVirtuosoUiLaunchRequest,
): Omit<VirtuosoUiLaunchResult, "scriptPath" | "bridgePath"> {
	return {
		command: [request.command, ...request.args],
		cwd: request.cwd,
		startedAt: new Date().toISOString(),
		detached: true,
		dryRun: true,
		stdoutLogPath: join(request.cwd, "virtuoso-ui.stdout.log"),
		stderrLogPath: join(request.cwd, "virtuoso-ui.stderr.log"),
	};
}

const nodeVirtuosoUiLauncher: VirtuosoUiLauncher = {
	async start(request) {
		const stdoutLogPath = join(request.cwd, "virtuoso-ui.stdout.log");
		const stderrLogPath = join(request.cwd, "virtuoso-ui.stderr.log");
		const stdoutFd = openSync(stdoutLogPath, "a");
		const stderrFd = openSync(stderrLogPath, "a");
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			detached: true,
			env: desktopProcessEnvironment(request.desktopEnvironment),
			stdio: ["ignore", stdoutFd, stderrFd],
		});
		closeSync(stdoutFd);
		closeSync(stderrFd);
		child.unref();
		return {
			command: [request.command, ...request.args],
			cwd: request.cwd,
			pid: child.pid,
			startedAt: new Date().toISOString(),
			detached: true,
			dryRun: false,
			stdoutLogPath,
			stderrLogPath,
		};
	},
};

async function resolveVirtuosoDesktopEnvironment(
	request: {
		display?: string;
		xAuthority?: string;
		waylandDisplay?: string;
		xdgRuntimeDir?: string;
		dryRun?: boolean;
		displayProbe?: VirtuosoDisplayProbe;
	},
	stage: string,
): Promise<RuntimeResult<VirtuosoDesktopEnvironment>> {
	const display = request.display ?? process.env.DISPLAY;
	if (!display) {
		if (request.dryRun) {
			return ok({ display: "<DISPLAY>" });
		}
		return fail({
			type: "virtuoso_display_not_configured",
			stage,
			message:
				"No DISPLAY was inherited by pi. Start pi from the graphical desktop session or pass both display and the matching X authority explicitly.",
			details: {
				xdgSessionType: process.env.XDG_SESSION_TYPE,
				waylandDisplay: request.waylandDisplay ?? process.env.WAYLAND_DISPLAY,
			},
		});
	}
	const environment: VirtuosoDesktopEnvironment = {
		display,
		xAuthority: request.xAuthority ?? process.env.XAUTHORITY,
		waylandDisplay: request.waylandDisplay ?? process.env.WAYLAND_DISPLAY,
		xdgRuntimeDir: request.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR,
	};
	if (request.dryRun) {
		return ok(environment);
	}
	const probe = await (request.displayProbe ?? xdpyinfoDisplayProbe).check(environment);
	if (!probe.ok) {
		return fail({
			type: "virtuoso_display_unreachable",
			stage,
			message: `DISPLAY ${display} is configured but cannot be opened${probe.message ? `: ${probe.message}` : "."}`,
			details: {
				display,
				xAuthorityConfigured: Boolean(environment.xAuthority),
				waylandDisplay: environment.waylandDisplay,
				xdgRuntimeDir: environment.xdgRuntimeDir,
			},
		});
	}
	return ok(environment);
}

const xdpyinfoDisplayProbe: VirtuosoDisplayProbe = {
	check(environment) {
		return new Promise((resolvePromise) => {
			execFile(
				"xdpyinfo",
				["-display", environment.display],
				{
					env: desktopProcessEnvironment(environment),
					timeout: 5_000,
					maxBuffer: 64 * 1024,
				},
				(error, _stdout, stderr) => {
					if (!error) {
						resolvePromise({ ok: true });
						return;
					}
					const message = stderr.trim() || error.message;
					resolvePromise({ ok: false, message: message.slice(0, 500) });
				},
			);
		});
	},
};

function desktopProcessEnvironment(environment: VirtuosoDesktopEnvironment): NodeJS.ProcessEnv {
	return {
		...process.env,
		DISPLAY: environment.display,
		...(environment.xAuthority ? { XAUTHORITY: environment.xAuthority } : {}),
		...(environment.waylandDisplay ? { WAYLAND_DISPLAY: environment.waylandDisplay } : {}),
		...(environment.xdgRuntimeDir ? { XDG_RUNTIME_DIR: environment.xdgRuntimeDir } : {}),
	};
}

async function waitForFile(path: string, timeoutMs: number): Promise<RuntimeResult<void>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		try {
			await stat(path);
			return ok(undefined);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				return fail({
					type: "virtuoso_instance_ready_error",
					stage: "virtuoso_session_start",
					message: error instanceof Error ? error.message : String(error),
					details: { path },
				});
			}
		}
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	return fail({
		type: "virtuoso_instance_ready_timeout",
		stage: "virtuoso_session_start",
		message: `Timed out after ${timeoutMs} ms waiting for the Virtuoso bridge to become ready.`,
		details: { path },
	});
}

async function fileAgeMs(path: string): Promise<number | undefined> {
	try {
		const file = await stat(path);
		return Date.now() - file.mtimeMs;
	} catch {
		return undefined;
	}
}

async function readBridgeResult<TValue>(path: string): Promise<RuntimeResult<TValue> | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		return fail({
			type: "virtuoso_session_result_read_error",
			stage: "virtuoso_session_execute",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}
	let envelope: BridgeEnvelope<TValue>;
	try {
		envelope = JSON.parse(raw) as BridgeEnvelope<TValue>;
	} catch {
		return undefined;
	}
	if (!envelope.ok) {
		return fail({
			type: envelope.error?.type ?? "virtuoso_bridge_error",
			stage: "virtuoso_session_execute",
			message: envelope.error?.message ?? "Managed Virtuoso operation failed.",
			details: { path },
		});
	}
	if (envelope.value === undefined) {
		return fail({
			type: "virtuoso_session_result_invalid",
			stage: "virtuoso_session_execute",
			message: "Managed Virtuoso result did not include a value.",
			details: { path },
		});
	}
	return ok(envelope.value);
}

function parseBridgeEnvelope<TValue>(stdout: string): RuntimeResult<TValue> {
	const parsed = findLastJsonLine<BridgeEnvelope<TValue>>(stdout);
	if (!parsed.ok) {
		return parsed;
	}
	if (!parsed.value.ok) {
		return fail({
			type: parsed.value.error?.type ?? "virtuoso_bridge_error",
			stage: "virtuoso_bridge_parse",
			message: parsed.value.error?.message ?? "Virtuoso bridge returned an error.",
			details: { stdout },
		});
	}
	if (parsed.value.value === undefined) {
		return fail({
			type: "virtuoso_bridge_parse_error",
			stage: "virtuoso_bridge_parse",
			message: "Virtuoso bridge response did not include a value.",
			details: { stdout },
		});
	}
	return ok(parsed.value.value);
}

function findLastJsonLine<TValue>(stdout: string): RuntimeResult<TValue> {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{") && line.endsWith("}"));

	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			return ok(JSON.parse(lines[index]) as TValue);
		} catch {}
	}

	return fail({
		type: "virtuoso_bridge_parse_error",
		stage: "virtuoso_bridge_parse",
		message: "Could not find a JSON bridge response in Virtuoso stdout.",
		details: { stdout },
	});
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
