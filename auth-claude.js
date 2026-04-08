#!/usr/bin/env node

/**
 * Claude.ai session setup for MMM-ClaudeTaskMirror.
 *
 * Logs you in with your Claude.ai account so the module can
 * generate AI insights using your existing subscription.
 *
 * Usage:
 *   node auth-claude.js
 *
 * Then paste your sessionKey when prompted.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SESSION_PATH = path.join(__dirname, "claude-session.json");

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

function ask(question) {
	return new Promise((resolve) => rl.question(question, resolve));
}

async function verifySession(sessionKey) {
	const fetch = require("node-fetch");
	const response = await fetch("https://api.claude.ai/api/organizations", {
		headers: {
			"Cookie": `sessionKey=${sessionKey}`,
			"Content-Type": "application/json",
			"User-Agent": "MMM-ClaudeTaskMirror/1.0"
		}
	});

	if (!response.ok) {
		return { valid: false, error: `HTTP ${response.status}` };
	}

	const orgs = await response.json();
	if (!orgs || orgs.length === 0) {
		return { valid: false, error: "No organizations found" };
	}

	return { valid: true, orgId: orgs[0].uuid, orgName: orgs[0].name || "Personal" };
}

async function main() {
	console.log("\n=== MMM-ClaudeTaskMirror - Claude.ai Login ===\n");
	console.log("This connects your Claude.ai account to your magic mirror.");
	console.log("You need your session key from the Claude.ai website.\n");
	console.log("How to get it:");
	console.log("  1. Go to https://claude.ai and log in");
	console.log("  2. Open browser DevTools (F12 or Cmd+Option+I)");
	console.log("  3. Go to Application tab → Cookies → https://claude.ai");
	console.log("  4. Find the 'sessionKey' cookie and copy its value\n");

	const sessionKey = (await ask("Paste your sessionKey here: ")).trim();

	if (!sessionKey) {
		console.error("\nNo session key provided. Exiting.");
		rl.close();
		process.exit(1);
	}

	console.log("\nVerifying session...");

	try {
		const result = await verifySession(sessionKey);

		if (!result.valid) {
			console.error(`\nSession invalid: ${result.error}`);
			console.error("Make sure you copied the full sessionKey value.");
			rl.close();
			process.exit(1);
		}

		const session = {
			sessionKey: sessionKey,
			orgId: result.orgId
		};

		fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));

		console.log(`\nSuccess! Logged in to org: ${result.orgName}`);
		console.log(`Session saved to ${SESSION_PATH}`);
		console.log("\nYour mirror is ready to use Claude AI insights.\n");
	} catch (error) {
		console.error(`\nError verifying session: ${error.message}`);
		console.error("Check your internet connection and try again.");
		rl.close();
		process.exit(1);
	}

	rl.close();
}

main();
