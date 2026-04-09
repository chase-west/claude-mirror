/**
 * Frontend module tests.
 * Since MagicMirror's Module.register isn't available in Node,
 * we mock the global and test the module definition.
 */

// --- Mock MagicMirror globals ---
const mockModule = {
	registered: null,
	register: function (name, definition) {
		this.registered = { name, definition };
	}
};

global.Module = mockModule;
global.Log = {
	info: jest.fn(),
	error: jest.fn(),
	warn: jest.fn()
};

// Mock DOM APIs
function createElement(tag) {
	const el = {
		tagName: tag.toUpperCase(),
		className: "",
		innerHTML: "",
		textContent: "",
		children: [],
		classList: {
			_classes: [],
			add: function (cls) { this._classes.push(cls); },
			contains: function (cls) { return this._classes.includes(cls); }
		},
		style: {},
		appendChild: function (child) {
			this.children.push(child);
			return child;
		},
		querySelectorAll: function () { return []; }
	};
	return el;
}

global.document = {
	createElement: jest.fn(createElement)
};

// Load the module (this calls Module.register)
require("../MMM-ClaudeTaskMirror");

// --- Mock Data ---
const MOCK_TASKS = [
	{
		id: "1",
		title: "Buy groceries",
		body: "Milk, eggs",
		status: "notStarted",
		importance: "high",
		listName: "Tasks",
		dueDateTime: new Date(Date.now() - 86400000).toISOString(), // yesterday (overdue)
		categories: ["errands"]
	},
	{
		id: "2",
		title: "Finish report",
		body: "",
		status: "notStarted",
		importance: "normal",
		listName: "Work",
		dueDateTime: new Date(Date.now()).toISOString(), // today
		categories: []
	},
	{
		id: "3",
		title: "Read book",
		body: "",
		status: "notStarted",
		importance: "low",
		listName: "Personal",
		dueDateTime: null,
		categories: []
	},
	{
		id: "4",
		title: "Done task",
		body: "",
		status: "completed",
		importance: "normal",
		listName: "Tasks",
		dueDateTime: null,
		categories: []
	}
];

const MOCK_INSIGHTS = {
	priorityOrder: [
		{ title: "Buy groceries", reason: "Overdue!" },
		{ title: "Finish report", reason: "Due today" }
	],
	timeBlocks: [
		{ time: "9:00 AM", task: "Finish report", reason: "Morning focus" },
		{ time: "12:00 PM", task: "Buy groceries", reason: "Lunch break" }
	],
	insights: [
		"You have an overdue task - tackle it first.",
		"Consider batch-processing errands."
	],
	patterns: ["You add grocery tasks every Monday."],
	dailyReminder: "Start with the overdue items to clear your plate."
};

// --- Tests ---

describe("MMM-ClaudeTaskMirror Frontend", () => {
	let mod;

	beforeEach(() => {
		mod = { ...mockModule.registered.definition };
		// Provide a mock config
		mod.config = { ...mod.defaults };
		// Stub sendSocketNotification
		mod.sendSocketNotification = jest.fn();
		// Stub updateDom
		mod.updateDom = jest.fn();
		// Reset createElement mock
		document.createElement.mockClear();
		document.createElement.mockImplementation(createElement);
	});

	describe("Registration", () => {
		test("registers with correct module name", () => {
			expect(mockModule.registered.name).toBe("MMM-ClaudeTaskMirror");
		});

		test("has required MagicMirror methods", () => {
			const def = mockModule.registered.definition;
			expect(typeof def.start).toBe("function");
			expect(typeof def.getDom).toBe("function");
			expect(typeof def.getStyles).toBe("function");
			expect(typeof def.socketNotificationReceived).toBe("function");
		});

		test("getStyles returns CSS file", () => {
			const styles = mod.getStyles();
			expect(styles).toContain("MMM-ClaudeTaskMirror.css");
		});
	});

	describe("start", () => {
		test("initializes state and sends INIT_MODULE", () => {
			mod.start();
			expect(mod.tasks).toEqual([]);
			expect(mod.insights).toBeNull();
			expect(mod.loading).toBe(true);
			expect(mod.sendSocketNotification).toHaveBeenCalledWith(
				"INIT_MODULE",
				mod.config
			);
		});
	});

	describe("socketNotificationReceived", () => {
		test("handles TASKS_UPDATED", () => {
			mod.start();
			mod.socketNotificationReceived("TASKS_UPDATED", {
				tasks: MOCK_TASKS,
				timestamp: Date.now()
			});

			expect(mod.tasks).toEqual(MOCK_TASKS);
			expect(mod.loading).toBe(false);
			expect(mod.error).toBeNull();
			expect(mod.updateDom).toHaveBeenCalled();
		});

		test("handles INSIGHTS_UPDATED", () => {
			mod.start();
			mod.socketNotificationReceived("INSIGHTS_UPDATED", {
				insights: MOCK_INSIGHTS,
				timestamp: Date.now()
			});

			expect(mod.insights).toEqual(MOCK_INSIGHTS);
			expect(mod.updateDom).toHaveBeenCalled();
		});

		test("handles ERROR", () => {
			mod.start();
			const error = { type: "TASK_FETCH_ERROR", message: "Network error" };
			mod.socketNotificationReceived("ERROR", error);

			expect(mod.error).toEqual(error);
			expect(mod.loading).toBe(false);
			expect(mod.updateDom).toHaveBeenCalled();
		});
	});

	describe("getDom", () => {
		test("shows loading state initially", () => {
			mod.start();
			const dom = mod.getDom();
			expect(dom.className).toBe("claude-task-mirror");
			// Should have a loading child
			const loadingChild = dom.children.find((c) =>
				c.className === "ctm-loading"
			);
			expect(loadingChild).toBeDefined();
		});

		test("shows error state when error and no tasks", () => {
			mod.start();
			mod.loading = false;
			mod.error = { type: "TASK_FETCH_ERROR", message: "Auth failed" };
			mod.tasks = [];

			const dom = mod.getDom();
			const errorChild = dom.children.find((c) =>
				c.className === "ctm-error"
			);
			expect(errorChild).toBeDefined();
			expect(errorChild.innerHTML).toContain("Auth failed");
		});

		test("shows tasks when loaded", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;

			const dom = mod.getDom();

			// Should have content div
			const content = dom.children.find((c) =>
				c.className === "ctm-content"
			);
			expect(content).toBeDefined();

			// Content should have task list
			const taskList = content.children.find((c) =>
				c.className === "ctm-task-list"
			);
			expect(taskList).toBeDefined();
		});

		test("shows daily reminder when insights available", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.insights = MOCK_INSIGHTS;

			const dom = mod.getDom();
			const reminder = dom.children.find((c) =>
				c.className === "ctm-daily-reminder"
			);
			expect(reminder).toBeDefined();
			expect(reminder.innerHTML).toContain(MOCK_INSIGHTS.dailyReminder);
		});

		test("hides daily reminder when config disabled", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.insights = MOCK_INSIGHTS;
			mod.config.showDailyReminder = false;

			const dom = mod.getDom();
			const reminder = dom.children.find((c) =>
				c.className === "ctm-daily-reminder"
			);
			expect(reminder).toBeUndefined();
		});

		test("shows insights panel when enabled and insights available", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.insights = MOCK_INSIGHTS;
			mod.config.showInsights = true;

			const dom = mod.getDom();
			const content = dom.children.find((c) => c.className === "ctm-content");
			const insightsPanel = content.children.find((c) =>
				c.className === "ctm-insights-panel"
			);
			expect(insightsPanel).toBeDefined();
		});
	});

	describe("buildTaskList", () => {
		test("filters out completed tasks by default", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.config.showCompleted = false;

			const taskListEl = mod.buildTaskList();
			const list = taskListEl.children.find((c) => c.className === "ctm-tasks");
			// 3 incomplete tasks out of 4 total
			expect(list.children.length).toBe(3);
		});

		test("shows completed tasks when configured", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.config.showCompleted = true;

			const taskListEl = mod.buildTaskList();
			const list = taskListEl.children.find((c) => c.className === "ctm-tasks");
			expect(list.children.length).toBe(4);
		});

		test("limits tasks to maxTasks config", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.config.maxTasks = 2;
			mod.config.showCompleted = false;

			const taskListEl = mod.buildTaskList();
			const list = taskListEl.children.find((c) => c.className === "ctm-tasks");
			expect(list.children.length).toBe(2);

			// Should show "+N more" message
			const more = taskListEl.children.find((c) =>
				c.className === "ctm-more-tasks"
			);
			expect(more).toBeDefined();
			expect(more.textContent).toContain("1 more");
		});

		test("shows empty state when no pending tasks", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = [{ ...MOCK_TASKS[3] }]; // only completed task

			const taskListEl = mod.buildTaskList();
			const empty = taskListEl.children.find((c) =>
				c.className === "ctm-empty"
			);
			expect(empty).toBeDefined();
			expect(empty.textContent).toContain("All caught up");
		});

		test("sorts tasks by AI priority order", () => {
			mod.start();
			mod.loading = false;
			mod.tasks = MOCK_TASKS;
			mod.insights = MOCK_INSIGHTS;

			const taskListEl = mod.buildTaskList();
			const list = taskListEl.children.find((c) => c.className === "ctm-tasks");

			// First task should be "Buy groceries" per AI priority
			const firstTaskContent = list.children[0].children.find(
				(c) => c.className === "ctm-task-content"
			);
			const titleEl = firstTaskContent.children.find(
				(c) => c.className === "ctm-task-title"
			);
			expect(titleEl.textContent).toBe("Buy groceries");
		});
	});

	describe("buildTaskItem", () => {
		test("renders task with priority indicator", () => {
			mod.start();
			const item = mod.buildTaskItem(MOCK_TASKS[0]);

			expect(item.className).toContain("ctm-importance-high");
			const priority = item.children.find((c) =>
				c.className === "ctm-priority"
			);
			expect(priority.innerHTML).toContain("fa-arrow-up");
		});

		test("renders low priority indicator", () => {
			mod.start();
			const item = mod.buildTaskItem(MOCK_TASKS[2]);

			expect(item.className).toContain("ctm-importance-low");
			const priority = item.children.find((c) =>
				c.className === "ctm-priority"
			);
			expect(priority.innerHTML).toContain("fa-arrow-down");
		});

		test("renders completed task with strikethrough class", () => {
			mod.start();
			const item = mod.buildTaskItem(MOCK_TASKS[3]);
			expect(item.classList._classes).toContain("ctm-completed");
		});

		test("renders list badge", () => {
			mod.start();
			const item = mod.buildTaskItem(MOCK_TASKS[0]);
			const content = item.children.find((c) =>
				c.className === "ctm-task-content"
			);
			const meta = content.children.find((c) =>
				c.className === "ctm-task-meta"
			);
			const badge = meta.children.find((c) =>
				c.className === "ctm-list-badge"
			);
			expect(badge.textContent).toBe("Tasks");
		});

		test("shows overdue indicator for past due tasks", () => {
			mod.start();
			const item = mod.buildTaskItem(MOCK_TASKS[0]); // overdue task
			const content = item.children.find((c) =>
				c.className === "ctm-task-content"
			);
			const meta = content.children.find((c) =>
				c.className === "ctm-task-meta"
			);
			const due = meta.children.find((c) =>
				c.className && c.className.includes("ctm-due-date")
			);
			expect(due).toBeDefined();
			expect(due.classList._classes).toContain("ctm-overdue");
			expect(due.innerHTML).toContain("Overdue");
		});

		test("shows AI reason when insights available", () => {
			mod.start();
			mod.insights = MOCK_INSIGHTS;

			const item = mod.buildTaskItem(MOCK_TASKS[0]); // "Buy groceries"
			const reason = item.children.find((c) =>
				c.className === "ctm-ai-reason"
			);
			expect(reason).toBeDefined();
			expect(reason.innerHTML).toContain("Overdue!");
		});

		test("skips AI reason when no insights", () => {
			mod.start();
			mod.insights = null;

			const item = mod.buildTaskItem(MOCK_TASKS[0]);
			const reason = item.children.find((c) =>
				c.className === "ctm-ai-reason"
			);
			expect(reason).toBeUndefined();
		});
	});

	describe("buildInsightsPanel", () => {
		test("renders time blocks section", () => {
			mod.start();
			mod.insights = MOCK_INSIGHTS;

			const panel = mod.buildInsightsPanel();
			expect(panel.className).toBe("ctm-insights-panel");

			// Should have sections
			const sections = panel.children.filter((c) =>
				c.className === "ctm-insights-section"
			);
			expect(sections.length).toBeGreaterThanOrEqual(2); // time blocks + insights
		});

		test("renders insights list", () => {
			mod.start();
			mod.insights = MOCK_INSIGHTS;

			const panel = mod.buildInsightsPanel();
			// Find the insight list
			let insightList = null;
			panel.children.forEach((section) => {
				section.children.forEach((child) => {
					if (child.className === "ctm-insight-list") {
						insightList = child;
					}
				});
			});
			expect(insightList).not.toBeNull();
			expect(insightList.children.length).toBe(2);
		});

		test("renders patterns section", () => {
			mod.start();
			mod.insights = MOCK_INSIGHTS;
			mod.config.showPatterns = true;

			const panel = mod.buildInsightsPanel();
			let patternList = null;
			panel.children.forEach((section) => {
				section.children.forEach((child) => {
					if (child.className === "ctm-pattern-list") {
						patternList = child;
					}
				});
			});
			expect(patternList).not.toBeNull();
			expect(patternList.children.length).toBe(1);
		});

		test("hides time blocks when config disabled", () => {
			mod.start();
			mod.insights = MOCK_INSIGHTS;
			mod.config.showTimeBlocks = false;

			const panel = mod.buildInsightsPanel();
			let timeBlocks = null;
			panel.children.forEach((section) => {
				section.children.forEach((child) => {
					if (child.className === "ctm-time-blocks") {
						timeBlocks = child;
					}
				});
			});
			expect(timeBlocks).toBeNull();
		});
	});

	describe("Default Configuration", () => {
		test("has sensible defaults", () => {
			const defaults = mockModule.registered.definition.defaults;

			expect(defaults.maxTasks).toBe(5);
			expect(defaults.showCompleted).toBe(false);
			expect(defaults.showInsights).toBe(false);
			expect(defaults.showTimeBlocks).toBe(true);
			expect(defaults.showPatterns).toBe(false);
			expect(defaults.showDailyReminder).toBe(true);
			expect(defaults.taskUpdateInterval).toBe(300000); // 5 min
			expect(defaults.insightUpdateInterval).toBe(1800000); // 30 min
		});
	});
});
