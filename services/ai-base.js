const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "..", "data", "task-history.json");
const MAX_HISTORY_ENTRIES = 500;

class AIBase {
	constructor() {
		this.taskHistory = [];
	}

	loadHistory() {
		try {
			const data = fs.readFileSync(HISTORY_FILE, "utf8");
			this.taskHistory = JSON.parse(data);
		} catch {
			this.taskHistory = [];
		}
	}

	saveHistory() {
		const dir = path.dirname(HISTORY_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		if (this.taskHistory.length > MAX_HISTORY_ENTRIES) {
			this.taskHistory = this.taskHistory.slice(-MAX_HISTORY_ENTRIES);
		}
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.taskHistory, null, 2));
	}

	recordTaskSnapshot(tasks) {
		const snapshot = {
			timestamp: new Date().toISOString(),
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

		const recent = this.taskHistory.slice(-7);
		return recent
			.map((snap) => {
				const taskTitles = snap.tasks.map((t) => `  - ${t.title} (${t.status})`).join("\n");
				return `[${snap.timestamp}]\n${taskTitles}`;
			})
			.join("\n\n");
	}

	buildPrompt(tasks, currentTime) {
		const taskList = this.formatTasksForPrompt(tasks);
		const history = this.formatHistoryForPrompt();
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

== RECENT TASK HISTORY (for pattern detection) ==
${history}

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
    "Any recurring pattern detected from history (1 sentence)"
  ],
  "dailyReminder": "A brief motivational or practical reminder for the day"
}

Rules:
- priorityOrder: Rank the top 5 most important incomplete tasks
- timeBlocks: Suggest optimal times for up to 5 tasks based on typical productivity patterns
- insights: 2-4 actionable tips based on the task list
- patterns: 0-3 patterns detected (empty array if no history yet)
- dailyReminder: One concise, practical reminder
- Keep ALL text concise - this displays on a mirror with limited space
- Focus on what's actionable RIGHT NOW`;
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
