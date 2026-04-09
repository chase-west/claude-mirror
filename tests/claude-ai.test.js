const path = require("path");
const fs = require("fs");
const ClaudeAIService = require("../services/claude-ai");

// --- Mock Data ---
const MOCK_TASKS = [
	{
		title: "Finish project report",
		body: "Q4 financial summary",
		status: "notStarted",
		importance: "high",
		listName: "Work",
		dueDateTime: "2024-01-20T23:59:00Z",
		categories: ["work", "urgent"]
	},
	{
		title: "Buy groceries",
		body: "Milk, eggs, bread",
		status: "notStarted",
		importance: "normal",
		listName: "Tasks",
		dueDateTime: "2024-01-16T23:59:00Z",
		categories: ["errands"]
	},
	{
		title: "Schedule dentist appointment",
		body: "",
		status: "notStarted",
		importance: "low",
		listName: "Tasks",
		dueDateTime: null,
		categories: []
	}
];

const MOCK_AI_RESPONSE = {
	priorityOrder: [
		{ title: "Finish project report", reason: "High priority with deadline approaching" },
		{ title: "Buy groceries", reason: "Due tomorrow" },
		{ title: "Schedule dentist appointment", reason: "No deadline but important for health" }
	],
	timeBlocks: [
		{ time: "9:00 AM", task: "Finish project report", reason: "Peak focus hours" },
		{ time: "12:30 PM", task: "Buy groceries", reason: "Lunch break errand" },
		{ time: "3:00 PM", task: "Schedule dentist appointment", reason: "Quick phone call" }
	],
	insights: [
		"Your report deadline is in 4 days - consider breaking it into sections.",
		"You have 3 tasks today - very manageable. Start with the report."
	],
	patterns: [
		"You tend to add grocery tasks weekly on Mondays."
	],
	dailyReminder: "Focus on the Q4 report this morning while energy is highest."
};

// --- Mock Anthropic Client ---
function createMockClient(responseOverride) {
	return {
		messages: {
			create: jest.fn().mockResolvedValue({
				content: [
					{
						text: JSON.stringify(responseOverride || MOCK_AI_RESPONSE)
					}
				]
			})
		}
	};
}

function createMockClientWithCodeBlock(response) {
	return {
		messages: {
			create: jest.fn().mockResolvedValue({
				content: [
					{
						text: "```json\n" + JSON.stringify(response || MOCK_AI_RESPONSE) + "\n```"
					}
				]
			})
		}
	};
}

function createFailingClient(error) {
	return {
		messages: {
			create: jest.fn().mockRejectedValue(error || new Error("API rate limit exceeded"))
		}
	};
}

// --- Tests ---

describe("ClaudeAIService", () => {
	let tmpHistoryPath;

	beforeEach(() => {
		tmpHistoryPath = path.join(__dirname, `test-history-${Date.now()}.json`);
		// Temporarily override HISTORY_FILE path by manipulating the data dir
	});

	afterEach(() => {
		try {
			fs.unlinkSync(tmpHistoryPath);
		} catch {
			// ignore
		}
	});

	describe("formatTasksForPrompt", () => {
		test("formats tasks with all fields", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			const formatted = service.formatTasksForPrompt(MOCK_TASKS);

			expect(formatted).toContain("1. \"Finish project report\"");
			expect(formatted).toContain("Status: notStarted");
			expect(formatted).toContain("Priority: high");
			expect(formatted).toContain("List: Work");
			expect(formatted).toContain("Due: 2024-01-20");
			expect(formatted).toContain("Categories: work, urgent");
		});

		test("formats tasks without optional fields", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			const formatted = service.formatTasksForPrompt([{
				title: "Simple task",
				status: "notStarted",
				importance: "normal",
				body: "",
				categories: []
			}]);

			expect(formatted).toContain("\"Simple task\"");
			expect(formatted).not.toContain("Due:");
			expect(formatted).not.toContain("List:");
			expect(formatted).not.toContain("Categories:");
		});

		test("returns empty message for no tasks", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			expect(service.formatTasksForPrompt([])).toBe("No tasks found.");
			expect(service.formatTasksForPrompt(null)).toBe("No tasks found.");
		});

		test("truncates long body text", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			const longBody = "A".repeat(200);
			const formatted = service.formatTasksForPrompt([{
				title: "Test",
				body: longBody,
				status: "notStarted",
				importance: "normal",
				categories: []
			}]);

			// Body should be truncated to 100 chars
			const bodyMatch = formatted.match(/Notes: (A+)/);
			expect(bodyMatch[1].length).toBe(100);
		});
	});

	describe("Task History", () => {
		test("recordTaskSnapshot adds to history", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});
			// Override save to prevent file writes
			service.saveHistory = jest.fn();

			service.recordTaskSnapshot(MOCK_TASKS);

			expect(service.taskHistory).toHaveLength(1);
			expect(service.taskHistory[0].tasks).toHaveLength(3);
			expect(service.taskHistory[0].timestamp).toBeDefined();
			expect(service.taskHistory[0].tasks[0].title).toBe("Finish project report");
		});

		test("formatHistoryForPrompt returns message when empty", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			expect(service.formatHistoryForPrompt()).toBe(
				"No task history available yet."
			);
		});

		test("formatHistoryForPrompt shows recent snapshots", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			service.taskHistory = [
				{
					timestamp: "2024-01-15T08:00:00Z",
					tasks: [
						{ title: "Task A", status: "notStarted" },
						{ title: "Task B", status: "completed" }
					]
				}
			];

			const formatted = service.formatHistoryForPrompt();
			expect(formatted).toContain("Task A");
			expect(formatted).toContain("notStarted");
			expect(formatted).toContain("Task B");
			expect(formatted).toContain("completed");
		});

		test("formatHistoryForPrompt limits to last 30 snapshots", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			service.taskHistory = Array.from({ length: 50 }, (_, i) => ({
				timestamp: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T08:00:00Z`,
				tasks: [{ title: `Task ${i}`, status: "notStarted" }]
			}));

			const formatted = service.formatHistoryForPrompt();
			// Should only include last 30 (indices 20-49)
			expect(formatted).not.toContain("Task 19");
			expect(formatted).toContain("Task 20");
			expect(formatted).toContain("Task 49");
		});
	});

	describe("buildPrompt", () => {
		test("builds prompt with all sections", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			const fixedTime = new Date("2024-01-15T10:30:00Z").getTime();
			const prompt = service.buildPrompt(MOCK_TASKS, fixedTime);

			expect(prompt).toContain("life assistant");
			expect(prompt).toContain("TASKS");
			expect(prompt).toContain("COMPLETION HISTORY");
			expect(prompt).toContain("Finish project report");
			expect(prompt).toContain("priorityOrder");
			expect(prompt).toContain("timeBlocks");
			expect(prompt).toContain("insights");
			expect(prompt).toContain("patterns");
			expect(prompt).toContain("dailyReminder");
		});

		test("includes day of week and time", () => {
			const service = new ClaudeAIService({
				apiKey: "test",
				client: createMockClient()
			});

			const monday = new Date("2024-01-15T10:30:00Z").getTime();
			const prompt = service.buildPrompt(MOCK_TASKS, monday);

			expect(prompt).toContain("Monday");
		});
	});

	describe("generateInsights", () => {
		test("returns structured insights from Claude response", async () => {
			const mockClient = createMockClient();
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient,
				model: "claude-haiku-4-5-20251001"
			});

			const insights = await service.generateInsights(MOCK_TASKS);

			expect(insights.priorityOrder).toHaveLength(3);
			expect(insights.timeBlocks).toHaveLength(3);
			expect(insights.insights).toHaveLength(2);
			expect(insights.patterns).toHaveLength(1);
			expect(insights.dailyReminder).toBeTruthy();

			// Verify the client was called correctly
			expect(mockClient.messages.create).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "claude-haiku-4-5-20251001",
					max_tokens: 1024
				})
			);
		});

		test("handles response wrapped in markdown code block", async () => {
			const mockClient = createMockClientWithCodeBlock();
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient
			});

			const insights = await service.generateInsights(MOCK_TASKS);

			expect(insights.priorityOrder).toHaveLength(3);
			expect(insights.dailyReminder).toBeTruthy();
		});

		test("handles partial response with missing fields", async () => {
			const partialResponse = {
				priorityOrder: [{ title: "Test", reason: "Important" }],
				insights: ["One insight"]
				// Missing: timeBlocks, patterns, dailyReminder
			};

			const mockClient = createMockClient(partialResponse);
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient
			});

			const insights = await service.generateInsights(MOCK_TASKS);

			expect(insights.priorityOrder).toHaveLength(1);
			expect(insights.timeBlocks).toEqual([]);
			expect(insights.insights).toHaveLength(1);
			expect(insights.patterns).toEqual([]);
			expect(insights.dailyReminder).toBe("");
		});

		test("throws on invalid JSON response", async () => {
			const mockClient = {
				messages: {
					create: jest.fn().mockResolvedValue({
						content: [{ text: "This is not JSON at all" }]
					})
				}
			};

			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient
			});

			await expect(service.generateInsights(MOCK_TASKS)).rejects.toThrow();
		});

		test("throws on API error", async () => {
			const mockClient = createFailingClient(new Error("Rate limited"));
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient
			});

			await expect(service.generateInsights(MOCK_TASKS)).rejects.toThrow(
				"Rate limited"
			);
		});

		test("uses current time when not provided", async () => {
			const mockClient = createMockClient();
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient
			});

			const before = Date.now();
			await service.generateInsights(MOCK_TASKS);
			const after = Date.now();

			const calledWith = mockClient.messages.create.mock.calls[0][0];
			const message = calledWith.messages[0].content;
			// The prompt should contain today's date info
			expect(message).toContain("Current day:");
		});

		test("uses custom model when configured", async () => {
			const mockClient = createMockClient();
			const service = new ClaudeAIService({
				apiKey: "test",
				client: mockClient,
				model: "claude-sonnet-4-20250514"
			});

			await service.generateInsights(MOCK_TASKS);

			expect(mockClient.messages.create).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "claude-sonnet-4-20250514"
				})
			);
		});
	});
});
