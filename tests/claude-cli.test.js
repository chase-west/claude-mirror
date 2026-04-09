const { EventEmitter } = require("events");
const ClaudeCLIService = require("../services/claude-cli");

// --- Mock Data ---
const MOCK_INSIGHTS = {
	priorityOrder: [
		{ title: "Test task", reason: "High priority" }
	],
	timeBlocks: [
		{ time: "9:00 AM", task: "Test task", reason: "Morning focus" }
	],
	insights: ["Focus on high priority items first."],
	patterns: [],
	dailyReminder: "You've got this!"
};

const MOCK_TASKS = [
	{
		title: "Test task",
		body: "",
		status: "notStarted",
		importance: "high",
		listName: "Tasks",
		dueDateTime: null,
		categories: []
	}
];

// Build mock JSON output (--output-format json returns {result: "text"})
function buildJsonOutput(text) {
	return JSON.stringify({ result: text }) + "\n";
}

// --- Mock spawn ---
function createMockSpawn(options = {}) {
	const { exitCode = 0, stdout = "", stderr = "", error = null } = options;

	return function mockSpawn(cmd, args, spawnOptions) {
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.stdin = { write: jest.fn(), end: jest.fn() };

		// Store for assertions
		proc._cmd = cmd;
		proc._args = args;
		proc._spawnOptions = spawnOptions;

		// Emit data async
		process.nextTick(() => {
			if (error) {
				proc.emit("error", error);
				return;
			}
			if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
			if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
			proc.emit("close", exitCode);
		});

		return proc;
	};
}

// --- Tests ---
describe("ClaudeCLIService", () => {

	describe("Constructor", () => {
		test("uses default values", () => {
			const service = new ClaudeCLIService({});
			expect(service.cliPath).toBe("claude");
			expect(service.model).toBe("claude-sonnet-4-20250514");
			expect(service.timeoutMs).toBe(120000);
		});

		test("accepts custom config", () => {
			const service = new ClaudeCLIService({
				cliPath: "/usr/local/bin/claude",
				model: "claude-haiku-4-5-20251001",
				timeoutMs: 30000
			});
			expect(service.cliPath).toBe("/usr/local/bin/claude");
			expect(service.model).toBe("claude-haiku-4-5-20251001");
			expect(service.timeoutMs).toBe(30000);
		});
	});

	describe("parseJsonOutput", () => {
		test("extracts text from assistant message content blocks", () => {
			const service = new ClaudeCLIService({});
			const output = buildJsonOutput("Hello world");
			const result = service.parseJsonOutput(output);
			expect(result).toBe("Hello world");
		});

		test("parses {result: text} format", () => {
			const service = new ClaudeCLIService({});
			const output = JSON.stringify({ result: "Final answer" });
			const result = service.parseJsonOutput(output);
			expect(result).toBe("Final answer");
		});

		test("parses {content: [...]} format", () => {
			const service = new ClaudeCLIService({});
			const output = JSON.stringify({
				content: [
					{ type: "tool_use", name: "something" },
					{ type: "text", text: "Part 1 " },
					{ type: "text", text: "Part 2" }
				]
			});
			const result = service.parseJsonOutput(output);
			expect(result).toBe("Part 1 Part 2");
		});

		test("falls back to stream-json parsing", () => {
			const service = new ClaudeCLIService({});
			const output = JSON.stringify({
				type: "assistant",
				message: {
					content: [{ type: "text", text: "streamed" }]
				}
			});
			const result = service.parseJsonOutput(output);
			expect(result).toBe("streamed");
		});

		test("handles empty output", () => {
			const service = new ClaudeCLIService({});
			expect(service.parseJsonOutput("")).toBe("");
			expect(service.parseJsonOutput("\n\n")).toBe("");
		});

		test("handles mixed output gracefully", () => {
			const service = new ClaudeCLIService({});
			const output = JSON.stringify({ result: "works" });
			const result = service.parseJsonOutput(output);
			expect(result).toBe("works");
		});

		test("returns raw text as fallback", () => {
			const service = new ClaudeCLIService({});
			const result = service.parseJsonOutput("Just some plain text response here");
			expect(result).toBe("Just some plain text response here");
		});
	});

	describe("runClaude", () => {
		test("spawns claude with correct arguments", async () => {
			let capturedArgs;
			const mockSpawn = (cmd, args, opts) => {
				capturedArgs = { cmd, args, opts };
				const proc = new EventEmitter();
				proc.stdout = new EventEmitter();
				proc.stderr = new EventEmitter();
				proc.stdin = { write: jest.fn(), end: jest.fn() };
				process.nextTick(() => {
					proc.stdout.emit("data", Buffer.from(buildJsonOutput("test")));
					proc.emit("close", 0);
				});
				return proc;
			};

			const service = new ClaudeCLIService({
				model: "claude-sonnet-4-20250514",
				spawn: mockSpawn
			});

			await service.runClaude("test prompt");

			expect(capturedArgs.cmd).toBe("claude");
			expect(capturedArgs.args).toContain("-p");
			expect(capturedArgs.args).toContain("test prompt");
			expect(capturedArgs.args).toContain("--output-format");
			expect(capturedArgs.args).toContain("json");
			expect(capturedArgs.args).toContain("--max-turns");
			expect(capturedArgs.args).toContain("1");
			expect(capturedArgs.args).toContain("--model");
			expect(capturedArgs.args).toContain("claude-sonnet-4-20250514");
		});

		test("returns parsed text on success", async () => {
			const insightsJson = JSON.stringify(MOCK_INSIGHTS);
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					stdout: buildJsonOutput(insightsJson)
				})
			});

			const result = await service.runClaude("test");
			expect(result).toContain("priorityOrder");
		});

		test("rejects on non-zero exit code", async () => {
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					exitCode: 1,
					stderr: "Authentication required"
				})
			});

			await expect(service.runClaude("test")).rejects.toThrow(
				"Claude CLI exited with code 1"
			);
		});

		test("rejects when CLI not found (ENOENT)", async () => {
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
				})
			});

			await expect(service.runClaude("test")).rejects.toThrow(
				"Claude CLI not found"
			);
		});

		test("rejects on other spawn errors", async () => {
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					error: new Error("Permission denied")
				})
			});

			await expect(service.runClaude("test")).rejects.toThrow(
				"Claude CLI error: Permission denied"
			);
		});

		test("rejects when output is empty", async () => {
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					stdout: ""
				})
			});

			await expect(service.runClaude("test")).rejects.toThrow(
				"Claude CLI returned no text"
			);
		});

		test("truncates long stderr in error message", async () => {
			const longStderr = "x".repeat(1000);
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					exitCode: 1,
					stderr: longStderr
				})
			});

			try {
				await service.runClaude("test");
			} catch (err) {
				expect(err.message.length).toBeLessThan(600);
			}
		});
	});

	describe("generateInsights", () => {
		test("builds prompt, runs CLI, and parses insights", async () => {
			const insightsJson = JSON.stringify(MOCK_INSIGHTS);
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					stdout: buildJsonOutput(insightsJson)
				})
			});

			const insights = await service.generateInsights(MOCK_TASKS);

			expect(insights.priorityOrder).toHaveLength(1);
			expect(insights.priorityOrder[0].title).toBe("Test task");
			expect(insights.timeBlocks).toHaveLength(1);
			expect(insights.insights).toHaveLength(1);
			expect(insights.dailyReminder).toBe("You've got this!");
		});

		test("handles insights wrapped in markdown code block", async () => {
			const wrapped = "```json\n" + JSON.stringify(MOCK_INSIGHTS) + "\n```";
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					stdout: buildJsonOutput(wrapped)
				})
			});

			const insights = await service.generateInsights(MOCK_TASKS);
			expect(insights.priorityOrder).toHaveLength(1);
		});

		test("uses current time when not provided", async () => {
			let capturedPrompt;
			const mockSpawn = (cmd, args) => {
				capturedPrompt = args[1]; // -p <prompt>
				const proc = new EventEmitter();
				proc.stdout = new EventEmitter();
				proc.stderr = new EventEmitter();
				proc.stdin = { write: jest.fn(), end: jest.fn() };
				process.nextTick(() => {
					proc.stdout.emit("data", Buffer.from(
						buildJsonOutput(JSON.stringify(MOCK_INSIGHTS))
					));
					proc.emit("close", 0);
				});
				return proc;
			};

			const service = new ClaudeCLIService({ spawn: mockSpawn });
			await service.generateInsights(MOCK_TASKS);

			expect(capturedPrompt).toContain("Current day:");
			expect(capturedPrompt).toContain("Current time:");
		});

		test("propagates CLI errors", async () => {
			const service = new ClaudeCLIService({
				spawn: createMockSpawn({
					exitCode: 1,
					stderr: "Not authenticated"
				})
			});

			await expect(service.generateInsights(MOCK_TASKS)).rejects.toThrow(
				"Claude CLI exited with code 1"
			);
		});
	});

	describe("inherits AIBase", () => {
		test("has formatTasksForPrompt", () => {
			const service = new ClaudeCLIService({});
			const result = service.formatTasksForPrompt(MOCK_TASKS);
			expect(result).toContain("Test task");
		});

		test("has buildPrompt", () => {
			const service = new ClaudeCLIService({});
			const prompt = service.buildPrompt(MOCK_TASKS, Date.now());
			expect(prompt).toContain("productivity assistant");
		});

		test("has task history methods", () => {
			const service = new ClaudeCLIService({});
			service.saveHistory = jest.fn();
			service.recordTaskSnapshot(MOCK_TASKS);
			expect(service.taskHistory).toHaveLength(1);
		});
	});
});
