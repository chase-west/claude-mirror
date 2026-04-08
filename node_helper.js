const NodeHelper = require("node_helper");
const MicrosoftTodoService = require("./services/microsoft-todo");
const ClaudeAIService = require("./services/claude-ai");
const path = require("path");

module.exports = NodeHelper.create({
	name: "MMM-ClaudeTaskMirror",

	start: function () {
		this.config = null;
		this.todoService = null;
		this.aiService = null;
		this.taskTimer = null;
		this.insightTimer = null;
		this.tasks = [];
		this.insights = null;
		this.started = false;
		console.log("[MMM-ClaudeTaskMirror] Node helper started.");
	},

	stop: function () {
		if (this.taskTimer) clearInterval(this.taskTimer);
		if (this.insightTimer) clearInterval(this.insightTimer);
		console.log("[MMM-ClaudeTaskMirror] Node helper stopped.");
	},

	socketNotificationReceived: function (notification, payload) {
		switch (notification) {
			case "INIT_MODULE":
				this.initModule(payload);
				break;
			case "FETCH_TASKS":
				this.fetchTasks();
				break;
			case "FETCH_INSIGHTS":
				this.fetchInsights();
				break;
			case "FORCE_REFRESH":
				this.fetchTasks();
				this.fetchInsights();
				break;
		}
	},

	initModule: function (config) {
		if (this.started) return;
		this.started = true;
		this.config = config;

		// Initialize Microsoft To Do service
		this.todoService = new MicrosoftTodoService({
			clientId: config.microsoftClientId,
			clientSecret: config.microsoftClientSecret,
			tokensPath: config.microsoftTokensPath || path.join(__dirname, "tokens.json")
		});

		// Initialize Claude AI service
		if (config.anthropicApiKey) {
			this.aiService = new ClaudeAIService({
				apiKey: config.anthropicApiKey,
				model: config.claudeModel || "claude-haiku-4-5-20251001",
				maxTokens: config.claudeMaxTokens || 1024
			});
			this.aiService.loadHistory();
		}

		// Initial fetch
		this.fetchTasks();

		// Set up periodic task fetching
		const taskInterval = config.taskUpdateInterval || 5 * 60 * 1000;
		this.taskTimer = setInterval(() => {
			this.fetchTasks();
		}, taskInterval);

		// Set up periodic insight generation
		if (this.aiService) {
			const insightInterval = config.insightUpdateInterval || 30 * 60 * 1000;
			this.insightTimer = setInterval(() => {
				this.fetchInsights();
			}, insightInterval);
		}

		console.log("[MMM-ClaudeTaskMirror] Module initialized.");
	},

	fetchTasks: async function () {
		try {
			const tasks = await this.todoService.getAllTasks(
				this.config.taskListName || null
			);
			this.tasks = tasks;

			this.sendSocketNotification("TASKS_UPDATED", {
				tasks: tasks,
				timestamp: Date.now()
			});

			// Record snapshot for pattern detection
			if (this.aiService) {
				this.aiService.recordTaskSnapshot(tasks);
			}

			// Auto-fetch insights after first task load if we have AI
			if (this.aiService && !this.insights) {
				this.fetchInsights();
			}

			console.log(`[MMM-ClaudeTaskMirror] Fetched ${tasks.length} tasks.`);
		} catch (error) {
			console.error("[MMM-ClaudeTaskMirror] Error fetching tasks:", error.message);
			this.sendSocketNotification("ERROR", {
				type: "TASK_FETCH_ERROR",
				message: error.message
			});
		}
	},

	fetchInsights: async function () {
		if (!this.aiService) {
			this.sendSocketNotification("ERROR", {
				type: "AI_NOT_CONFIGURED",
				message: "Claude AI is not configured. Add anthropicApiKey to config."
			});
			return;
		}

		if (!this.tasks || this.tasks.length === 0) {
			console.log("[MMM-ClaudeTaskMirror] No tasks to analyze yet.");
			return;
		}

		try {
			// Only send incomplete tasks for analysis
			const activeTasks = this.tasks.filter(
				(t) => t.status !== "completed"
			);

			const insights = await this.aiService.generateInsights(
				activeTasks,
				Date.now()
			);
			this.insights = insights;

			this.sendSocketNotification("INSIGHTS_UPDATED", {
				insights: insights,
				timestamp: Date.now()
			});

			console.log("[MMM-ClaudeTaskMirror] AI insights generated.");
		} catch (error) {
			console.error("[MMM-ClaudeTaskMirror] Error generating insights:", error.message);
			this.sendSocketNotification("ERROR", {
				type: "INSIGHT_ERROR",
				message: error.message
			});
		}
	}
});
