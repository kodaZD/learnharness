import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { SEARCH_ENGINES } from "../src/core/search.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-search-gateway-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.SEARCH_API_BEARER_TOKEN = "gateway-fixture-token";
const { writeSettings } = await import("../src/store/settings.ts");
const { searchStatus, searchProvider } = await import("../src/server/search.ts");
const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = async () => { throw new Error("unexpected external request"); };
	writeSettings({ version: 1 });
});
after(() => {
	globalThis.fetch = realFetch;
	delete process.env.SEARCH_API_BEARER_TOKEN;
	fs.rmSync(dir, { recursive: true, force: true });
});

it("uses the deployment SearchAPI token without exposing it in status", async () => {
	assert.equal(SEARCH_ENGINES.map(({ id }) => id).join(","), "searchapi,tavily");
	assert.equal(searchStatus().engine, "searchapi");
	assert.equal(searchProvider()?.id, "searchapi");
	globalThis.fetch = async (input, init) => {
		assert.match(String(input), /\/v1\/search\?/);
		assert.equal((init?.headers as Record<string, string>).authorization, "Bearer gateway-fixture-token");
		return Response.json({ results: [] });
	};
	assert.deepEqual(await searchProvider()!.search("evidence", 1), []);
	assert.ok(!JSON.stringify(searchStatus()).includes("gateway-fixture-token"));
});

it("does not expose the SearchAPI token as an auth-key status row", async () => {
	const { keyStatuses } = await import("../src/server/keys.ts");
	assert.equal(keyStatuses().some((row) => row.id === "SEARCH_API_BEARER_TOKEN"), false);
});
