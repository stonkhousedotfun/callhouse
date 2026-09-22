/**
 * The last GET /v2/markets the rules engine read, shared with the HTTP API.
 *
 * The engine polls /v2/markets every tick for spot (rules/engine.ts). The API needs the same list
 * for one thing only: refusing a price alert on a ticker that is not a market, so a wallet does not
 * save an alert that can never fire (F4 DEFECT 5). Nothing here fetches: the engine fills the cache
 * after a successful read, and a read that failed leaves the previous list in place.
 *
 * FAIL OPEN. An empty cache means "not known yet", never "no markets exist": the rules engine is
 * off (RULES_ENABLED=false), it has not ticked yet, or its first market reads failed. Refusing
 * every alert in that state would break alert settings for everyone on an indexer outage, so
 * `allows()` answers true while the cache is empty. It only ever refuses a ticker it has a list to
 * refuse it against.
 */
export class MarketsCache {
  private known: readonly string[] = [];
  private at: number | null = null;

  /** Replace the list with the tickers of a successful /v2/markets read. */
  set(tickers: Iterable<string>, at?: number): void {
    this.known = [...new Set(tickers)].sort();
    this.at = at ?? null;
  }

  /** The cached tickers, sorted. Empty = nothing read yet. */
  tickers(): readonly string[] {
    return this.known;
  }

  /** Unix seconds of the read that filled the cache, when the caller passed one. */
  updatedAt(): number | null {
    return this.at;
  }

  /** Whether an alert may be set on `ticker`. True for every ticker while the cache is empty. */
  allows(ticker: string): boolean {
    return this.known.length === 0 || this.known.includes(ticker);
  }
}
