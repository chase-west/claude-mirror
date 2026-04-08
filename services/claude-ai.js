const Anthropic = require("@anthropic-ai/sdk");
const AIBase = require("./ai-base");

class ClaudeAIService extends AIBase {
	constructor(config) {
		super();
		this.model = config.model || "claude-haiku-4-5-20251001";
		this.maxTokens = config.maxTokens || 1024;
		this.client = config.client || new Anthropic({ apiKey: config.apiKey });
	}

	async generateInsights(tasks, currentTime) {
		currentTime = currentTime || Date.now();
		const prompt = this.buildPrompt(tasks, currentTime);

		const response = await this.client.messages.create({
			model: this.model,
			max_tokens: this.maxTokens,
			messages: [{ role: "user", content: prompt }]
		});

		return this.parseInsightsResponse(response.content[0].text);
	}
}

module.exports = ClaudeAIService;
