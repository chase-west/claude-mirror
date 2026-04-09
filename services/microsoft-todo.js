const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

class MicrosoftTodoService {
	constructor(config) {
		this.clientId = config.clientId || DEFAULT_CLIENT_ID;
		this.clientSecret = config.clientSecret || "";
		this.tokensPath = config.tokensPath || path.join(__dirname, "..", "tokens.json");
		this.tokens = null;
		this.fetch = config.fetch || fetch;
	}

	async loadTokens() {
		try {
			const data = JSON.parse(fs.readFileSync(this.tokensPath, "utf8"));
			// Use client_id from tokens file if not set in config
			if (data.client_id && this.clientId === DEFAULT_CLIENT_ID) {
				this.clientId = data.client_id;
			}
			this.tokens = data;
			return true;
		} catch {
			return false;
		}
	}

	saveTokens() {
		const dir = path.dirname(this.tokensPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.tokensPath, JSON.stringify(this.tokens, null, 2));
	}

	async refreshAccessToken() {
		if (!this.tokens || !this.tokens.refresh_token) {
			throw new Error("No refresh token available. Run 'npm run auth:microsoft' to authenticate.");
		}

		const params = new URLSearchParams({
			client_id: this.clientId,
			refresh_token: this.tokens.refresh_token,
			grant_type: "refresh_token",
			scope: "Tasks.ReadWrite offline_access"
		});

		// Only include client_secret if provided (not needed for public/device code apps)
		if (this.clientSecret) {
			params.set("client_secret", this.clientSecret);
		}

		const response = await this.fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString()
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Token refresh failed (${response.status}): ${error}`);
		}

		const data = await response.json();
		this.tokens = {
			access_token: data.access_token,
			refresh_token: data.refresh_token || this.tokens.refresh_token,
			expires_at: Date.now() + (data.expires_in * 1000)
		};
		this.saveTokens();
		return this.tokens.access_token;
	}

	async getAccessToken() {
		if (!this.tokens) {
			const loaded = await this.loadTokens();
			if (!loaded) {
				throw new Error("No tokens found. Run 'npm run auth:microsoft' to authenticate.");
			}
		}

		if (this.tokens.expires_at && Date.now() >= this.tokens.expires_at - 60000) {
			return this.refreshAccessToken();
		}

		return this.tokens.access_token;
	}

	async graphRequest(endpoint) {
		const token = await this.getAccessToken();
		const response = await this.fetch(`${GRAPH_BASE}${endpoint}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json"
			}
		});

		if (response.status === 401) {
			const newToken = await this.refreshAccessToken();
			const retryResponse = await this.fetch(`${GRAPH_BASE}${endpoint}`, {
				headers: {
					Authorization: `Bearer ${newToken}`,
					"Content-Type": "application/json"
				}
			});
			if (!retryResponse.ok) {
				throw new Error(`Graph API error (${retryResponse.status}): ${await retryResponse.text()}`);
			}
			return retryResponse.json();
		}

		if (!response.ok) {
			throw new Error(`Graph API error (${response.status}): ${await response.text()}`);
		}

		return response.json();
	}

	async fetchTaskLists() {
		const data = await this.graphRequest("/me/todo/lists");
		return data.value || [];
	}

	async fetchTasks(listId) {
		const data = await this.graphRequest(
			`/me/todo/lists/${listId}/tasks?$top=100&$orderby=importance desc,createdDateTime desc`
		);
		return data.value || [];
	}

	async getAllTasks(filterListName) {
		const lists = await this.fetchTaskLists();
		const allTasks = [];

		for (const list of lists) {
			if (filterListName && list.displayName !== filterListName) {
				continue;
			}

			const tasks = await this.fetchTasks(list.id);
			for (const task of tasks) {
				allTasks.push({
					id: task.id,
					title: task.title,
					body: task.body ? task.body.content : "",
					status: task.status,
					importance: task.importance,
					isReminderOn: task.isReminderOn,
					reminderDateTime: task.reminderDateTime
						? task.reminderDateTime.dateTime
						: null,
					dueDateTime: task.dueDateTime
						? task.dueDateTime.dateTime
						: null,
					completedDateTime: task.completedDateTime
						? task.completedDateTime.dateTime
						: null,
					createdDateTime: task.createdDateTime,
					lastModifiedDateTime: task.lastModifiedDateTime,
					listName: list.displayName,
					categories: task.categories || []
				});
			}
		}

		return allTasks;
	}

	isAuthenticated() {
		return this.tokens !== null && this.tokens.access_token !== undefined;
	}
}

module.exports = MicrosoftTodoService;
