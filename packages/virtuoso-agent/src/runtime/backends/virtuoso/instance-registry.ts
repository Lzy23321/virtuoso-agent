import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fail, ok, type RuntimeResult } from "../../core/result.ts";

export type ManagedVirtuosoMode = "ui" | "headless";

export interface ManagedVirtuosoInstanceRecord {
	protocolVersion: 1;
	instanceId: string;
	pid?: number;
	processStartedAt: string;
	mode: ManagedVirtuosoMode;
	state: "starting" | "ready";
	cwd: string;
	cdsLib?: string;
	display?: string;
	sessionDir: string;
	commandDir: string;
	resultDir: string;
	processedDir: string;
	readyPath: string;
	heartbeatPath: string;
	bridgePath: string;
}

export interface LiveManagedVirtuosoInstance extends ManagedVirtuosoInstanceRecord {
	state: "ready";
	heartbeatAt: string;
}

export interface ManagedVirtuosoInstanceQuery {
	registryDir?: string;
	instanceId?: string;
	cdsLib?: string;
	requireUi?: boolean;
	heartbeatTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

export function getDefaultVirtuosoInstanceRegistryDir(): string {
	return join(homedir(), ".virtuoso-agent", "instances");
}

export async function registerManagedVirtuosoInstance(
	record: ManagedVirtuosoInstanceRecord,
	registryDir = getDefaultVirtuosoInstanceRegistryDir(),
): Promise<RuntimeResult<{ path: string }>> {
	const path = join(registryDir, `${record.instanceId}.json`);
	const temporaryPath = `${path}.tmp`;
	try {
		await mkdir(registryDir, { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
		return ok({ path });
	} catch (error) {
		return fail({
			type: "virtuoso_instance_register_error",
			stage: "virtuoso_instance_register",
			message: error instanceof Error ? error.message : String(error),
			details: { instanceId: record.instanceId, path },
		});
	}
}

export async function listManagedVirtuosoInstances(
	query: ManagedVirtuosoInstanceQuery = {},
): Promise<RuntimeResult<LiveManagedVirtuosoInstance[]>> {
	const registryDir = query.registryDir ?? getDefaultVirtuosoInstanceRegistryDir();
	let entries: string[];
	try {
		entries = await readdir(registryDir);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return ok([]);
		}
		return fail({
			type: "virtuoso_instance_registry_read_error",
			stage: "virtuoso_instance_discovery",
			message: error instanceof Error ? error.message : String(error),
			details: { registryDir },
		});
	}

	const instances: LiveManagedVirtuosoInstance[] = [];
	for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
		const record = await readInstanceRecord(join(registryDir, entry));
		if (!record) {
			continue;
		}
		const live = await toLiveInstance(record, query.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
		if (!live) {
			continue;
		}
		if (query.instanceId && live.instanceId !== query.instanceId) {
			continue;
		}
		if (query.cdsLib && (!live.cdsLib || resolve(live.cdsLib) !== resolve(query.cdsLib))) {
			continue;
		}
		if (query.requireUi && live.mode !== "ui") {
			continue;
		}
		instances.push(live);
	}
	return ok(instances);
}

export async function resolveManagedVirtuosoInstance(
	query: ManagedVirtuosoInstanceQuery,
): Promise<RuntimeResult<LiveManagedVirtuosoInstance>> {
	const listed = await listManagedVirtuosoInstances(query);
	if (!listed.ok) {
		return listed;
	}
	if (listed.value.length === 1) {
		return ok(listed.value[0]);
	}
	if (listed.value.length === 0) {
		return fail({
			type: query.instanceId ? "virtuoso_instance_unavailable" : "virtuoso_instance_not_found",
			stage: "virtuoso_instance_resolution",
			message: query.instanceId
				? `Managed Virtuoso instance ${query.instanceId} is not ready or no longer alive.`
				: "No ready virtuoso-agent managed instance matches this request.",
			details: { instanceId: query.instanceId, cdsLib: query.cdsLib, requireUi: query.requireUi ?? false },
		});
	}
	return fail({
		type: "virtuoso_instance_selection_required",
		stage: "virtuoso_instance_resolution",
		message: "Multiple managed Virtuoso instances match this request; select one instanceId.",
		details: {
			candidates: listed.value.map((instance) => ({
				instanceId: instance.instanceId,
				pid: instance.pid,
				mode: instance.mode,
				cwd: instance.cwd,
				cdsLib: instance.cdsLib,
				display: instance.display,
				heartbeatAt: instance.heartbeatAt,
			})),
		},
	});
}

async function readInstanceRecord(path: string): Promise<ManagedVirtuosoInstanceRecord | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isManagedVirtuosoInstanceRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function toLiveInstance(
	record: ManagedVirtuosoInstanceRecord,
	heartbeatTimeoutMs: number,
): Promise<LiveManagedVirtuosoInstance | undefined> {
	if (record.state !== "ready" || (record.pid !== undefined && !isProcessAlive(record.pid))) {
		return undefined;
	}
	try {
		await stat(record.readyPath);
		const heartbeat = await stat(record.heartbeatPath);
		if (Date.now() - heartbeat.mtimeMs > heartbeatTimeoutMs) {
			return undefined;
		}
		return { ...record, state: "ready", heartbeatAt: heartbeat.mtime.toISOString() };
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

function isManagedVirtuosoInstanceRecord(value: unknown): value is ManagedVirtuosoInstanceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.protocolVersion === 1 &&
		typeof record.instanceId === "string" &&
		(record.pid === undefined || typeof record.pid === "number") &&
		typeof record.processStartedAt === "string" &&
		(record.mode === "ui" || record.mode === "headless") &&
		(record.state === "starting" || record.state === "ready") &&
		typeof record.cwd === "string" &&
		(record.cdsLib === undefined || typeof record.cdsLib === "string") &&
		(record.display === undefined || typeof record.display === "string") &&
		typeof record.sessionDir === "string" &&
		typeof record.commandDir === "string" &&
		typeof record.resultDir === "string" &&
		typeof record.processedDir === "string" &&
		typeof record.readyPath === "string" &&
		typeof record.heartbeatPath === "string" &&
		typeof record.bridgePath === "string"
	);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
