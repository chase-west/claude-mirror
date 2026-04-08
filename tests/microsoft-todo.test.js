const path = require("path");
const fs = require("fs");
const MicrosoftTodoService = require("../services/microsoft-todo");

// --- Mock Data ---
const MOCK_TOKENS = {
	access_token: "mock-access-token-123",
	refresh_token: "mock-refresh-token-456",
	expires_at: Date.now() + 3600000 // 1 hour from now
};

const MOCK_EXPIRED_TOKENS = {
	access_token: "expired-token",
	refresh_token: "mock-refresh-token-456",
	expires_at: Date.now() - 60000 // expired 1 minute ago
};

const MOCK_TASK_LISTS = {
	value: [
		{ id: "list-1", displayName: "Tasks" },
		{ id: "list-2", displayName: "Shopping" },
		{ id: "list-3", displayName: "Work" }
	]
};

const MOCK_TASKS_LIST1 = {
	value: [
		{
			id: "task-1",
			title: "Buy groceries",
			body: { content: "Milk, eggs, bread" },
			status: "notStarted",
			importance: "high",
			isReminderOn: true,
			reminderDateTime: { dateTime: "2024-01-15T09:00:00Z" },
			dueDateTime: { dateTime: "2024-01-15T23:59:00Z" },
			completedDateTime: null,
			createdDateTime: "2024-01-10T08:00:00Z",
			lastModifiedDateTime: "2024-01-10T08:00:00Z",
			categories: ["errands"]
		},
		{
			id: "task-2",
			title: "Call dentist",
			body: null,
			status: "notStarted",
			importance: "normal",
			isReminderOn: false,
			reminderDateTime: null,
			dueDateTime: null,
			completedDateTime: null,
			createdDateTime: "2024-01-11T10:00:00Z",
			lastModifiedDateTime: "2024-01-11T10:00:00Z",
			categories: []
		}
	]
};

const MOCK_TASKS_LIST2 = {
	value: [
		{
			id: "task-3",
			title: "Get milk",
			body: null,
			status: "completed",
			importance: "normal",
			isReminderOn: false,
			reminderDateTime: null,
			dueDateTime: null,
			completedDateTime: { dateTime: "2024-01-12T14:00:00Z" },
			createdDateTime: "2024-01-09T08:00:00Z",
			lastModifiedDateTime: "2024-01-12T14:00:00Z",
			categories: []
		}
	]
};

// --- Helper to create mock fetch ---
function createMockFetch(responses) {
	const calls = [];
	const mockFn = async (url, options) => {
		calls.push({ url, options });
		const handler = responses.find((r) => url.includes(r.match));
		if (!handler) {
			return {
				ok: false,
				status: 404,
				text: async () => "Not found",
				json: async () => ({ error: "not found" })
			};
		}
		if (typeof handler.response === "function") {
			return handler.response(url, options, calls.length);
		}
		return handler.response;
	};
	mockFn.calls = calls;
	return mockFn;
}

function okJson(data) {
	return {
		ok: true,
		status: 200,
		json: async () => data,
		text: async () => JSON.stringify(data)
	};
}

function errorResponse(status, message) {
	return {
		ok: false,
		status,
		json: async () => ({ error: message }),
		text: async () => message
	};
}

// --- Tests ---

describe("MicrosoftTodoService", () => {
	let tmpTokensPath;

	beforeEach(() => {
		tmpTokensPath = path.join(__dirname, `test-tokens-${Date.now()}.json`);
	});

	afterEach(() => {
		try {
			fs.unlinkSync(tmpTokensPath);
		} catch {
			// file may not exist
		}
	});

	describe("Token Management", () => {
		test("loadTokens returns true when tokens file exists", async () => {
			fs.writeFileSync(tmpTokensPath, JSON.stringify(MOCK_TOKENS));
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath
			});
			const result = await service.loadTokens();
			expect(result).toBe(true);
			expect(service.tokens).toEqual(MOCK_TOKENS);
		});

		test("loadTokens returns false when tokens file missing", async () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: "/nonexistent/tokens.json"
			});
			const result = await service.loadTokens();
			expect(result).toBe(false);
			expect(service.tokens).toBeNull();
		});

		test("saveTokens writes tokens to disk", () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath
			});
			service.tokens = MOCK_TOKENS;
			service.saveTokens();

			const saved = JSON.parse(fs.readFileSync(tmpTokensPath, "utf8"));
			expect(saved.access_token).toBe(MOCK_TOKENS.access_token);
			expect(saved.refresh_token).toBe(MOCK_TOKENS.refresh_token);
		});

		test("refreshAccessToken calls token endpoint and saves new tokens", async () => {
			const newTokenData = {
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600
			};

			const mockFetch = createMockFetch([
				{
					match: "login.microsoftonline.com",
					response: okJson(newTokenData)
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_EXPIRED_TOKENS;

			const token = await service.refreshAccessToken();
			expect(token).toBe("new-access-token");
			expect(service.tokens.refresh_token).toBe("new-refresh-token");
			expect(mockFetch.calls).toHaveLength(1);
			expect(mockFetch.calls[0].url).toContain("token");
		});

		test("refreshAccessToken throws when no refresh token", async () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath
			});
			service.tokens = { access_token: "abc" };

			await expect(service.refreshAccessToken()).rejects.toThrow(
				"No refresh token available"
			);
		});

		test("refreshAccessToken throws on API error", async () => {
			const mockFetch = createMockFetch([
				{
					match: "login.microsoftonline.com",
					response: errorResponse(400, "invalid_grant")
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_EXPIRED_TOKENS;

			await expect(service.refreshAccessToken()).rejects.toThrow(
				"Token refresh failed"
			);
		});

		test("getAccessToken returns existing token if not expired", async () => {
			fs.writeFileSync(tmpTokensPath, JSON.stringify(MOCK_TOKENS));
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath
			});

			const token = await service.getAccessToken();
			expect(token).toBe(MOCK_TOKENS.access_token);
		});

		test("getAccessToken refreshes if token is near expiry", async () => {
			const nearExpiry = {
				...MOCK_TOKENS,
				expires_at: Date.now() + 30000 // 30 seconds left (< 60s threshold)
			};
			fs.writeFileSync(tmpTokensPath, JSON.stringify(nearExpiry));

			const mockFetch = createMockFetch([
				{
					match: "login.microsoftonline.com",
					response: okJson({
						access_token: "refreshed-token",
						refresh_token: "new-refresh",
						expires_in: 3600
					})
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});

			const token = await service.getAccessToken();
			expect(token).toBe("refreshed-token");
		});

		test("getAccessToken throws when no tokens file", async () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: "/nonexistent/path/tokens.json"
			});

			await expect(service.getAccessToken()).rejects.toThrow(
				"No tokens found"
			);
		});
	});

	describe("Graph API Requests", () => {
		test("graphRequest makes authenticated GET request", async () => {
			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: okJson({ value: ["test"] })
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const result = await service.graphRequest("/me/todo/lists");
			expect(result).toEqual({ value: ["test"] });
			expect(mockFetch.calls[0].options.headers.Authorization)
				.toBe(`Bearer ${MOCK_TOKENS.access_token}`);
		});

		test("graphRequest retries with refreshed token on 401", async () => {
			let callCount = 0;
			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: (url, options, count) => {
						callCount++;
						if (callCount === 1) {
							return errorResponse(401, "Unauthorized");
						}
						return okJson({ value: ["success"] });
					}
				},
				{
					match: "login.microsoftonline.com",
					response: okJson({
						access_token: "fresh-token",
						refresh_token: "fresh-refresh",
						expires_in: 3600
					})
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const result = await service.graphRequest("/me/todo/lists");
			expect(result).toEqual({ value: ["success"] });
		});

		test("graphRequest throws on non-401 error", async () => {
			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: errorResponse(500, "Server error")
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			await expect(service.graphRequest("/me/todo/lists")).rejects.toThrow(
				"Graph API error (500)"
			);
		});
	});

	describe("Task Fetching", () => {
		test("fetchTaskLists returns list array", async () => {
			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: okJson(MOCK_TASK_LISTS)
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const lists = await service.fetchTaskLists();
			expect(lists).toHaveLength(3);
			expect(lists[0].displayName).toBe("Tasks");
		});

		test("fetchTasks returns tasks for a list", async () => {
			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: okJson(MOCK_TASKS_LIST1)
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const tasks = await service.fetchTasks("list-1");
			expect(tasks).toHaveLength(2);
			expect(tasks[0].title).toBe("Buy groceries");
		});

		test("getAllTasks combines tasks from all lists", async () => {
			let callIndex = 0;
			const responses = [MOCK_TASK_LISTS, MOCK_TASKS_LIST1, MOCK_TASKS_LIST2, { value: [] }];

			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: () => {
						const resp = responses[callIndex] || { value: [] };
						callIndex++;
						return okJson(resp);
					}
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const tasks = await service.getAllTasks();
			expect(tasks).toHaveLength(3);
			expect(tasks[0].listName).toBe("Tasks");
			expect(tasks[2].listName).toBe("Shopping");
		});

		test("getAllTasks filters by list name", async () => {
			let callIndex = 0;
			const responses = [MOCK_TASK_LISTS, MOCK_TASKS_LIST2];

			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: () => {
						const resp = responses[callIndex] || { value: [] };
						callIndex++;
						return okJson(resp);
					}
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const tasks = await service.getAllTasks("Shopping");
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe("Get milk");
		});

		test("getAllTasks normalizes task structure", async () => {
			let callIndex = 0;
			const responses = [
				{ value: [{ id: "list-1", displayName: "Tasks" }] },
				MOCK_TASKS_LIST1
			];

			const mockFetch = createMockFetch([
				{
					match: "graph.microsoft.com",
					response: () => {
						const resp = responses[callIndex] || { value: [] };
						callIndex++;
						return okJson(resp);
					}
				}
			]);

			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret",
				tokensPath: tmpTokensPath,
				fetch: mockFetch
			});
			service.tokens = MOCK_TOKENS;

			const tasks = await service.getAllTasks();
			const task = tasks[0];

			expect(task).toHaveProperty("id");
			expect(task).toHaveProperty("title");
			expect(task).toHaveProperty("body");
			expect(task).toHaveProperty("status");
			expect(task).toHaveProperty("importance");
			expect(task).toHaveProperty("dueDateTime");
			expect(task).toHaveProperty("listName");
			expect(task).toHaveProperty("categories");
			expect(task.body).toBe("Milk, eggs, bread");
			expect(task.dueDateTime).toBe("2024-01-15T23:59:00Z");
		});
	});

	describe("isAuthenticated", () => {
		test("returns false when no tokens", () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret"
			});
			expect(service.isAuthenticated()).toBe(false);
		});

		test("returns true when tokens exist", () => {
			const service = new MicrosoftTodoService({
				clientId: "test-id",
				clientSecret: "test-secret"
			});
			service.tokens = MOCK_TOKENS;
			expect(service.isAuthenticated()).toBe(true);
		});
	});
});
