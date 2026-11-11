/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): search adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - SearchAPI is deployment-keyed through process.env and is preferred;
 *    Tavily remains a user-managed direct fallback.
 *  - Explicit agent.search.engine pins the preference; without a pin the
 *    first connected engine wins in SearchAPI → Tavily order.
 *  - An explicit choice does NOT silently fall back to another engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import { SEARCH_ENGINES, type SearchEngineId, type SearchHit, type SearchProvider, type SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const SEARCH_API_ENDPOINT = process.env.SEARCHAPI_ENDPOINT ?? "http://searchapi:8000";

/** The shared gateway owns SearXNG-first search and Brave fallback. The bearer
 * token is deployment configuration and is never exposed through /api/keys. */
export function searchApiProvider(token: string, endpoint = SEARCH_API_ENDPOINT, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "searchapi",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("/v1/search", endpoint);
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(10, Math.max(1, Math.floor(count)))));
			url.searchParams.set("include_content", "true");
			url.searchParams.set("content_count", "3");
			url.searchParams.set("content_max_chars", "4000");
			const resp = await fetchFn(url.toString(), {
				headers: { accept: "application/json", authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) throw new Error(`SearchAPI search API ${resp.status}`);
			const data = await searchJson(resp, "SearchAPI");
			if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) {
				throw new Error("SearchAPI search API returned an invalid response");
			}
			return (data as { results: unknown[] }).results.flatMap((result): SearchHit[] => {
				if (!result || typeof result !== "object") return [];
				const row = result as { title?: unknown; url?: unknown; snippet?: unknown; content?: unknown };
				return searchHit(row.title, row.url, row.snippet ?? row.content);
			});
		},
	};
}

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Invalid JSON must not echo provider response bodies into tool results. */
async function searchJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${label} search API returned an invalid response`);
	}
}

/** Normalize a gateway result to the app's bounded search-hit contract. */
function searchHit(title: unknown, url: unknown, snippet: unknown): SearchHit[] {
	if (typeof url !== "string" || !url.trim()) return [];
	try {
		const protocol = new URL(url).protocol;
		if (protocol !== "http:" && protocol !== "https:") return [];
	} catch { return []; }
	return [{
		title: typeof title === "string" && title ? title : url,
		url,
		snippet: typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim().slice(0, 500) : "",
	}];
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = SEARCH_ENGINES.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Every engine's live key, read fresh (the resolver's input). */
function engineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of SEARCH_ENGINES) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
		reason: `search engine is set to "${pinned}" but its connection is missing — configure ${SEARCH_ENGINES.find((e) => e.id === pinned)?.envVar}`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of SEARCH_ENGINES) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — configure SearchAPI or set a Tavily search API key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		engineKeys(),
	);
	return { available, engine, reason };
}

/** Search status only — research itself remains available without a key. */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	switch (resolved.engine) {
		case "searchapi":
			return searchApiProvider(resolved.key);
		case "tavily":
			return tavilyProvider(resolved.key);
		default:
			return null;
	}
}
