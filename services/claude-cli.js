const { spawn } = require("child_process");
const AIBase = require("./ai-base");

class ClaudeCLIService extends AIBase {
	constructor(config) {
		super();
		this.cliPath = config.cliPath || "claude";
		this.model = config.model || "claude-sonnet-4-20250514";
		this.timeoutMs = config.timeoutMs || 120000;
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
				"--output-format", "json",
				"--max-turns", "1"
			];

			if (this.model) {
				args.push("--model", this.model);
			}

			const proc = this._spawn(this.cliPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
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
					const errorDetail = stderr || stdout || "(no output)";
					reject(new Error(
						`Claude CLI exited with code ${code}: ${errorDetail.slice(0, 500)}`
					));
					return;
				}

				const text = this.parseJsonOutput(stdout);
				if (!text) {
					reject(new Error(`Claude CLI returned no text. stdout: ${stdout.slice(0, 300)}`));
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

	parseJsonOutput(output) {
		// --output-format json returns a single JSON object with a "result" field
		// Try parsing as JSON first
		try {
			const data = JSON.parse(output.trim());
			// Handle {result: "text"} format
			if (data.result) return data.result;
			// Handle {content: [{type: "text", text: "..."}]} format
			if (data.content) {
				return data.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("");
			}
			// Handle direct text response
			if (typeof data === "string") return data;
		} catch {
			// Not JSON - might be plain text output
		}

		// Fallback: try stream-json (newline-delimited JSON)
		let result = "";
		for (const line of output.split("\n")) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj.type === "assistant" && obj.message && obj.message.content) {
					for (const block of obj.message.content) {
						if (block.type === "text") result += block.text;
					}
				}
				if (obj.type === "result" && obj.result) result += obj.result;
			} catch {
				// skip
			}
		}
		if (result) return result;

		// Last resort: return raw output if it looks like it has content
		const trimmed = output.trim();
		if (trimmed && trimmed.length > 10) return trimmed;

		return "";
	}
}

module.exports = ClaudeCLIService;
