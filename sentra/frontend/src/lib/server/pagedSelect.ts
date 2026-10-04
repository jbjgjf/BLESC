/**
 * Reading a whole table when PostgREST will only hand over part of it (#275).
 *
 * PostgREST answers every request under `db-max-rows` — 1,000 on a stock
 * Supabase project — and a request that would have returned more is **not an
 * error**. `result.error` is null, the array is simply shorter, and every count
 * taken from it is wrong in the direction of "nothing to see".
 *
 * That default sits inside this pilot's design scale, not outside it. Fifty
 * participants times twenty-one days is up to 1,050 journal entries and the
 * same number of self-report rows, so the truncation arrives on schedule
 * somewhere around day twenty of a run that went exactly as planned.
 *
 * ## Why this is a loop and not a bigger `limit`
 *
 * `limit(5000)` does not raise the ceiling; `db-max-rows` still applies and
 * still applies silently. The only way to read past it is to ask for ranges
 * until the table is exhausted, which is what this does.
 *
 * ## Why it asks for the count
 *
 * A pager that stops when a page comes back short is correct only while pages
 * come back the size they were asked for. If a deployment sets `db-max-rows`
 * below `PAGE_SIZE`, every page is short, the loop stops on the first one, and
 * the silent truncation is back with a pager in front of it. So the caller
 * requests `{ count: "exact" }`, the first page says how many rows exist, and
 * the loop runs until it has them. Falling short is reported as a failure
 * rather than returned as a shorter list — the whole point of this module is
 * that "could not read it all" and "there is not much there" stop looking the
 * same.
 *
 * ## Why it compares the count on every page
 *
 * Each range is its own query, so a row written while the dashboard is paging
 * shifts every later offset: the next page repeats a row already read and a
 * row beyond it is never seen, while the row total can still reach the first
 * page's figure. So every page's count is compared with the first one, and
 * rows that carry an `id` are checked for repeats. A mismatch re-reads the
 * whole table once (a write that has landed usually stays landed); a second
 * mismatch is reported as a failure, never returned as rows.
 */

/** Rows per request. Below `db-max-rows` on a stock Supabase project. */
export const PAGE_SIZE = 500;

/**
 * Refuse rather than page forever.
 *
 * Far above 50 x 21, so reaching it means the caller scoped nothing — and a
 * dashboard handler quietly pulling a hundred thousand rows is a bug worth an
 * error message rather than a slow response.
 */
export const MAX_ROWS = 100_000;

export type PagedRows<T> = { rows: T[] } | { error: string };

/** One `range()` response, in the shape supabase-js returns. */
export type RangeResponse<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/**
 * Read one range. Called repeatedly, so it has to build a fresh query each
 * time: a supabase-js builder is awaited once and cannot be re-run.
 */
export type RangeReader<T> = (from: number, to: number) => PromiseLike<RangeResponse<T>>;

/** Whole-table reads attempted before a table that keeps changing is an error. */
const READ_ATTEMPTS = 2;

type ReadOutcome<T> = { rows: T[] } | { error: string; changed?: true };

/** The row's `id`, when it has one usable as a key; otherwise null. */
function rowKey(row: unknown): string | number | null {
  if (typeof row !== "object" || row === null || !("id" in row)) return null;
  const id = (row as { id: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export async function fetchAllRows<T>(
  read: RangeReader<T>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<PagedRows<T>> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxRows = options.maxRows ?? MAX_ROWS;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    return { error: `pageSize には正の整数を渡してください（${pageSize}）。` };
  }

  let outcome = await readOnce(read, pageSize, maxRows);
  for (let attempt = 1; attempt < READ_ATTEMPTS && "changed" in outcome; attempt += 1) {
    outcome = await readOnce(read, pageSize, maxRows);
  }
  return "error" in outcome ? { error: outcome.error } : outcome;
}

async function readOnce<T>(read: RangeReader<T>, pageSize: number, maxRows: number): Promise<ReadOutcome<T>> {
  const tooMany = { error: `読み出しが ${maxRows} 行を超えました。問い合わせの範囲が広すぎます。` };
  const changed = (what: string): ReadOutcome<T> => ({
    changed: true,
    error: `読み出し中に${what}。ページがずれた可能性があるため、不正確な集計を返さずに失敗として報告します。`,
  });
  const rows: T[] = [];
  const seen = new Set<string | number>();
  // From the first response. Null when the caller did not ask for a count, in
  // which case a short page is the only available end-of-table signal.
  let expected: number | null = null;
  let from = 0;

  for (;;) {
    const page = await read(from, from + pageSize - 1);
    if (page.error) return { error: page.error.message };

    const batch = page.data ?? [];
    if (typeof page.count === "number") {
      if (from === 0) {
        expected = page.count;
        // Before any return: an exact count over the bound is refused even
        // when every row would have arrived.
        if (expected > maxRows) return tooMany;
      } else if (expected !== null && page.count !== expected) {
        return changed(`行数が ${expected} 件から ${page.count} 件に変わりました`);
      }
    }
    for (const row of batch) {
      const key = rowKey(row);
      if (key === null) continue;
      if (seen.has(key)) return changed("同じ行が二度返されました");
      seen.add(key);
    }
    rows.push(...batch);
    if (rows.length > maxRows) return tooMany;

    if (expected !== null) {
      if (rows.length >= expected) return { rows };
      if (batch.length === 0) {
        return {
          error:
            `${expected} 件あるはずの行のうち ${rows.length} 件しか読めませんでした。` +
            "不完全な集計を返さずに失敗として報告します。",
        };
      }
    } else if (batch.length < pageSize) {
      return { rows };
    }

    // By what actually arrived, not by what was asked for: a server-side cap
    // smaller than `pageSize` then advances correctly instead of skipping rows.
    from += batch.length;
  }
}
