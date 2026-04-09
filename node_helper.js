const NodeHelper = require("node_helper");
const MicrosoftTodoService = require("./services/microsoft-todo");
const ClaudeCLIService = require("./services/claude-cli");
const ClaudeWebService = require("./services/claude-web");
const ClaudeAIService = require("./services/claude-ai");
const OllamaAIService = require("./services/ollama-ai");
const path = require("path");
const http = require("http");
const url = require("url");

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
		this.thoughtsApiServer = null;
		console.log("[MMM-ClaudeTaskMirror] Node helper started.");
	},

	stop: function () {
		if (this.taskTimer) clearInterval(this.taskTimer);
		if (this.insightTimer) clearInterval(this.insightTimer);
		if (this.thoughtsApiServer) this.thoughtsApiServer.close();
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
			case "ADD_THOUGHT":
				this.addThought(payload);
				break;
			case "DELETE_THOUGHT":
				this.deleteThought(payload);
				break;
			case "FETCH_THOUGHTS":
				this.fetchThoughts();
				break;
		}
	},

	createAIService: function (config) {
		const provider = config.aiProvider || "claude-cli";

		switch (provider) {
			case "claude-cli":
				return new ClaudeCLIService({
					cliPath: config.claudeCliPath || "claude",
					model: config.claudeModel || "claude-sonnet-4-20250514",
					timeoutMs: config.claudeTimeoutMs || 60000
				});

			case "claude-web":
				return new ClaudeWebService({
					model: config.claudeWebModel || "claude-sonnet-4-20250514",
					sessionPath: config.claudeSessionPath || path.join(__dirname, "claude-session.json")
				});

			case "claude-api":
				if (!config.anthropicApiKey) return null;
				return new ClaudeAIService({
					apiKey: config.anthropicApiKey,
					model: config.claudeApiModel || "claude-haiku-4-5-20251001",
					maxTokens: config.claudeMaxTokens || 1024
				});

			case "ollama":
				return new OllamaAIService({
					baseUrl: config.ollamaUrl || "http://localhost:11434",
					model: config.ollamaModel || "llama3.2"
				});

			default:
				console.error(`[MMM-ClaudeTaskMirror] Unknown AI provider: ${provider}`);
				return null;
		}
	},

	initModule: function (config) {
		if (this.started) return;
		this.started = true;
		this.config = config;

		// Initialize Microsoft To Do service
		this.todoService = new MicrosoftTodoService({
			clientId: config.microsoftClientId,
			clientSecret: config.microsoftClientSecret || "",
			tokensPath: config.microsoftTokensPath || path.join(__dirname, "tokens.json")
		});

		// Initialize AI service based on provider
		this.aiService = this.createAIService(config);
		if (this.aiService) {
			this.aiService.loadHistory();
			console.log(`[MMM-ClaudeTaskMirror] AI provider: ${config.aiProvider || "claude-web"}`);
		}

		// Start the thoughts HTTP API for phone input
		this.startThoughtsApi();

		// Send initial thoughts to frontend
		this.fetchThoughts();

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

	addThought: function (payload) {
		if (!this.aiService) return;
		const text = typeof payload === "string" ? payload : payload.text;
		if (!text || !text.trim()) return;

		const thought = this.aiService.addThought(text);
		this.sendSocketNotification("THOUGHTS_UPDATED", {
			thoughts: this.aiService.getRecentThoughts(),
			newThought: thought,
			timestamp: Date.now()
		});

		// Re-generate insights with the new thought context
		if (this.tasks.length > 0) {
			this.fetchInsights();
		}

		console.log(`[MMM-ClaudeTaskMirror] Thought added: "${text.substring(0, 50)}..."`);
	},

	deleteThought: function (payload) {
		if (!this.aiService) return;
		const id = typeof payload === "string" ? payload : payload.id;
		this.aiService.deleteThought(id);
		this.sendSocketNotification("THOUGHTS_UPDATED", {
			thoughts: this.aiService.getRecentThoughts(),
			timestamp: Date.now()
		});
	},

	fetchThoughts: function () {
		if (!this.aiService) return;
		this.sendSocketNotification("THOUGHTS_UPDATED", {
			thoughts: this.aiService.getRecentThoughts(),
			timestamp: Date.now()
		});
	},

	startThoughtsApi: function () {
		const port = this.config.thoughtsApiPort || 8189;
		const self = this;

		this.thoughtsApiServer = http.createServer((req, res) => {
			// CORS headers so phone browser can hit this
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(200);
				res.end();
				return;
			}

			const parsed = url.parse(req.url, true);

			// POST /thoughts - add a new thought
			if (parsed.pathname === "/thoughts" && req.method === "POST") {
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						if (!data.text || !data.text.trim()) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "text is required" }));
							return;
						}
						self.addThought(data.text);
						res.writeHead(201, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, message: "Thought added" }));
					} catch (e) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Invalid JSON" }));
					}
				});
				return;
			}

			// GET /thoughts - list recent thoughts
			if (parsed.pathname === "/thoughts" && req.method === "GET") {
				const thoughts = self.aiService ? self.aiService.getRecentThoughts() : [];
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ thoughts }));
				return;
			}

			// DELETE /thoughts/:id - delete a thought
			const deleteMatch = parsed.pathname.match(/^\/thoughts\/(.+)$/);
			if (deleteMatch && req.method === "DELETE") {
				self.deleteThought(deleteMatch[1]);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, message: "Thought deleted" }));
				return;
			}

			// GET / - simple mobile-friendly input page
			if (parsed.pathname === "/" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(self.getThoughtInputPage());
				return;
			}

			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
		});

		this.thoughtsApiServer.listen(port, () => {
			console.log(`[MMM-ClaudeTaskMirror] Thoughts API running on port ${port} - open http://<mirror-ip>:${port} on your phone`);
		});
	},

	getThoughtInputPage: function () {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Mirror Thoughts</title>
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: #0a0a0f;
		color: #e0e0e0;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.header {
		padding: 20px 16px 12px;
		border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	.header h1 {
		font-size: 18px;
		font-weight: 600;
		color: #fff;
	}
	.header p {
		font-size: 12px;
		color: rgba(255,255,255,0.4);
		margin-top: 4px;
	}
	.input-area {
		padding: 16px;
		border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	textarea {
		width: 100%;
		min-height: 100px;
		padding: 12px;
		background: rgba(255,255,255,0.05);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 10px;
		color: #fff;
		font-size: 16px;
		font-family: inherit;
		resize: vertical;
		outline: none;
	}
	textarea:focus {
		border-color: rgba(100,180,255,0.4);
	}
	textarea::placeholder { color: rgba(255,255,255,0.25); }
	.btn {
		width: 100%;
		margin-top: 10px;
		padding: 14px;
		background: rgba(100,180,255,0.2);
		border: 1px solid rgba(100,180,255,0.3);
		border-radius: 10px;
		color: #74c0fc;
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}
	.btn:active { background: rgba(100,180,255,0.3); }
	.btn:disabled { opacity: 0.4; }
	.status {
		text-align: center;
		font-size: 13px;
		color: rgba(100,220,120,0.7);
		padding: 8px;
		min-height: 30px;
	}
	.thoughts-list {
		flex: 1;
		padding: 0 16px 16px;
		overflow-y: auto;
	}
	.thoughts-list h2 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 1px;
		color: rgba(255,255,255,0.3);
		margin-bottom: 8px;
	}
	.thought-item {
		padding: 10px 12px;
		background: rgba(255,255,255,0.03);
		border-radius: 8px;
		margin-bottom: 6px;
		position: relative;
	}
	.thought-text {
		font-size: 14px;
		line-height: 1.4;
		color: rgba(255,255,255,0.8);
	}
	.thought-time {
		font-size: 11px;
		color: rgba(255,255,255,0.25);
		margin-top: 4px;
	}
	.thought-delete {
		position: absolute;
		top: 8px;
		right: 8px;
		background: none;
		border: none;
		color: rgba(255,100,100,0.4);
		font-size: 14px;
		cursor: pointer;
		padding: 4px;
	}
</style>
</head>
<body>
<div class="header">
	<h1>What's on your mind?</h1>
	<p>Type anything - ideas, reminders, thoughts. Your mirror will keep it in context.</p>
</div>
<div class="input-area">
	<textarea id="thought" placeholder="e.g. need to study for calc exam next week, should probably start reviewing chapter 5..."></textarea>
	<button class="btn" id="submit" onclick="submitThought()">Send to Mirror</button>
	<div class="status" id="status"></div>
</div>
<div class="thoughts-list">
	<h2>Recent Thoughts</h2>
	<div id="thoughts"></div>
</div>
<script>
async function submitThought() {
	const ta = document.getElementById('thought');
	const btn = document.getElementById('submit');
	const status = document.getElementById('status');
	const text = ta.value.trim();
	if (!text) return;

	btn.disabled = true;
	try {
		const res = await fetch('/thoughts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
		});
		if (res.ok) {
			ta.value = '';
			status.textContent = 'Sent! Your mirror will update shortly.';
			setTimeout(() => { status.textContent = ''; }, 3000);
			loadThoughts();
		} else {
			status.textContent = 'Error sending thought.';
		}
	} catch (e) {
		status.textContent = 'Could not reach mirror.';
	}
	btn.disabled = false;
}

async function deleteThought(id) {
	await fetch('/thoughts/' + id, { method: 'DELETE' });
	loadThoughts();
}

async function loadThoughts() {
	try {
		const res = await fetch('/thoughts');
		const data = await res.json();
		const container = document.getElementById('thoughts');
		if (!data.thoughts || data.thoughts.length === 0) {
			container.innerHTML = '<div style="color:rgba(255,255,255,0.2);font-size:13px;">No thoughts yet.</div>';
			return;
		}
		container.innerHTML = data.thoughts.reverse().map(t => {
			const d = new Date(t.timestamp);
			const time = d.toLocaleString();
			return '<div class="thought-item">' +
				'<button class="thought-delete" onclick="deleteThought(\\'' + t.id + '\\')">&times;</button>' +
				'<div class="thought-text">' + escapeHtml(t.text) + '</div>' +
				'<div class="thought-time">' + time + '</div>' +
			'</div>';
		}).join('');
	} catch(e) {
		console.error(e);
	}
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

document.getElementById('thought').addEventListener('keydown', function(e) {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		submitThought();
	}
});

loadThoughts();
</script>
</body>
</html>`;
	},

	fetchInsights: async function () {
		if (!this.aiService) {
			this.sendSocketNotification("ERROR", {
				type: "AI_NOT_CONFIGURED",
				message: "No AI provider configured. Run 'npm run auth:claude' or set aiProvider in config."
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

			// Persist any new patterns Claude identified
			if (insights.patterns && insights.patterns.length > 0) {
				this.aiService.saveLearnedPatterns(insights.patterns);
			}

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
