const path = require("path");
const fs = require("fs");
const ClaudeWebService = require("../services/claude-web");

// --- Mock Data ---
const MOCK_SESSION = {
	sessionKey: "sk-ant-test-session-key-123",
	orgId: "org-uuid-456"
};

const MOCK_ORGS = [
	{ uuid: "org-uuid-456", name: "Personal" }
];

const MOCK_CONVERSATION = { uuid: "conv-uuid-789" };

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

// SSE format with completion field
const MOCK_SSE_RESPONSE_COMPLETION = [
	'data: {"completion": "{\\"priorityOrder\\": [{\\"title\\": \\"Test task\\", \\"reason\\": \\"High priority\\"}], ", "stop_reason": null}',
	'data: {"completion": "\\"timeBlocks\\": [{\\"time\\": \\"9:00 AM\\", \\"task\\": \\"Test task\\", \\"reason\\": \\"Morning focus\\"}], ", "stop_reason": null}',
	'data: {"completion": "\\"insights\\": [\\"Focus on high priority items first.\\"], ", "stop_reason": null}',
	'data: {"completion": "\\"patterns\\": [], ", "stop_reason": null}',
	'data: {"completion": "\\"dailyReminder\\": \\"You\'ve got this!\\"}", "stop_reason": "end_turn"}',
].join("\n");

// SSE format with delta field
const MOCK_SSE_RESPONSE_DELTA = [
	'data: {"delta": {"text": "{\\"priorityOrder\\": [], "}}',
	'data: {"delta": {"text": "\\"timeBlocks\\": [], "}}',
	'data: {"delta": {"text": "\\"insights\\": [\\"Be productive.\\"], "}}',
	'data: {"delta": {"text": "\\"patterns\\": [], "}}',
	'data: {"delta": {"text": "\\"dailyReminder\\": \\"Go!\\"}"}}',
	'data: [DONE]',
].join("\n");

// SSE with content_block_delta
const MOCK_SSE_RESPONSE_BLOCK = [
	'data: {"type": "content_block_delta", "delta": {"text": "{\\"priorityOrder\\": [], "}}',
	'data: {"type": "content_block_delta", "delta": {"text": "\\"timeBlocks\\": [], \\"insights\\": [], \\"patterns\\": [], \\"dailyReminder\\": \\"Hey!\\"}"}}',
].join("\n");

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

// --- Helpers ---
function okJson(data) {
	return {
		ok: true,
		status: 200,
		json: async () => data,
		text: async () => JSON.stringify(data)
	};
}

function okText(text) {
	return {
		ok: true,
		status: 200,
		text: async () => text,
		json: async () => JSON.parse(text)
	};
}

function errorResponse(status, message) {
	return {
		ok: false,
		status,
		text: async () => message,
		json: async () => ({ error: message })
	};
}

function createMockFetch(handlers) {
	const calls = [];
	const mockFn = async (url, options) => {
		calls.push({ url, options });
		for (const handler of handlers) {
			if (url.includes(handler.match)) {
				if (typeof handler.response === "function") {
					return handler.response(url, options);
				}
				return handler.response;
			}
		}
		return errorResponse(404, "Not found");
	};
	mockFn.calls = calls;
	return mockFn;
}

// --- Tests ---
describe("ClaudeWebService", () => {
	let tmpSessionPath;

	beforeEach(() => {
		tmpSessionPath = path.join(__dirname, `test-session-${Date.now()}.json`);
	});

	afterEach(() => {
		try { fs.unlinkSync(tmpSessionPath); } catch { /* ignore */ }
	});

	describe("Session Management", () => {
		test("loadSession returns true when session file exists", async () => {
			fs.writeFileSync(tmpSessionPath, JSON.stringify(MOCK_SESSION));
			const service = new ClaudeWebService({ sessionPath: tmpSessionPath });

			const result = await service.loadSession();
			expect(result).toBe(true);
			expect(service.sessionKey).toBe(MOCK_SESSION.sessionKey);
			expect(service.orgId).toBe(MOCK_SESSION.orgId);
		});

		test("loadSession returns false when file missing", async () => {
			const service = new ClaudeWebService({ sessionPath: "/nonexistent/session.json" });
			const result = await service.loadSession();
			expect(result).toBe(false);
		});

		test("loadSession skips if sessionKey already set", async () => {
			const service = new ClaudeWebService({
				sessionKey: "already-set",
				sessionPath: tmpSessionPath
			});
			const result = await service.loadSession();
			expect(result).toBe(true);
			expect(service.sessionKey).toBe("already-set");
		});

		test("saveSession writes to disk", () => {
			const service = new ClaudeWebService({ sessionPath: tmpSessionPath });
			service.sessionKey = "test-key";
			service.orgId = "test-org";
			service.saveSession();

			const saved = JSON.parse(fs.readFileSync(tmpSessionPath, "utf8"));
			expect(saved.sessionKey).toBe("test-key");
			expect(saved.orgId).toBe("test-org");
		});
	});

	describe("getHeaders", () => {
		test("includes session cookie", () => {
			const service = new ClaudeWebService({ sessionKey: "my-key" });
			const headers = service.getHeaders();
			expect(headers.Cookie).toBe("sessionKey=my-key");
			expect(headers["Content-Type"]).toBe("application/json");
		});
	});

	describe("fetchOrgId", () => {
		test("fetches and stores org ID", async () => {
			const mockFetch = createMockFetch([
				{ match: "/api/organizations", response: okJson(MOCK_ORGS) }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				sessionPath: tmpSessionPath,
				fetch: mockFetch
			});

			const orgId = await service.fetchOrgId();
			expect(orgId).toBe("org-uuid-456");
			expect(service.orgId).toBe("org-uuid-456");
		});

		test("throws on 401 (expired session)", async () => {
			const mockFetch = createMockFetch([
				{ match: "/api/organizations", response: errorResponse(401, "Unauthorized") }
			]);
			const service = new ClaudeWebService({
				sessionKey: "expired",
				fetch: mockFetch
			});

			await expect(service.fetchOrgId()).rejects.toThrow("Session expired");
		});

		test("throws when no orgs found", async () => {
			const mockFetch = createMockFetch([
				{ match: "/api/organizations", response: okJson([]) }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				fetch: mockFetch
			});

			await expect(service.fetchOrgId()).rejects.toThrow("No organizations found");
		});
	});

	describe("createConversation", () => {
		test("creates and returns conversation ID", async () => {
			const mockFetch = createMockFetch([
				{ match: "/chat_conversations", response: okJson(MOCK_CONVERSATION) }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			const convId = await service.createConversation();
			expect(convId).toBe("conv-uuid-789");

			// Verify request body
			const body = JSON.parse(mockFetch.calls[0].options.body);
			expect(body.model).toBe("claude-sonnet-4-20250514");
		});

		test("throws on API error", async () => {
			const mockFetch = createMockFetch([
				{ match: "/chat_conversations", response: errorResponse(500, "Server error") }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			await expect(service.createConversation()).rejects.toThrow("Failed to create conversation");
		});
	});

	describe("sendMessage", () => {
		test("sends message and returns parsed SSE response", async () => {
			const mockFetch = createMockFetch([
				{ match: "/completion", response: okText(MOCK_SSE_RESPONSE_COMPLETION) }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			const result = await service.sendMessage("conv-1", "Hello");
			expect(result).toContain("priorityOrder");
			expect(result).toContain("Test task");
		});

		test("throws on 403 with session expired message", async () => {
			const mockFetch = createMockFetch([
				{ match: "/completion", response: errorResponse(403, "Forbidden") }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			await expect(service.sendMessage("conv-1", "Hello")).rejects.toThrow("Session expired");
		});
	});

	describe("parseSSE", () => {
		test("parses completion format", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.parseSSE(MOCK_SSE_RESPONSE_COMPLETION);
			expect(result).toContain("priorityOrder");
			expect(result).toContain("dailyReminder");
		});

		test("parses delta format", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.parseSSE(MOCK_SSE_RESPONSE_DELTA);
			expect(result).toContain("priorityOrder");
			expect(result).toContain("dailyReminder");
		});

		test("parses content_block_delta format", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.parseSSE(MOCK_SSE_RESPONSE_BLOCK);
			expect(result).toContain("priorityOrder");
			expect(result).toContain("dailyReminder");
		});

		test("handles empty/malformed lines", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.parseSSE("event: ping\n\ndata: not-json\ndata: [DONE]\n");
			expect(result).toBe("");
		});
	});

	describe("deleteConversation", () => {
		test("sends DELETE request", async () => {
			const mockFetch = createMockFetch([
				{ match: "/chat_conversations", response: okJson({}) }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			await service.deleteConversation("conv-1");
			expect(mockFetch.calls[0].options.method).toBe("DELETE");
		});

		test("silently handles errors", async () => {
			const mockFetch = createMockFetch([
				{ match: "/chat_conversations", response: errorResponse(500, "fail") }
			]);
			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				fetch: mockFetch
			});

			// Should not throw
			await expect(service.deleteConversation("conv-1")).resolves.not.toThrow();
		});
	});

	describe("generateInsights", () => {
		test("full flow: create conv → send → parse → delete", async () => {
			const insightsJson = JSON.stringify(MOCK_INSIGHTS);
			const sseResponse = `data: {"completion": ${JSON.stringify(insightsJson)}, "stop_reason": "end_turn"}`;

			const mockFetch = createMockFetch([
				{
					match: "/completion",
					response: okText(sseResponse)
				},
				{
					match: "/chat_conversations",
					response: (url, options) => {
						if (options && options.method === "DELETE") return okJson({});
						return okJson(MOCK_CONVERSATION);
					}
				}
			]);

			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				sessionPath: tmpSessionPath,
				fetch: mockFetch
			});

			const insights = await service.generateInsights(MOCK_TASKS);

			expect(insights.priorityOrder).toHaveLength(1);
			expect(insights.priorityOrder[0].title).toBe("Test task");
			expect(insights.timeBlocks).toHaveLength(1);
			expect(insights.dailyReminder).toBe("You've got this!");

			// Should have made 3 calls: create conv, send message, delete conv
			expect(mockFetch.calls).toHaveLength(3);
		});

		test("loads session from file if no key set", async () => {
			fs.writeFileSync(tmpSessionPath, JSON.stringify(MOCK_SESSION));

			const insightsJson = JSON.stringify(MOCK_INSIGHTS);
			const sseResponse = `data: {"completion": ${JSON.stringify(insightsJson)}, "stop_reason": "end_turn"}`;

			const mockFetch = createMockFetch([
				{ match: "/completion", response: okText(sseResponse) },
				{
					match: "/chat_conversations",
					response: (url, options) => {
						if (options && options.method === "DELETE") return okJson({});
						return okJson(MOCK_CONVERSATION);
					}
				}
			]);

			const service = new ClaudeWebService({
				sessionPath: tmpSessionPath,
				fetch: mockFetch
			});

			const insights = await service.generateInsights(MOCK_TASKS);
			expect(insights.priorityOrder).toBeDefined();
			expect(service.sessionKey).toBe(MOCK_SESSION.sessionKey);
		});

		test("throws when no session available", async () => {
			const service = new ClaudeWebService({
				sessionPath: "/nonexistent/session.json",
				fetch: createMockFetch([])
			});

			await expect(service.generateInsights(MOCK_TASKS)).rejects.toThrow(
				"No Claude session found"
			);
		});

		test("cleans up conversation even on error", async () => {
			const mockFetch = createMockFetch([
				{ match: "/completion", response: errorResponse(500, "Internal error") },
				{
					match: "/chat_conversations",
					response: (url, options) => {
						if (options && options.method === "DELETE") return okJson({});
						return okJson(MOCK_CONVERSATION);
					}
				}
			]);

			const service = new ClaudeWebService({
				sessionKey: "test",
				orgId: "org-1",
				sessionPath: tmpSessionPath,
				fetch: mockFetch
			});

			await expect(service.generateInsights(MOCK_TASKS)).rejects.toThrow();

			// Should still have called delete (3 calls: create, send, delete)
			const deleteCalls = mockFetch.calls.filter(
				(c) => c.options && c.options.method === "DELETE"
			);
			expect(deleteCalls).toHaveLength(1);
		});
	});

	describe("inherits AIBase", () => {
		test("has formatTasksForPrompt", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.formatTasksForPrompt(MOCK_TASKS);
			expect(result).toContain("Test task");
		});

		test("has buildPrompt", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const prompt = service.buildPrompt(MOCK_TASKS, Date.now());
			expect(prompt).toContain("task scheduler");
			expect(prompt).toContain("Test task");
		});

		test("has parseInsightsResponse", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			const result = service.parseInsightsResponse(JSON.stringify(MOCK_INSIGHTS));
			expect(result.priorityOrder).toHaveLength(1);
		});

		test("has task history methods", () => {
			const service = new ClaudeWebService({ sessionKey: "test" });
			service.saveHistory = jest.fn();
			service.recordTaskSnapshot(MOCK_TASKS);
			expect(service.taskHistory).toHaveLength(1);
		});
	});
});
