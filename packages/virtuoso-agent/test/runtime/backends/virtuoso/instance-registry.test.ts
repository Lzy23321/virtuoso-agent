import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	listManagedVirtuosoInstances,
	type ManagedVirtuosoInstanceRecord,
	registerManagedVirtuosoInstance,
	resolveManagedVirtuosoInstance,
} from "../../../../src/index.ts";

async function createReadyInstance(
	registryDir: string,
	instanceId: string,
	cdsLib: string,
): Promise<ManagedVirtuosoInstanceRecord> {
	const sessionDir = join(registryDir, "runtime", instanceId);
	const commandDir = join(sessionDir, "commands");
	const resultDir = join(sessionDir, "results");
	const processedDir = join(sessionDir, "processed");
	const readyPath = join(sessionDir, "ready.json");
	const heartbeatPath = join(sessionDir, "heartbeat.json");
	await mkdir(commandDir, { recursive: true });
	await mkdir(resultDir, { recursive: true });
	await mkdir(processedDir, { recursive: true });
	await writeFile(readyPath, '{"state":"ready"}\n', "utf8");
	await writeFile(heartbeatPath, '{"heartbeatAt":"now"}\n', "utf8");
	const record: ManagedVirtuosoInstanceRecord = {
		protocolVersion: 1,
		instanceId,
		pid: process.pid,
		processStartedAt: new Date().toISOString(),
		mode: "ui",
		state: "ready",
		cwd: join(registryDir, "project"),
		cdsLib,
		display: ":1",
		sessionDir,
		commandDir,
		resultDir,
		processedDir,
		readyPath,
		heartbeatPath,
		bridgePath: "/repo/bridge.il",
	};
	const registered = await registerManagedVirtuosoInstance(record, registryDir);
	expect(registered.ok).toBe(true);
	return record;
}

describe("managed Virtuoso instance registry", () => {
	it("lists only registered instances with a live pid and fresh heartbeat", async () => {
		const registryDir = await mkdtemp(join(tmpdir(), "virtuoso-instance-registry-"));
		const cdsLib = join(registryDir, "project", "cds.lib");
		await createReadyInstance(registryDir, "vui-live", cdsLib);

		const result = await listManagedVirtuosoInstances({ registryDir });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(1);
			expect(result.value[0]).toMatchObject({ instanceId: "vui-live", cdsLib, state: "ready" });
		}
	});

	it("requires explicit selection when multiple managed instances match", async () => {
		const registryDir = await mkdtemp(join(tmpdir(), "virtuoso-instance-registry-"));
		const cdsLib = join(registryDir, "project", "cds.lib");
		await createReadyInstance(registryDir, "vui-one", cdsLib);
		await createReadyInstance(registryDir, "vui-two", cdsLib);

		const result = await resolveManagedVirtuosoInstance({ registryDir, cdsLib, requireUi: true });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("virtuoso_instance_selection_required");
			expect(result.error.details?.candidates).toHaveLength(2);
		}
	});

	it("selects an explicit live instance without inspecting unrelated processes", async () => {
		const registryDir = await mkdtemp(join(tmpdir(), "virtuoso-instance-registry-"));
		const first = await createReadyInstance(registryDir, "vui-one", join(registryDir, "one", "cds.lib"));
		await createReadyInstance(registryDir, "vui-two", join(registryDir, "two", "cds.lib"));

		const result = await resolveManagedVirtuosoInstance({ registryDir, instanceId: first.instanceId });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.instanceId).toBe("vui-one");
		}
	});
});
