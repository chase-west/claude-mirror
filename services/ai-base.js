const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "task-history.json");
const MAX_SNAPSHOTS = 500;
const MAX_COMPLETIONS = 200;
const MAX_PATTERNS = 50;

class AIBase {
	constructor() {
		this.taskHistory = [];
		this.completions = [];
		this.learnedPatterns = [];
		this._lastTaskMap = null; // for detecting completions
	}

	// --- Persistence ---

	loadHistory() {
		try {
			const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
			this.taskHistory = data.snapshots || [];
			this.completions = data.completions || [];
			this.learnedPatterns = data.patterns || [];
		} catch {
			this.taskHistory = [];
			this.completions = [];
			this.learnedPatterns = [];
		}
	}

	saveHistory() {
		if (!fs.existsSync(DATA_DIR)) {
			fs.mkdirSync(DATA_DIR, { recursive: true });
		}
		// Trim to limits
		if (this.taskHistory.length > MAX_SNAPSHOTS) {
			this.taskHistory = this.taskHistory.slice(-MAX_SNAPSHOTS);
		}
		if (this.completions.length > MAX_COMPLETIONS) {
			this.completions = this.completions.slice(-MAX_COMPLETIONS);
		}
		if (this.learnedPatterns.length > MAX_PATTERNS) {
			this.learnedPatterns = this.learnedPatterns.slice(-MAX_PATTERNS);
		}
		fs.writeFileSync(HISTORY_FILE, JSON.stringify({
			snapshots: this.taskHistory,
			completions: this.completions,
			patterns: this.learnedPatterns
		}, null, 2));
	}

	// --- Task Tracking ---

	recordTaskSnapshot(tasks) {
		// Detect completions by comparing with previous snapshot
		this._detectCompletions(tasks);

		const snapshot = {
			timestamp: new Date().toISOString(),
			dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long" }),
			tasks: tasks.map((t) => ({
				title: t.title,
				status: t.status,
				importance: t.importance,
				listName: t.listName,
				dueDateTime: t.dueDateTime
			}))
		};
		this.taskHistory.push(snapshot);
		this.saveHistory();
	}

	_detectCompletions(currentTasks) {
		if (!this._lastTaskMap) {
			// First run - build the map for next comparison
			this._lastTaskMap = new Map();
			for (const task of currentTasks) {
				this._lastTaskMap.set(task.id || task.title, task.status);
			}
			return;
		}

		const now = new Date();
		for (const task of currentTasks) {
			const key = task.id || task.title;
			const prevStatus = this._lastTaskMap.get(key);

			// Task was previously not completed but now is
			if (prevStatus && prevStatus !== "completed" && task.status === "completed") {
				this.completions.push({
					timestamp: now.toISOString(),
					dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
					hour: now.getHours(),
					title: task.title,
					listName: task.listName,
					importance: task.importance
				});
			}
		}

		// Rebuild map
		this._lastTaskMap = new Map();
		for (const task of currentTasks) {
			this._lastTaskMap.set(task.id || task.title, task.status);
		}
	}

	// --- Pattern Persistence ---

	saveLearnedPatterns(newPatterns) {
		if (!newPatterns || newPatterns.length === 0) return;

		for (const pattern of newPatterns) {
			// Avoid duplicates (fuzzy match by checking if pattern is very similar)
			const isDuplicate = this.learnedPatterns.some(
				(existing) => existing.toLowerCase() === pattern.toLowerCase()
			);
			if (!isDuplicate) {
				this.learnedPatterns.push(pattern);
			}
		}
		this.saveHistory();
	}

	// --- Prompt Building ---

	formatTasksForPrompt(tasks) {
		if (!tasks || tasks.length === 0) return "No tasks found.";

		return tasks
			.map((t, i) => {
				const parts = [`${i + 1}. "${t.title}"`];
				parts.push(`   Status: ${t.status}`);
				parts.push(`   Priority: ${t.importance}`);
				if (t.listName) parts.push(`   List: ${t.listName}`);
				if (t.dueDateTime) parts.push(`   Due: ${t.dueDateTime}`);
				if (t.body) parts.push(`   Notes: ${t.body.substring(0, 100)}`);
				if (t.categories && t.categories.length > 0) {
					parts.push(`   Categories: ${t.categories.join(", ")}`);
				}
				return parts.join("\n");
			})
			.join("\n\n");
	}

	formatHistoryForPrompt() {
		if (this.taskHistory.length === 0) return "No task history available yet.";

		// Send last 30 snapshots for better pattern detection
		const recent = this.taskHistory.slice(-30);
		return recent
			.map((snap) => {
				const taskTitles = snap.tasks.map((t) => `  - ${t.title} (${t.status})`).join("\n");
				return `[${snap.dayOfWeek || ""} ${snap.timestamp}]\n${taskTitles}`;
			})
			.join("\n\n");
	}

	formatCompletionsForPrompt() {
		if (this.completions.length === 0) return "No completion history yet.";

		// Group completions by day of week for pattern detection
		const byDay = {};
		for (const c of this.completions) {
			const day = c.dayOfWeek || "Unknown";
			if (!byDay[day]) byDay[day] = [];
			byDay[day].push(c);
		}

		const lines = [];
		for (const [day, comps] of Object.entries(byDay)) {
			const tasks = comps.map((c) => `    ${c.title} (${c.hour}:00, ${c.importance})`).join("\n");
			lines.push(`  ${day} (${comps.length} completions):\n${tasks}`);
		}
		return lines.join("\n");
	}

	formatPatternsForPrompt() {
		if (this.learnedPatterns.length === 0) return "None identified yet.";
		return this.learnedPatterns.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
	}

	buildPrompt(tasks, currentTime) {
		const taskList = this.formatTasksForPrompt(tasks);
		const history = this.formatHistoryForPrompt();
		const completions = this.formatCompletionsForPrompt();
		const knownPatterns = this.formatPatternsForPrompt();
		const dayOfWeek = new Date(currentTime).toLocaleDateString("en-US", { weekday: "long" });
		const timeStr = new Date(currentTime).toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit"
		});

		return `You are a smart productivity assistant displayed on a magic mirror. Analyze the user's Microsoft To Do tasks and provide actionable insights.

Current day: ${dayOfWeek}
Current time: ${timeStr}
Current date: ${new Date(currentTime).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

== CURRENT TASKS ==
${taskList}

== TASK COMPLETION HISTORY (when tasks were finished, grouped by day) ==
${completions}

== RECENT TASK SNAPSHOTS (for trend detection) ==
${history}

== PREVIOUSLY IDENTIFIED PATTERNS (build on these, refine or remove if no longer accurate) ==
${knownPatterns}

Respond with ONLY valid JSON in this exact format:
{
  "priorityOrder": [
    { "title": "task title", "reason": "brief reason for this priority position" }
  ],
  "timeBlocks": [
    { "time": "9:00 AM", "task": "task title", "reason": "why this time works" }
  ],
  "insights": [
    "Brief actionable insight or tip (1-2 sentences max)"
  ],
  "patterns": [
    "Any recurring pattern detected - be specific about days, times, frequencies"
  ],
  "dailyReminder": "A brief motivational or practical reminder for the day"
}

Rules:
- priorityOrder: Rank the top 5 most important incomplete tasks
- timeBlocks: Suggest optimal times for up to 5 tasks based on the user's actual completion patterns
- insights: 2-4 actionable tips based on the task list and history
- patterns: 1-5 patterns. Include refined versions of previously identified patterns AND any new ones you detect. Be specific (e.g. "You complete most tasks between 9-11 AM on weekdays" not just "You're productive in the morning")
- dailyReminder: One concise, practical reminder
- Keep ALL text concise - this displays on a mirror with limited space
- Focus on what's actionable RIGHT NOW
- Use the completion history to personalize time suggestions to when this user actually gets things done`;
	}

	parseInsightsResponse(text) {
		let jsonStr = text.trim();
		const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const insights = JSON.parse(jsonStr);

		return {
			priorityOrder: insights.priorityOrder || [],
			timeBlocks: insights.timeBlocks || [],
			insights: insights.insights || [],
			patterns: insights.patterns || [],
			dailyReminder: insights.dailyReminder || ""
		};
	}

	// Subclasses must implement this
	async generateInsights(/* tasks, currentTime */) {
		throw new Error("generateInsights() must be implemented by subclass");
	}
}

module.exports = AIBase;
