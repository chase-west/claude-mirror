const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const AIBase = require("./ai-base");

const DEFAULT_BASE_URL = "https://api.claude.ai";
const SESSION_FILE = path.join(__dirname, "..", "claude-session.json");

class ClaudeWebService extends AIBase {
	constructor(config) {
		super();
		this.sessionKey = config.sessionKey || "";
		this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.model = config.model || "claude-sonnet-4-20250514";
		this.orgId = config.orgId || null;
		this.fetch = config.fetch || fetch;
		this.sessionPath = config.sessionPath || SESSION_FILE;
	}

	async loadSession() {
		if (this.sessionKey) return true;
		try {
			const data = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
			this.sessionKey = data.sessionKey;
			this.orgId = data.orgId || null;
			return !!this.sessionKey;
		} catch {
			return false;
		}
	}

	saveSession() {
		const dir = path.dirname(this.sessionPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.sessionPath, JSON.stringify({
			sessionKey: this.sessionKey,
			orgId: this.orgId
		}, null, 2));
	}

	getHeaders() {
		return {
			"Cookie": `sessionKey=${this.sessionKey}`,
			"Content-Type": "application/json",
			"User-Agent": "MMM-ClaudeTaskMirror/1.0"
		};
	}

	async fetchOrgId() {
		const response = await this.fetch(`${this.baseUrl}/api/organizations`, {
			headers: this.getHeaders()
		});
		if (!response.ok) {
			const status = response.status;
			if (status === 401 || status === 403) {
				throw new Error("Session expired. Run 'npm run auth:claude' to re-authenticate.");
			}
			throw new Error(`Failed to fetch organizations (${status}).`);
		}
		const orgs = await response.json();
		if (!orgs || orgs.length === 0) {
			throw new Error("No organizations found for this account.");
		}
		this.orgId = orgs[0].uuid;
		this.saveSession();
		return this.orgId;
	}

	async ensureOrgId() {
		if (!this.orgId) {
			await this.fetchOrgId();
		}
		return this.orgId;
	}

	async createConversation() {
		const orgId = await this.ensureOrgId();
		const response = await this.fetch(
			`${this.baseUrl}/api/organizations/${orgId}/chat_conversations`,
			{
				method: "POST",
				headers: this.getHeaders(),
				body: JSON.stringify({ name: "", model: this.model })
			}
		);
		if (!response.ok) {
			const err = await response.text();
			throw new Error(`Failed to create conversation (${response.status}): ${err}`);
		}
		const data = await response.json();
		return data.uuid;
	}

	async sendMessage(conversationId, message) {
		const orgId = await this.ensureOrgId();
		const response = await this.fetch(
			`${this.baseUrl}/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
			{
				method: "POST",
				headers: {
					...this.getHeaders(),
					"Accept": "text/event-stream"
				},
				body: JSON.stringify({
					prompt: message,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					model: this.model
				})
			}
		);
		if (!response.ok) {
			const err = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new Error("Session expired. Run 'npm run auth:claude' to re-authenticate.");
			}
			throw new Error(`Claude web error (${response.status}): ${err}`);
		}

		const text = await response.text();
		return this.parseSSE(text);
	}

	parseSSE(raw) {
		let result = "";
		const lines = raw.split("\n");
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const jsonStr = line.slice(6).trim();
			if (!jsonStr || jsonStr === "[DONE]") continue;
			try {
				const data = JSON.parse(jsonStr);
				if (data.completion) {
					result += data.completion;
				} else if (data.delta && data.delta.text) {
					result += data.delta.text;
				} else if (data.type === "content_block_delta" && data.delta) {
					result += data.delta.text || "";
				}
			} catch {
				// skip non-JSON data lines
			}
		}
		return result;
	}

	async deleteConversation(conversationId) {
		try {
			const orgId = await this.ensureOrgId();
			await this.fetch(
				`${this.baseUrl}/api/organizations/${orgId}/chat_conversations/${conversationId}`,
				{ method: "DELETE", headers: this.getHeaders() }
			);
		} catch {
			// best-effort cleanup
		}
	}

	async generateInsights(tasks, currentTime) {
		currentTime = currentTime || Date.now();

		if (!this.sessionKey) {
			const loaded = await this.loadSession();
			if (!loaded) {
				throw new Error("No Claude session found. Run 'npm run auth:claude' to log in.");
			}
		}

		const prompt = this.buildPrompt(tasks, currentTime);
		const convId = await this.createConversation();
		try {
			const response = await this.sendMessage(convId, prompt);
			return this.parseInsightsResponse(response);
		} finally {
			await this.deleteConversation(convId);
		}
	}
}

module.exports = ClaudeWebService;
