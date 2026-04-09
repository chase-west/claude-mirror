#!/usr/bin/env node

/**
 * Microsoft To Do authentication using Device Code Flow.
 * No Azure portal, no app registration, no client secret needed.
 *
 * Just run:
 *   npm run auth:microsoft
 *
 * Then open the URL on your phone, enter the code, sign in. Done.
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// Microsoft Graph Command Line Tools - Microsoft's own public client ID
// used by their Graph PowerShell SDK. No Azure app registration needed.
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || DEFAULT_CLIENT_ID;
const TOKENS_PATH = path.join(__dirname, "tokens.json");
const SCOPES = "Tasks.ReadWrite offline_access";

// Use /common so it works with both personal and work accounts
const DEVICE_CODE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestDeviceCode() {
	const response = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: SCOPES
		}).toString()
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Device code request failed: ${err}`);
	}

	return response.json();
}

async function pollForToken(deviceCode, interval, expiresIn) {
	const deadline = Date.now() + (expiresIn * 1000);

	while (Date.now() < deadline) {
		await sleep(interval * 1000);

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code"
			}).toString()
		});

		const data = await response.json();

		if (data.error === "authorization_pending") {
			// User hasn't signed in yet, keep polling
			continue;
		}

		if (data.error === "slow_down") {
			interval += 5;
			continue;
		}

		if (data.error) {
			throw new Error(`Auth failed: ${data.error_description || data.error}`);
		}

		// Success
		return data;
	}

	throw new Error("Authentication timed out. Run the command again.");
}

async function main() {
	console.log("\n=== MMM-ClaudeTaskMirror - Microsoft To Do Login ===\n");

	try {
		const codeResponse = await requestDeviceCode();

		console.log("To sign in, open this URL on your phone or computer:\n");
		console.log(`  ${codeResponse.verification_uri}\n`);
		console.log(`Enter this code: ${codeResponse.user_code}\n`);
		console.log("Waiting for you to sign in...\n");

		const tokenData = await pollForToken(
			codeResponse.device_code,
			codeResponse.interval || 5,
			codeResponse.expires_in || 900
		);

		const tokens = {
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token,
			expires_at: Date.now() + (tokenData.expires_in * 1000)
		};

		fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));

		// Save client ID alongside tokens so node_helper can use it
		const tokensWithClient = {
			...tokens,
			client_id: CLIENT_ID
		};
		fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokensWithClient, null, 2));

		console.log("Success! Tokens saved.");
		console.log("\nYour mirror can now access your Microsoft To Do tasks.");
		console.log("No config changes needed - just start MagicMirror.\n");
	} catch (error) {
		console.error(`\nError: ${error.message}\n`);
		process.exit(1);
	}
}

main();
