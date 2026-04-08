/* MagicMirror² Module: MMM-ClaudeTaskMirror
 * Microsoft To Do + Claude AI insights for your smart mirror.
 */
Module.register("MMM-ClaudeTaskMirror", {
	defaults: {
		// Microsoft To Do
		microsoftClientId: "",
		microsoftClientSecret: "",
		microsoftTokensPath: "",
		taskListName: null, // null = all lists

		// AI Provider: "claude-web" (default), "claude-api", "ollama"
		aiProvider: "claude-web",

		// Claude Web (uses your claude.ai login - run 'npm run auth:claude')
		claudeWebModel: "claude-sonnet-4-20250514",
		claudeSessionPath: "",

		// Claude API (optional - pay-per-use with API key)
		anthropicApiKey: "",
		claudeApiModel: "claude-haiku-4-5-20251001",
		claudeMaxTokens: 1024,

		// Ollama (optional - free local LLM)
		ollamaUrl: "http://localhost:11434",
		ollamaModel: "llama3.2",

		// Display
		maxTasks: 10,
		showCompleted: false,
		showInsights: true,
		showTimeBlocks: true,
		showPatterns: true,
		showDailyReminder: true,
		animateIn: true,

		// Update intervals (ms)
		taskUpdateInterval: 5 * 60 * 1000,    // 5 minutes
		insightUpdateInterval: 30 * 60 * 1000  // 30 minutes
	},

	getStyles: function () {
		return ["MMM-ClaudeTaskMirror.css", "font-awesome.css"];
	},

	start: function () {
		Log.info("[MMM-ClaudeTaskMirror] Starting module...");
		this.tasks = [];
		this.insights = null;
		this.lastTaskUpdate = null;
		this.lastInsightUpdate = null;
		this.error = null;
		this.loading = true;

		this.sendSocketNotification("INIT_MODULE", this.config);
	},

	socketNotificationReceived: function (notification, payload) {
		switch (notification) {
			case "TASKS_UPDATED":
				this.tasks = payload.tasks;
				this.lastTaskUpdate = payload.timestamp;
				this.loading = false;
				this.error = null;
				this.updateDom(this.config.animateIn ? 300 : 0);
				break;

			case "INSIGHTS_UPDATED":
				this.insights = payload.insights;
				this.lastInsightUpdate = payload.timestamp;
				this.updateDom(this.config.animateIn ? 300 : 0);
				break;

			case "ERROR":
				this.error = payload;
				this.loading = false;
				this.updateDom();
				break;
		}
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "claude-task-mirror";

		if (this.loading) {
			return this.buildLoadingView(wrapper);
		}

		if (this.error && this.tasks.length === 0) {
			return this.buildErrorView(wrapper);
		}

		// Daily reminder banner
		if (this.config.showDailyReminder && this.insights && this.insights.dailyReminder) {
			wrapper.appendChild(this.buildDailyReminder());
		}

		// Main content: tasks and insights side by side on wide mirrors,
		// stacked on narrow ones
		const content = document.createElement("div");
		content.className = "ctm-content";

		// Task list
		content.appendChild(this.buildTaskList());

		// AI insights panel
		if (this.config.showInsights && this.insights) {
			content.appendChild(this.buildInsightsPanel());
		}

		wrapper.appendChild(content);

		return wrapper;
	},

	buildLoadingView: function (wrapper) {
		const loading = document.createElement("div");
		loading.className = "ctm-loading";
		loading.innerHTML = "<i class=\"fa fa-spinner fa-pulse\"></i> Loading tasks...";
		wrapper.appendChild(loading);
		return wrapper;
	},

	buildErrorView: function (wrapper) {
		const errorDiv = document.createElement("div");
		errorDiv.className = "ctm-error";
		const icon = this.error.type === "TASK_FETCH_ERROR"
			? "fa-exclamation-triangle"
			: "fa-info-circle";
		errorDiv.innerHTML = `<i class="fa ${icon}"></i> ${this.error.message}`;
		wrapper.appendChild(errorDiv);
		return wrapper;
	},

	buildDailyReminder: function () {
		const reminder = document.createElement("div");
		reminder.className = "ctm-daily-reminder";
		reminder.innerHTML = `<i class="fa fa-lightbulb-o"></i> ${this.insights.dailyReminder}`;
		return reminder;
	},

	buildTaskList: function () {
		const container = document.createElement("div");
		container.className = "ctm-task-list";

		// Header
		const header = document.createElement("div");
		header.className = "ctm-section-header";
		header.innerHTML = "<i class=\"fa fa-check-square-o\"></i> Tasks";
		container.appendChild(header);

		// Filter tasks
		let displayTasks = this.tasks;
		if (!this.config.showCompleted) {
			displayTasks = displayTasks.filter((t) => t.status !== "completed");
		}

		// Apply priority ordering from AI if available
		if (this.insights && this.insights.priorityOrder && this.insights.priorityOrder.length > 0) {
			const priorityMap = new Map();
			this.insights.priorityOrder.forEach((p, idx) => {
				priorityMap.set(p.title.toLowerCase(), idx);
			});

			displayTasks = [...displayTasks].sort((a, b) => {
				const aIdx = priorityMap.has(a.title.toLowerCase())
					? priorityMap.get(a.title.toLowerCase())
					: 999;
				const bIdx = priorityMap.has(b.title.toLowerCase())
					? priorityMap.get(b.title.toLowerCase())
					: 999;
				return aIdx - bIdx;
			});
		}

		displayTasks = displayTasks.slice(0, this.config.maxTasks);

		if (displayTasks.length === 0) {
			const empty = document.createElement("div");
			empty.className = "ctm-empty";
			empty.textContent = "All caught up! No pending tasks.";
			container.appendChild(empty);
			return container;
		}

		const list = document.createElement("ul");
		list.className = "ctm-tasks";

		displayTasks.forEach((task) => {
			list.appendChild(this.buildTaskItem(task));
		});

		container.appendChild(list);

		// Task count
		const totalIncomplete = this.tasks.filter((t) => t.status !== "completed").length;
		if (totalIncomplete > this.config.maxTasks) {
			const more = document.createElement("div");
			more.className = "ctm-more-tasks";
			more.textContent = `+ ${totalIncomplete - this.config.maxTasks} more tasks`;
			container.appendChild(more);
		}

		return container;
	},

	buildTaskItem: function (task) {
		const li = document.createElement("li");
		li.className = `ctm-task ctm-importance-${task.importance}`;

		if (task.status === "completed") {
			li.classList.add("ctm-completed");
		}

		// Priority indicator
		const priority = document.createElement("span");
		priority.className = "ctm-priority";
		if (task.importance === "high") {
			priority.innerHTML = "<i class=\"fa fa-arrow-up\"></i>";
		} else if (task.importance === "low") {
			priority.innerHTML = "<i class=\"fa fa-arrow-down\"></i>";
		} else {
			priority.innerHTML = "<i class=\"fa fa-minus\"></i>";
		}
		li.appendChild(priority);

		// Task content
		const content = document.createElement("div");
		content.className = "ctm-task-content";

		const title = document.createElement("span");
		title.className = "ctm-task-title";
		title.textContent = task.title;
		content.appendChild(title);

		// Meta info line
		const meta = document.createElement("div");
		meta.className = "ctm-task-meta";

		if (task.listName) {
			const listBadge = document.createElement("span");
			listBadge.className = "ctm-list-badge";
			listBadge.textContent = task.listName;
			meta.appendChild(listBadge);
		}

		if (task.dueDateTime) {
			const due = document.createElement("span");
			due.className = "ctm-due-date";
			const dueDate = new Date(task.dueDateTime);
			const now = new Date();
			const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

			if (diffDays < 0) {
				due.classList.add("ctm-overdue");
				due.innerHTML = `<i class="fa fa-clock-o"></i> Overdue`;
			} else if (diffDays === 0) {
				due.classList.add("ctm-due-today");
				due.innerHTML = `<i class="fa fa-clock-o"></i> Due today`;
			} else if (diffDays === 1) {
				due.innerHTML = `<i class="fa fa-clock-o"></i> Tomorrow`;
			} else if (diffDays <= 7) {
				due.innerHTML = `<i class="fa fa-clock-o"></i> ${dueDate.toLocaleDateString("en-US", { weekday: "short" })}`;
			} else {
				due.innerHTML = `<i class="fa fa-clock-o"></i> ${dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
			}
			meta.appendChild(due);
		}

		content.appendChild(meta);
		li.appendChild(content);

		// AI priority reason (if available)
		if (this.insights && this.insights.priorityOrder) {
			const priorityInfo = this.insights.priorityOrder.find(
				(p) => p.title.toLowerCase() === task.title.toLowerCase()
			);
			if (priorityInfo && priorityInfo.reason) {
				const reason = document.createElement("div");
				reason.className = "ctm-ai-reason";
				reason.innerHTML = `<i class="fa fa-magic"></i> ${priorityInfo.reason}`;
				li.appendChild(reason);
			}
		}

		return li;
	},

	buildInsightsPanel: function () {
		const panel = document.createElement("div");
		panel.className = "ctm-insights-panel";

		// Time blocks
		if (this.config.showTimeBlocks && this.insights.timeBlocks && this.insights.timeBlocks.length > 0) {
			const timeSection = document.createElement("div");
			timeSection.className = "ctm-insights-section";

			const timeHeader = document.createElement("div");
			timeHeader.className = "ctm-section-header";
			timeHeader.innerHTML = "<i class=\"fa fa-calendar\"></i> Suggested Schedule";
			timeSection.appendChild(timeHeader);

			const timeList = document.createElement("ul");
			timeList.className = "ctm-time-blocks";

			this.insights.timeBlocks.forEach((block) => {
				const item = document.createElement("li");
				item.className = "ctm-time-block";
				item.innerHTML = `<span class="ctm-time">${block.time}</span>
					<span class="ctm-time-task">${block.task}</span>`;
				timeList.appendChild(item);
			});

			timeSection.appendChild(timeList);
			panel.appendChild(timeSection);
		}

		// Insights
		if (this.insights.insights && this.insights.insights.length > 0) {
			const insightSection = document.createElement("div");
			insightSection.className = "ctm-insights-section";

			const insightHeader = document.createElement("div");
			insightHeader.className = "ctm-section-header";
			insightHeader.innerHTML = "<i class=\"fa fa-magic\"></i> Insights";
			insightSection.appendChild(insightHeader);

			const insightList = document.createElement("ul");
			insightList.className = "ctm-insight-list";

			this.insights.insights.forEach((insight) => {
				const item = document.createElement("li");
				item.textContent = insight;
				insightList.appendChild(item);
			});

			insightSection.appendChild(insightList);
			panel.appendChild(insightSection);
		}

		// Patterns
		if (this.config.showPatterns && this.insights.patterns && this.insights.patterns.length > 0) {
			const patternSection = document.createElement("div");
			patternSection.className = "ctm-insights-section";

			const patternHeader = document.createElement("div");
			patternHeader.className = "ctm-section-header";
			patternHeader.innerHTML = "<i class=\"fa fa-repeat\"></i> Patterns";
			patternSection.appendChild(patternHeader);

			const patternList = document.createElement("ul");
			patternList.className = "ctm-pattern-list";

			this.insights.patterns.forEach((pattern) => {
				const item = document.createElement("li");
				item.textContent = pattern;
				patternList.appendChild(item);
			});

			patternSection.appendChild(patternList);
			panel.appendChild(patternSection);
		}

		return panel;
	}
});
