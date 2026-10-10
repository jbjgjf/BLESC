/**
 * An in-memory stand-in for the slice of the Supabase client the server stores
 * use: `.from(table)` with select / insert / update and the filters below, and
 * `.rpc(name, args)`.
 *
 * It applies the filters to real rows rather than recording that they were
 * called, so a test can state the behaviour ("the withdrawn row is not
 * returned") instead of the query text. A filter it does not implement throws:
 * a store that starts using one should fail here, not silently match everything.
 */

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.columns = null;
    this.action = "select";
    this.payload = null;
    this.ordering = null;
    this.max = null;
    this.single = false;
  }

  select(columns = "*") {
    this.columns = columns;
    return this;
  }
  insert(rows) {
    this.action = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch) {
    this.action = "update";
    this.payload = patch;
    return this;
  }
  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column, value) {
    if (value !== null) throw new Error("fake-supabase: .is() supports null only");
    this.filters.push((row) => row[column] === null || row[column] === undefined);
    return this;
  }
  not(column, operator, value) {
    if (operator !== "in") throw new Error(`fake-supabase: .not(…, "${operator}") is not implemented`);
    const excluded = value.replace(/^\(|\)$/g, "").split(",");
    this.filters.push((row) => !excluded.includes(String(row[column])));
    return this;
  }
  order(column, { ascending = true } = {}) {
    this.ordering = { column, ascending };
    return this;
  }
  limit(count) {
    this.max = count;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  run() {
    const failure = this.db.failures.get(this.table)?.shift();
    this.db.calls.push({ table: this.table, action: this.action, payload: this.payload });
    if (failure) return { data: null, error: failure };

    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);

    if (this.action === "insert") {
      rows.push(...this.payload.map((row) => ({ ...row })));
      return { data: null, error: null };
    }

    let matched = rows.filter((row) => this.filters.every((keep) => keep(row)));
    if (this.action === "update") matched.forEach((row) => Object.assign(row, this.payload));

    if (this.ordering) {
      const { column, ascending } = this.ordering;
      matched = [...matched].sort(
        (a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1),
      );
    }
    if (this.max !== null) matched = matched.slice(0, this.max);

    // Only the selected columns come back, as from PostgREST: a column the
    // store did not ask for cannot reach its caller.
    const wanted =
      !this.columns || this.columns === "*" ? null : this.columns.split(",").map((name) => name.trim());
    const projected = matched.map((row) =>
      wanted ? Object.fromEntries(wanted.map((name) => [name, row[name] ?? null])) : { ...row },
    );

    if (!this.single) return { data: projected, error: null };
    if (projected.length > 1) {
      return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
    }
    return { data: projected[0] ?? null, error: null };
  }
}

/**
 * @param tables  `{ table_name: [row, …] }`, mutated by inserts and updates.
 * @param rpc     `{ function_name: (args, callIndex) => ({ data, error }) }`.
 */
export function fakeSupabase({ tables = {}, rpc = {} } = {}) {
  const db = { tables, calls: [], rpcCalls: [], failures: new Map() };

  return {
    tables,
    /** Every table operation, in order. */
    calls: db.calls,
    /** Every rpc call, in order: `{ name, args }`. */
    rpcCalls: db.rpcCalls,
    /** The next operation on `table` returns this error instead of running. */
    failNext(table, error = { message: "connection reset" }) {
      db.failures.set(table, [...(db.failures.get(table) ?? []), error]);
    },
    from(table) {
      return new Query(db, table);
    },
    async rpc(name, args) {
      const index = db.rpcCalls.filter((call) => call.name === name).length;
      db.rpcCalls.push({ name, args });
      if (!rpc[name]) throw new Error(`fake-supabase: no handler for rpc("${name}")`);
      return rpc[name](args, index);
    },
  };
}
