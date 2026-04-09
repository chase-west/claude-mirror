#!/usr/bin/env node

/**
 * Microsoft To Do authentication using Device Code Flow.
 * No redirect URI, no client secret, no local server needed.
 *
 * Setup (one time):
 *   1. Go to https://portal.azure.com → App registrations → New registration
 *   2. Name it whatever, select "Personal Microsoft accounts only"
 *   3. Leave Redirect URI blank, click Register
 *   4. Go to Authentication → Advanced → "Allow public client flows" → Yes → Save
 *   5. Copy the Application (client) ID
 *   6. Run: MICROSOFT_CLIENT_ID=your-id npm run auth:microsoft
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const TOKENS_PATH = path.join(__dirname, "tokens.json");
const SCOPES = "Tasks.ReadWrite offline_access";

// Use /consumers for personal Microsoft accounts
const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

if (!CLIENT_ID) {
	console.error("\nError: Set MICROSOFT_CLIENT_ID environment variable.\n");
	console.error("Usage:");
	console.error("  MICROSOFT_CLIENT_ID=your-app-id npm run auth:microsoft\n");
	console.error("Don't have a client ID yet? Quick setup:");
	console.error("  1. Go to https://portal.azure.com → App registrations → New registration");
	console.error("  2. Name: 'MagicMirror', Account type: 'Personal Microsoft accounts only'");
	console.error("  3. Leave Redirect URI blank → Register");
	console.error("  4. Authentication → Advanced → Allow public client flows → Yes → Save");
	console.error("  5. Copy the Application (client) ID from the Overview page\n");
	process.exit(1);
}

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

		console.log("Success! Tokens saved.");
		console.log(`\nAdd this to your MagicMirror config.js:\n`);
		console.log(`  microsoftClientId: "${CLIENT_ID}"\n`);
		console.log("Your mirror can now access your Microsoft To Do tasks.\n");
	} catch (error) {
		console.error(`\nError: ${error.message}\n`);
		process.exit(1);
	}
}

main();
