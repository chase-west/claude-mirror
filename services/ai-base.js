const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "task-history.json");
const THOUGHTS_FILE = path.join(DATA_DIR, "thoughts.json");
const MAX_SNAPSHOTS = 500;
const MAX_COMPLETIONS = 200;
const MAX_PATTERNS = 50;
const MAX_THOUGHTS = 200;

class AIBase {
	constructor() {
		this.taskHistory = [];
		this.completions = [];
		this.learnedPatterns = [];
		this.thoughts = [];
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
		this.loadThoughts();
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

	// --- Thoughts Persistence ---

	loadThoughts() {
		try {
			const data = JSON.parse(fs.readFileSync(THOUGHTS_FILE, "utf8"));
			this.thoughts = data.thoughts || [];
		} catch {
			this.thoughts = [];
		}
	}

	saveThoughts() {
		if (!fs.existsSync(DATA_DIR)) {
			fs.mkdirSync(DATA_DIR, { recursive: true });
		}
		if (this.thoughts.length > MAX_THOUGHTS) {
			this.thoughts = this.thoughts.slice(-MAX_THOUGHTS);
		}
		fs.writeFileSync(THOUGHTS_FILE, JSON.stringify({
			thoughts: this.thoughts
		}, null, 2));
	}

	addThought(text) {
		const thought = {
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			text: text.trim(),
			timestamp: new Date().toISOString(),
			dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long" })
		};
		this.thoughts.push(thought);
		this.saveThoughts();
		return thought;
	}

	getRecentThoughts(count = 20) {
		return this.thoughts.slice(-count);
	}

	deleteThought(id) {
		this.thoughts = this.thoughts.filter((t) => t.id !== id);
		this.saveThoughts();
	}

	formatThoughtsForPrompt() {
		if (this.thoughts.length === 0) return "No thoughts recorded yet.";

		const recent = this.thoughts.slice(-30);
		return recent
			.map((t) => {
				const date = new Date(t.timestamp);
				const relative = this._relativeTime(date);
				return `  - "${t.text}" (${relative})`;
			})
			.join("\n");
	}

	_relativeTime(date) {
		const now = new Date();
		const diffMs = now - date;
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays === 1) return "yesterday";
		if (diffDays < 7) return `${diffDays} days ago`;
		return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
		const thoughtsList = this.formatThoughtsForPrompt();
		const dayOfWeek = new Date(currentTime).toLocaleDateString("en-US", { weekday: "long" });
		const timeStr = new Date(currentTime).toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit"
		});

		return `You are a personal life assistant displayed on a smart mirror. Your job: prioritize the user's tasks, schedule them into their day, suggest new tasks based on their thoughts and context, and give a short actionable recommendation for each.

Current day: ${dayOfWeek}
Current time: ${timeStr}
Current date: ${new Date(currentTime).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

== TASKS ==
${taskList}

== USER'S THOUGHTS & NOTES ==
These are things the user has typed in - ideas, reminders, things on their mind. Use these to understand their life context and suggest tasks they might need to do.
${thoughtsList}

== COMPLETION HISTORY (when this user actually finishes things) ==
${completions}

== KNOWN PATTERNS ==
${knownPatterns}

Respond with ONLY valid JSON:
{
  "priorityOrder": [
    { "title": "exact task title", "reason": "short rec - what to do, how to approach it, or context" }
  ],
  "timeBlocks": [
    { "time": "9:00 AM", "task": "exact task title", "reason": "why this slot" }
  ],
  "suggestedTasks": [
    { "title": "suggested task name", "reason": "why - based on what thought or context", "source": "thought or pattern that triggered this" }
  ],
  "patterns": [
    "behavioral pattern for internal tracking"
  ],
  "insights": [],
  "dailyReminder": ""
}

Rules:
- priorityOrder: Top 5 tasks ranked by urgency. "reason" = a brief practical recommendation for that specific task (e.g. "start with the outline first" or "due in 2 days - block 2 hours")
- timeBlocks: Schedule up to 5 tasks into specific times today based on when this user actually gets things done (use completion history). Be realistic.
- suggestedTasks: 1-5 tasks the user might need to do based on their thoughts, notes, and patterns. These are NOT existing tasks - they are NEW suggestions. Think about what logically follows from their thoughts (e.g. if they wrote "need to study for calc exam" suggest "Make calc study guide" or "Review chapters 5-7"). Be specific and actionable.
- patterns: 1-3 for internal tracking only (not displayed). Refine previous patterns or add new ones.
- insights: leave empty (not used)
- dailyReminder: One short practical reminder about the most urgent/important thing (e.g. "speech due in 2 days" or "3 overdue tasks"). No motivational fluff - just facts.
- Use EXACT task titles from the task list for priorityOrder and timeBlocks
- Keep reasons under 10 words - this is a mirror, space is tight`;
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
			suggestedTasks: insights.suggestedTasks || [],
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
