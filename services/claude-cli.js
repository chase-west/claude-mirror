const { spawn } = require("child_process");
const AIBase = require("./ai-base");

class ClaudeCLIService extends AIBase {
	constructor(config) {
		super();
		this.cliPath = config.cliPath || "claude";
		this.model = config.model || "claude-sonnet-4-20250514";
		this.timeoutMs = config.timeoutMs || 60000;
		// Allow injecting a custom spawn for testing
		this._spawn = config.spawn || spawn;
	}

	async generateInsights(tasks, currentTime) {
		currentTime = currentTime || Date.now();
		const prompt = this.buildPrompt(tasks, currentTime);
		const response = await this.runClaude(prompt);
		return this.parseInsightsResponse(response);
	}

	runClaude(prompt) {
		return new Promise((resolve, reject) => {
			const args = [
				"-p", prompt,
				"--output-format", "stream-json",
				"--max-turns", "1"
			];

			if (this.model) {
				args.push("--model", this.model);
			}

			const proc = this._spawn(this.cliPath, args, {
				stdio: ["pipe", "pipe", "pipe"],
				timeout: this.timeoutMs
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(
						`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`
					));
					return;
				}

				const text = this.parseStreamJson(stdout);
				if (!text) {
					reject(new Error("Claude CLI returned no text content."));
					return;
				}
				resolve(text);
			});

			proc.on("error", (err) => {
				if (err.code === "ENOENT") {
					reject(new Error(
						"Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
					));
				} else {
					reject(new Error(`Claude CLI error: ${err.message}`));
				}
			});
		});
	}

	parseStreamJson(output) {
		let result = "";
		const lines = output.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				// Assistant message with content blocks
				if (obj.type === "assistant" && obj.message && obj.message.content) {
					for (const block of obj.message.content) {
						if (block.type === "text") {
							result += block.text;
						}
					}
				}
				// Result message may also contain text
				if (obj.type === "result" && obj.result) {
					result += obj.result;
				}
			} catch {
				// skip non-JSON lines
			}
		}
		return result;
	}
}

module.exports = ClaudeCLIService;
