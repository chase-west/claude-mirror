const path = require("path");

// --- Mock MagicMirror's node_helper base ---
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

// Mock all services
jest.mock("../services/microsoft-todo");
jest.mock("../services/claude-cli");
jest.mock("../services/claude-web");
jest.mock("../services/claude-ai");
jest.mock("../services/ollama-ai");

const MicrosoftTodoService = require("../services/microsoft-todo");
const ClaudeCLIService = require("../services/claude-cli");
const ClaudeWebService = require("../services/claude-web");
const ClaudeAIService = require("../services/claude-ai");
const OllamaAIService = require("../services/ollama-ai");

// --- Mock AI service factory ---
function mockAIService(overrides) {
	return {
		generateInsights: jest.fn().mockResolvedValue(MOCK_INSIGHTS),
		loadHistory: jest.fn(),
		recordTaskSnapshot: jest.fn(),
		getRecentThoughts: jest.fn().mockReturnValue([]),
		addThought: jest.fn().mockReturnValue({ id: "t1", text: "test" }),
		deleteThought: jest.fn(),
		saveLearnedPatterns: jest.fn(),
		...overrides
	};
}

// --- Mock Data ---
const MOCK_CONFIG_CLI = {
	microsoftClientId: "test-client-id",
	microsoftClientSecret: "test-client-secret",
	microsoftTokensPath: "/tmp/test-tokens.json",
	aiProvider: "claude-cli",
	claudeModel: "claude-sonnet-4-20250514",
	taskListName: "Tasks",
	taskUpdateInterval: 300000,
	insightUpdateInterval: 1800000
};

const MOCK_CONFIG_WEB = {
	...MOCK_CONFIG_CLI,
	aiProvider: "claude-web",
	claudeWebModel: "claude-sonnet-4-20250514"
};

const MOCK_CONFIG_API = {
	...MOCK_CONFIG_CLI,
	aiProvider: "claude-api",
	anthropicApiKey: "test-anthropic-key",
	claudeApiModel: "claude-haiku-4-5-20251001",
	claudeMaxTokens: 1024
};

const MOCK_CONFIG_OLLAMA = {
	...MOCK_CONFIG_CLI,
	aiProvider: "ollama",
	ollamaUrl: "http://localhost:11434",
	ollamaModel: "llama3.2"
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

		MicrosoftTodoService.mockImplementation(() => ({
			getAllTasks: jest.fn().mockResolvedValue(MOCK_TASKS),
			loadTokens: jest.fn().mockResolvedValue(true)
		}));

		ClaudeCLIService.mockImplementation(() => mockAIService());
		ClaudeWebService.mockImplementation(() => mockAIService());
		ClaudeAIService.mockImplementation(() => mockAIService());
		OllamaAIService.mockImplementation(() => mockAIService());

		jest.isolateModules(() => {
			helper = require("../node_helper");
		});
		helper.sendSocketNotification = mockSendSocketNotification;
		// Prevent actual HTTP server from starting during tests
		helper.startThoughtsApi = jest.fn();
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
			helper.socketNotificationReceived("INIT_MODULE", MOCK_CONFIG_CLI);
			expect(helper.initModule).toHaveBeenCalledWith(MOCK_CONFIG_CLI);
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

	describe("createAIService", () => {
		test("creates ClaudeCLIService for claude-cli provider (default)", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
			expect(ClaudeCLIService).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "claude-sonnet-4-20250514"
				})
			);
		});

		test("creates ClaudeWebService for claude-web provider", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_WEB);
			expect(ClaudeWebService).toHaveBeenCalled();
		});

		test("creates ClaudeAIService for claude-api provider", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_API);
			expect(ClaudeAIService).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: "test-anthropic-key",
					model: "claude-haiku-4-5-20251001"
				})
			);
		});

		test("creates OllamaAIService for ollama provider", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_OLLAMA);
			expect(OllamaAIService).toHaveBeenCalledWith(
				expect.objectContaining({
					baseUrl: "http://localhost:11434",
					model: "llama3.2"
				})
			);
		});

		test("returns null for claude-api with no API key", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			const config = { ...MOCK_CONFIG_API, anthropicApiKey: "" };
			helper.initModule(config);
			expect(helper.aiService).toBeNull();
		});

		test("returns null for unknown provider", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			const config = { ...MOCK_CONFIG_CLI, aiProvider: "unknown" };
			helper.initModule(config);
			expect(helper.aiService).toBeNull();
		});
	});

	describe("initModule", () => {
		test("initializes services with config", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);

			expect(helper.config).toEqual(MOCK_CONFIG_CLI);
			expect(helper.started).toBe(true);
			expect(MicrosoftTodoService).toHaveBeenCalledWith(
				expect.objectContaining({
					clientId: "test-client-id",
					clientSecret: "test-client-secret"
				})
			);
		});

		test("only initializes once", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
			helper.initModule(MOCK_CONFIG_CLI);
			expect(MicrosoftTodoService).toHaveBeenCalledTimes(1);
		});

		test("sets up task fetch timer", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);

			expect(helper.taskTimer).toBeDefined();
			jest.advanceTimersByTime(MOCK_CONFIG_CLI.taskUpdateInterval + 100);
			expect(helper.fetchTasks).toHaveBeenCalledTimes(2);
		});

		test("sets up insight fetch timer when AI configured", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
			expect(helper.insightTimer).toBeDefined();
		});

		test("skips insight timer when no AI service", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			const config = { ...MOCK_CONFIG_API, anthropicApiKey: "" };
			helper.initModule(config);
			expect(helper.aiService).toBeNull();
			expect(helper.insightTimer).toBeNull();
		});

		test("loads AI history on init", () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
			expect(helper.aiService.loadHistory).toHaveBeenCalled();
		});
	});

	describe("fetchTasks", () => {
		test("sends TASKS_UPDATED with fetched tasks", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG_CLI);

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
			helper.initModule(MOCK_CONFIG_CLI);
			helper.aiService.recordTaskSnapshot.mockClear();

			await helper.fetchTasks();
			expect(helper.aiService.recordTaskSnapshot).toHaveBeenCalledWith(MOCK_TASKS);
		});

		test("auto-fetches insights on first task load", async () => {
			helper.start();
			helper.initModule(MOCK_CONFIG_CLI);
			helper.insights = null;

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
			helper.startThoughtsApi = jest.fn();
			helper.start();
			helper.initModule(MOCK_CONFIG_CLI);

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
			helper.initModule(MOCK_CONFIG_CLI);
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
			helper.initModule(MOCK_CONFIG_CLI);
			helper.tasks = MOCK_TASKS;

			await helper.fetchInsights();

			const generateCall = helper.aiService.generateInsights.mock.calls[0];
			const tasksPassedToAI = generateCall[0];
			expect(tasksPassedToAI).toHaveLength(1);
			expect(tasksPassedToAI[0].status).not.toBe("completed");
		});

		test("sends error when AI not configured", async () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			const config = { ...MOCK_CONFIG_API, anthropicApiKey: "" };
			helper.initModule(config);

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).toHaveBeenCalledWith(
				"ERROR",
				expect.objectContaining({ type: "AI_NOT_CONFIGURED" })
			);
		});

		test("skips when no tasks available", async () => {
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
			helper.tasks = [];

			mockSendSocketNotification.mockClear();
			await helper.fetchInsights();

			expect(mockSendSocketNotification).not.toHaveBeenCalled();
		});

		test("sends ERROR on insight generation failure", async () => {
			ClaudeCLIService.mockImplementation(() => mockAIService({
				generateInsights: jest.fn().mockRejectedValue(new Error("API error"))
			}));

			jest.isolateModules(() => {
				helper = require("../node_helper");
			});
			helper.sendSocketNotification = mockSendSocketNotification;
			helper.startThoughtsApi = jest.fn();
			helper.start();
			helper.fetchTasks = jest.fn();
			helper.initModule(MOCK_CONFIG_CLI);
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
			helper.initModule(MOCK_CONFIG_CLI);

			expect(helper.taskTimer).toBeDefined();
			expect(helper.insightTimer).toBeDefined();

			helper.stop();
			helper.fetchTasks.mockClear();
			jest.advanceTimersByTime(MOCK_CONFIG_CLI.taskUpdateInterval * 2);
		});
	});
});
