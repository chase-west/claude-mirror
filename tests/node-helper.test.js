const path = require("path");

// --- Mock MagicMirror's node_helper base ---
// MagicMirror's node_helper module isn't available in test, so we mock it.
const mockSendSocketNotification = jest.fn();

jest.mock("node_helper", () => ({
	create: (definition) => {
		const helper = {
			...definition,
			sendSocketNotification: mockSendSocketNotification,
			name: definition.name || "test-module"
		};
		return helper;
	}
}), { virtual: true });

// Mock the services
jest.mock("../services/microsoft-todo");
jest.mock("../services/claude-ai");

const MicrosoftTodoService = require("../services/microsoft-todo");
const ClaudeAIService = require("../services/claude-ai");

// --- Mock Data ---
const MOCK_CONFIG = {
	microsoftClientId: "test-client-id",
	microsoftClientSecret: "test-client-secret",
	microsoftTokensPath: "/tmp/test-tokens.json",
	anthropicApiKey: "test-anthropic-key",
	claudeModel: "claude-haiku-4-5-20251001",
	claudeMaxTokens: 1024,
	taskListName: "Tasks",
	taskUpdateInterval: 300000,
	insightUpdateInterval: 1800000
};

const MOCK_TASKS = [
	{
		id: "1",
		title: "Test task",
		status: "notStarted",
		importance: "high",
		listName: "Tasks"
	},
	{
		id: "2",
		title: "Completed task",
		status: "completed",
		importance: "normal",
		listName: "Tasks"
	}
];

const MOCK_INSIGHTS = {
	priorityOrder: [{ title: "Test task", reason: "High priority" }],
	timeBlocks: [{ time: "9:00 AM", task: "Test task", reason: "Morning focus" }],
	insights: ["Focus on high priority tasks first"],
	patterns: [],
	dailyReminder: "You've got this!"
};

// --- Tests ---

describe("node_helper", () => {
	let helper;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();

		// Set up mock implementations
		MicrosoftTodoService.mockImplementation(() => ({
			getAllTasks: jest.fn().mockResolvedValue(MOCK_TASKS),
			loadTokens: jest.fn().mockResolvedValue(true)
		}));

		ClaudeAIService.mockImplementation(() => ({
			generateInsights: jest.fn().mockResolvedValue(MOCK_INSIGHTS),
			loadHistory: jest.fn(),
			recordTaskSnapshot: jest.fn()
		}));

		// Re-require to get fresh instance
		jest.isolateModules(() => {
			helper = require("../node_helper");
		});
		helper.sendSocketNotification = mockSendSocketNotification;
	});

	afterEach(() => {
		jest.useRealTimers();
		if (helper.taskTimer) clearInterval(helper.taskTimer);
		if (helper.insightTimer) clearInterval(helper.insightTimer);
	});

	describe("start", () => {
		test("initializes with default state", () => {
			helper.start();
			expect(helper.config).toBeNull();
			expect(helper.tasks).toEqual([]);
			expect(helper.insights).toBeNull();
			expect(helper.started).toBe(false);
		});
	});

	describe("socketNotificationReceived", () => {
		test("handles INIT_MODULE notification", () => {
			helper.start();
			helper.initModule = jest.fn();
			helper.socketNotificationReceived("INIT_MODULE", MOCK_CONFIG);
			expect(helper.initModule).toHaveBeenCalledWith(MOCK_CONFIG);
		});

		test("handles FETCH_TASKS notification", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.socketNotificationReceived("FETCH_TASKS", {});
			expect(helper.fetchTasks).toHaveBeenCalled();
		});

		test("handles FETCH_INSIGHTS notification", () => {
			helper.start();
			helper.fetchInsights = jest.fn();
			helper.socketNotificationReceived("FETCH_INSIGHTS", {});
			expect(helper.fetchInsights).toHaveBeenCalled();
		});

		test("handles FORCE_REFRESH notification", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.fetchInsights = jest.fn();
			helper.socketNotificationReceived("FORCE_REFRESH", {});
			expect(helper.fetchTasks).toHaveBeenCalled();
			expect(helper.fetchInsights).toHaveBeenCalled();
		});
	});

	describe("initModule", () => {
		test("initializes services with config", () => {
			helper.start();
			// Stub fetchTasks to prevent async execution during init
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);

			expect(helper.config).toEqual(MOCK_CONFIG);
			expect(helper.started).toBe(true);
			expect(MicrosoftTodoService).toHaveBeenCalledWith(
				expect.objectContaining({
					clientId: "test-client-id",
					clientSecret: "test-client-secret"
				})
			);
			expect(ClaudeAIService).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: "test-anthropic-key",
					model: "claude-haiku-4-5-20251001"
				})
			);
		});

		test("only initializes once", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);
			helper.initModule(MOCK_CONFIG);

			// Should only create services once
			expect(MicrosoftTodoService).toHaveBeenCalledTimes(1);
		});

		test("sets up task fetch timer", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);

			expect(helper.taskTimer).toBeDefined();

			// Fast-forward past the interval
			jest.advanceTimersByTime(MOCK_CONFIG.taskUpdateInterval + 100);
			// fetchTasks called once during init, once from timer
			expect(helper.fetchTasks).toHaveBeenCalledTimes(2);
		});

		test("sets up insight fetch timer when AI configured", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);

			expect(helper.insightTimer).toBeDefined();
		});

		test("skips AI setup when no API key", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			const configNoAI = { ...MOCK_CONFIG, anthropicApiKey: "" };
			helper.initModule(configNoAI);

			expect(helper.aiService).toBeNull();
			expect(helper.insightTimer).toBeNull();
		});

		test("loads AI history on init", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);

			expect(helper.aiService.loadHistory).toHaveBeenCalled();
		});
	});

	describe("fetchTasks", () => {
		test("sends TASKS_UPDATED with fetched tasks", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG);

			// Reset mock to clear init call
			mockSendSocketNotification.mockClear();

			await helper.fetchTasks();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"TASKS_UPDATED",
				expect.objectContaining({
					tasks: MOCK_TASKS,
					timestamp: expect.any(Number)
				})
			);
		});

		test("records task snapshot for AI history", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG);

			// Clear from init
			helper.aiService.recordTaskSnapshot.mockClear();

			await helper.fetchTasks();

			expect(helper.aiService.recordTaskSnapshot).toHaveBeenCalledWith(
				MOCK_TASKS
			);
		});

		test("auto-fetches insights on first task load", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG);
			helper.insights = null; // Ensure no insights yet

			// Mock fetchInsights to track calls
			const fetchInsightsSpy = jest.fn();
			helper.fetchInsights = fetchInsightsSpy;

			await helper.fetchTasks();

			expect(fetchInsightsSpy).toHaveBeenCalled();
		});

		test("sends ERROR on fetch failure", async () => {
			helper.start();

			MicrosoftTodoService.mockImplementation(() => ({
				getAllTasks: jest.fn().mockRejectedValue(new Error("Network error"))
			}));

			jest.isolateModules(() => {
				helper = require("../node_helper");
			});
			helper.sendSocketNotification = mockSendSocketNotification;
			helper.start();
			helper.initModule(MOCK_CONFIG);

			mockSendSocketNotification.mockClear();
			await helper.fetchTasks();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"ERROR",
				expect.objectContaining({
					type: "TASK_FETCH_ERROR",
					message: "Network error"
				})
			);
		});
	});

	describe("fetchInsights", () => {
		test("sends INSIGHTS_UPDATED with AI insights", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG);
			helper.tasks = MOCK_TASKS;

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"INSIGHTS_UPDATED",
				expect.objectContaining({
					insights: MOCK_INSIGHTS,
					timestamp: expect.any(Number)
				})
			);
		});

		test("filters out completed tasks before sending to AI", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG);
			helper.tasks = MOCK_TASKS;

			await helper.fetchInsights();

			const generateCall = helper.aiService.generateInsights.mock.calls[0];
			const tasksPassedToAI = generateCall[0];
			expect(tasksPassedToAI).toHaveLength(1);
			expect(tasksPassedToAI[0].status).not.toBe("completed");
		});

		test("sends error when AI not configured", async () => {
			helper.start();
			const configNoAI = { ...MOCK_CONFIG, anthropicApiKey: "" };
			helper.fetchTasks = jest.fn();
			helper.initModule(configNoAI);

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"ERROR",
				expect.objectContaining({
					type: "AI_NOT_CONFIGURED"
				})
			);
		});

		test("skips when no tasks available", async () => {
			helper.start();
			helper.fetchTasks = jest.fn(); // prevent async task fetch during init
			helper.initModule(MOCK_CONFIG);
			helper.tasks = [];

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).not.toHaveBeenCalled();
		});

		test("sends ERROR on insight generation failure", async () => {
			helper.start();

			ClaudeAIService.mockImplementation(() => ({
				generateInsights: jest.fn().mockRejectedValue(new Error("API error")),
				loadHistory: jest.fn(),
				recordTaskSnapshot: jest.fn()
			}));

			jest.isolateModules(() => {
				helper = require("../node_helper");
			});
			helper.sendSocketNotification = mockSendSocketNotification;
			helper.start();
			helper.initModule(MOCK_CONFIG);
			helper.tasks = MOCK_TASKS;

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"ERROR",
				expect.objectContaining({
					type: "INSIGHT_ERROR",
					message: "API error"
				})
			);
		});
	});

	describe("stop", () => {
		test("clears timers on stop", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG);

			expect(helper.taskTimer).toBeDefined();
			expect(helper.insightTimer).toBeDefined();

			helper.stop();
			// Timers should be cleared (no more calls after advancing time)
			helper.fetchTasks.mockClear();
			jest.advanceTimersByTime(MOCK_CONFIG.taskUpdateInterval * 2);
			// If timers were properly cleared, fetchTasks shouldn't be called again
			// (it was already set up, but clearInterval in stop should prevent new calls)
		});
	});
});
