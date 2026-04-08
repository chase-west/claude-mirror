#!/usr/bin/env node

/**
 * One-time OAuth setup for Microsoft To Do.
 *
 * Usage:
 *   1. Register an app at https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps
 *   2. Add redirect URI: http://localhost:8901/callback
 *   3. Under "API permissions", add Microsoft Graph → Tasks.ReadWrite + offline_access
 *   4. Under "Certificates & secrets", create a client secret
 *   5. Run: MICROSOFT_CLIENT_ID=xxx MICROSOFT_CLIENT_SECRET=yyy node auth-setup.js
 */

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:8901/callback";
const SCOPES = "Tasks.Read Tasks.ReadWrite offline_access";
const TOKENS_PATH = path.join(__dirname, "tokens.json");
const PORT = 8901;

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error("Error: Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET environment variables.");
	console.error("");
	console.error("Usage:");
	console.error("  MICROSOFT_CLIENT_ID=xxx MICROSOFT_CLIENT_SECRET=yyy node auth-setup.js");
	process.exit(1);
}

const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?`
	+ `client_id=${encodeURIComponent(CLIENT_ID)}`
	+ `&response_type=code`
	+ `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
	+ `&scope=${encodeURIComponent(SCOPES)}`
	+ `&response_mode=query`;

console.log("\n=== MMM-ClaudeTaskMirror OAuth Setup ===\n");
console.log("Open this URL in your browser to authorize:\n");
console.log(authUrl);
console.log("\nWaiting for callback on port", PORT, "...\n");

const server = http.createServer(async (req, res) => {
	const parsed = url.parse(req.url, true);

	if (parsed.pathname !== "/callback") {
		res.writeHead(404);
		res.end("Not found");
		return;
	}

	const code = parsed.query.code;
	if (!code) {
		res.writeHead(400);
		res.end("Error: No authorization code received. " + (parsed.query.error_description || ""));
		return;
	}

	try {
		// Exchange code for tokens
		const fetch = require("node-fetch");
		const tokenUrl = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code: code,
			redirect_uri: REDIRECT_URI,
			grant_type: "authorization_code",
			scope: SCOPES
		});

		const tokenResponse = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString()
		});

		if (!tokenResponse.ok) {
			const err = await tokenResponse.text();
			throw new Error(`Token exchange failed: ${err}`);
		}

		const data = await tokenResponse.json();

		const tokens = {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + (data.expires_in * 1000)
		};

		fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
		console.log("Tokens saved to", TOKENS_PATH);
		console.log("Setup complete! You can now use the module.\n");

		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`
			<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:#eee">
				<h1>Authorization Successful!</h1>
				<p>Tokens have been saved. You can close this window.</p>
				<p style="color:#69db7c">MMM-ClaudeTaskMirror is ready to go.</p>
			</body></html>
		`);

		setTimeout(() => {
			server.close();
			process.exit(0);
		}, 1000);
	} catch (error) {
		console.error("Error exchanging code for tokens:", error.message);
		res.writeHead(500);
		res.end("Error: " + error.message);
		server.close();
		process.exit(1);
	}
});

server.listen(PORT, () => {
	// Try to open browser automatically
	const { exec } = require("child_process");
	const openCmd = process.platform === "darwin" ? "open"
		: process.platform === "win32" ? "start"
			: "xdg-open";
	exec(`${openCmd} "${authUrl}"`, () => {
		// Silently ignore if browser can't be opened
	});
});
