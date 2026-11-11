/**
 * The search-provider port (search port + model slots wave, 2026-09-20).
 *
 * Search engines are pluggable behind ONE seam: the settings record names a
 * preferred engine (agent.search.engine — optional), keys live in the auth
 * store (the curated key catalog), and the server composes the live adapter.
 *
 * Owner decisions baked here:
 *  - SearchAPI is the default gateway when its environment token is present;
 *    Tavily remains available as the direct-provider alternative.
 *    agent.search.engine is only an explicit preference.
 *  - Nothing silently falls back: no engine live = search is honestly
 *    unavailable (the tool says so). Research remains available keylessly
 *    through web_fetch for known URLs.
 *
 * Pure types, the engine table + protocol docs only (browser-safe, no node
 * imports): the adapters are server-side (src/server/search.ts) and arrive
 * as injected dependencies — the agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Search engines in automatic preference order. Keep existing preferences
 * stable when adding an engine: an explicit pin always wins. */
export const SEARCH_ENGINES = [
	{ id: "searchapi", label: "SearchAPI", envVar: "SEARCH_API_BEARER_TOKEN" },
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value);
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
