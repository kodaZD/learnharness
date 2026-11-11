import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, searchApiProvider, tavilyProvider } from "../src/server/search.ts";
import { SEARCH_ENGINES, isSearchEngineId } from "../src/core/search.ts";

describe("SearchAPI-first resolution", () => {
	it("prefers SearchAPI over Tavily in Automatic mode", () => {
		const result = resolveSearchEngineFor(undefined, { searchapi: "gateway-token", tavily: "tvly-key" });
		assert.deepEqual(result, { available: true, engine: "searchapi", reason: "search engine: searchapi (auto)", key: "gateway-token" });
	});

	it("falls back to Tavily only when SearchAPI is unavailable", () => {
		assert.equal(resolveSearchEngineFor(undefined, { tavily: "tvly-key" }).engine, "tavily");
		assert.equal(resolveSearchEngineFor(undefined, {}).available, false);
	});

	it("does not silently fall back from an explicit pin", () => {
		const result = resolveSearchEngineFor("searchapi", { tavily: "tvly-key" });
		assert.equal(result.available, false);
		assert.match(result.reason, /SEARCH_API_BEARER_TOKEN/);
	});

	it("only exposes SearchAPI and Tavily as selectable engines", () => {
		assert.deepEqual(SEARCH_ENGINES.map(({ id }) => id), ["searchapi", "tavily"]);
		assert.equal(isSearchEngineId("brave"), false);
		assert.equal(isSearchEngineId("tavily"), true);
	});
});

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("search adapters", () => {
	it("calls the internal SearchAPI REST contract and maps results", async () => {
		const provider = searchApiProvider("gateway-token", "http://searchapi:8000", async (url, init) => {
			assert.equal(url, "http://searchapi:8000/v1/search?q=test+query&count=5&include_content=true&content_count=3&content_max_chars=4000");
			assert.equal((init.headers as Record<string, string>).authorization, "Bearer gateway-token");
			return response({ results: [{ title: "Example", url: "https://example.com", snippet: "A result" }, { title: "No URL" }] });
		});
		assert.deepEqual(await provider.search("test query", 5), [{ title: "Example", url: "https://example.com", snippet: "A result" }]);
	});

	it("keeps Tavily as the direct fallback adapter", async () => {
		const provider = tavilyProvider("tvly-key", async (url, init) => {
			assert.equal(url, "https://api.tavily.com/search");
			assert.equal((init.headers as Record<string, string>).authorization, "Bearer tvly-key");
			return response({ results: [{ title: "Example", url: "https://example.com", content: "A result" }] });
		});
		assert.deepEqual(await provider.search("q", 1), [{ title: "Example", url: "https://example.com", snippet: "A result" }]);
	});
});
