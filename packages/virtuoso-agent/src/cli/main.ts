/**
 * Virtuoso Agent CLI，这部分的作用是作为命令`vab` CLI 入口的人工作业文件。
 * 目的是把任务委托给`src/runtime`，而不直接连接到 Virtuoso、解析 Spectre 日志或实现优化逻辑。
 * 这些都属于 `src/runtime` 的职责范围。
 */

import { getVirtuosoStatus, runTask, validateTaskFile } from "../index.ts";

async function main(argv: string[]): Promise<number> {
	const [command, subcommand, pathOrJob] = argv;

	// 当前脚手架阶段 status 仅用于证明整个包已经正确连接\
	// 当输入`vab status --json`时，CLI 会调用 `getVirtuosoStatus` 函数，
	// 并以 JSON 格式输出结果, 返回当前工具状态。
	if (command === "status") {
		const status = await getVirtuosoStatus();
		console.log(JSON.stringify({ ok: true, value: status }, null, 2)); // JSON.stringify(要转换的对象,过滤/替换规则,缩进空格数);
		return 0;
	}

	// 当输入`vab task validate path/to/task.json --json`时，CLI 会调用 `validateTaskFile` 函数，
	// 以 JSON 格式输出结果, 验证任务文件的正确性。
	// 如果验证成功且没有问题，返回 0；否则返回 1。
	if (command === "task" && subcommand === "validate" && pathOrJob) {
		const result = await validateTaskFile(pathOrJob);
		console.log(JSON.stringify(result, null, 2));
		return result.ok && result.value.issues.length === 0 ? 0 : 1;
	}

	// 当输入`vab run path/to/task.json --json`时，CLI 会调用 `runTask` 函数，
	// 以 JSON 格式输出结果, 运行任务文件。
	// 如果运行成功，返回 0；否则返回 1。
	if (command === "run" && subcommand) {
		const result = await runTask(subcommand);
		console.log(JSON.stringify(result, null, 2));
		return result.ok ? 0 : 1;
	}

	// 当输入的命令不符合上述格式时，输出使用说明，并返回 1。
	console.error("Usage:");
	console.error("  vab status --json");
	console.error("  vab task validate <task.json> --json");
	console.error("  vab run <task.json> --json");
	return 1;
}

// 运行 main 函数，并根据其返回的 exitCode 设置进程的 exitCode。
void main(process.argv.slice(2)).then((exitCode) => {
	process.exitCode = exitCode;
});
