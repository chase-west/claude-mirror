const fetch = require("node-fetch");
const AIBase = require("./ai-base");

class OllamaAIService extends AIBase {
	constructor(config) {
		super();
		this.baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
		this.model = config.model || "llama3.2";
		this.fetch = config.fetch || fetch;
	}

	async generateInsights(tasks, currentTime) {
		currentTime = currentTime || Date.now();
		const prompt = this.buildPrompt(tasks, currentTime);

		const response = await this.fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				format: "json"
			})
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Ollama error (${response.status}): ${error}`);
		}

		const data = await response.json();
		return this.parseInsightsResponse(data.message.content);
	}

	async checkConnection() {
		try {
			const response = await this.fetch(`${this.baseUrl}/api/tags`, {
				method: "GET"
			});
			if (!response.ok) return { connected: false, models: [] };
			const data = await response.json();
			const models = (data.models || []).map((m) => m.name);
			return { connected: true, models };
		} catch {
			return { connected: false, models: [] };
		}
	}
}

module.exports = OllamaAIService;
