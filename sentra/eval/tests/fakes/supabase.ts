// An in-memory stand-in for the slice of supabase-js the harness uses.
//
// Not a database: it keeps rows per table, applies `eq`/`in` filters, enforces
// the unique keys a test declares, and can be told to refuse an operation the
// way the real project does (a revoked DELETE, a table that does not exist).
// Every call is logged so a test can assert what the harness wrote, in order.
// Nothing here opens a socket.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;
type Op = "select" | "insert" | "upsert" | "update" | "delete";
type Filter = { column: string; kind: "eq" | "in"; value: unknown };

export interface FakeError {
  code: string;
  message: string;
}

export interface LoggedCall {
  table: string;
  op: Op;
  values?: unknown;
  filters: Filter[];
  error?: FakeError;
}

export interface TableRules {
  /** Column sets that must be unique, like a unique index. */
  unique?: string[][];
  /** Operations refused with a permission error, like a revoked grant. */
  deny?: Op[];
  /** The table is not in the schema at all. */
  missing?: boolean;
}

export class FakeSupabase {
  private readonly tables = new Map<string, Row[]>();
  private readonly rules = new Map<string, TableRules>();
  private nextId = 1;
  readonly log: LoggedCall[] = [];
  readonly uploads: string[] = [];
  users: Array<{ id: string; email: string }> = [];

  readonly auth = {
    admin: {
      listUsers: async () => ({ data: { users: this.users }, error: null }),
      createUser: async ({ email }: { email: string; password: string }) => {
        if (this.users.some((user) => user.email === email)) {
          return { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
        }
        const user = { id: `user-${this.nextId++}`, email };
        this.users.push(user);
        this.passwordWrites.push(email);
        return { data: { user }, error: null };
      },
      updateUserById: async (id: string) => {
        const user = this.users.find((candidate) => candidate.id === id);
        if (user) this.passwordWrites.push(user.email);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "not found" } };
      },
    },
  };
  /** Accounts whose password was set, in order (never the passwords themselves). */
  readonly passwordWrites: string[] = [];

  readonly storage = {
    from: () => ({
      upload: async (path: string) => {
        this.uploads.push(path);
        return { data: { path }, error: null };
      },
    }),
  };

  rule(table: string, rules: TableRules): this {
    this.rules.set(table, rules);
    return this;
  }

  seed(table: string, rows: Row[]): this {
    this.rowsOf(table).push(...rows.map((row) => ({ id: this.id(table), ...row })));
    return this;
  }

  rows(table: string): Row[] {
    return this.rowsOf(table);
  }

  /** The calls made against one table, optionally of one kind. */
  calls(table: string, op?: Op): LoggedCall[] {
    return this.log.filter((call) => call.table === table && (!op || call.op === op));
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  /** @internal */
  rowsOf(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  /** @internal */
  rulesOf(table: string): TableRules {
    return this.rules.get(table) ?? {};
  }

  /** @internal */
  id(table: string): string {
    return `${table}-${this.nextId++}`;
  }
}

const matches = (row: Row, filters: Filter[]) =>
  filters.every((filter) => filter.kind === "eq"
    ? row[filter.column] === filter.value
    : (filter.value as unknown[]).includes(row[filter.column]));

export class FakeQuery implements PromiseLike<{ data: unknown; error: FakeError | null; count?: number | null }> {
  private op: Op = "select";
  private values: unknown;
  private onConflict?: string[];
  private readonly filters: Filter[] = [];
  private returning = false;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private max?: number;

  private readonly db: FakeSupabase;
  private readonly table: string;

  constructor(db: FakeSupabase, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_columns?: string): this {
    if (this.op !== "select") this.returning = true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.op = "insert";
    this.values = values;
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string }): this {
    this.op = "upsert";
    this.values = values;
    this.onConflict = options?.onConflict?.split(",").map((column) => column.trim());
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.values = values;
    return this;
  }

  delete(_options?: { count?: "exact" }): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, kind: "eq", value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, kind: "in", value });
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.max = count;
    return this;
  }

  single(): this {
    this.mode = "single";
    return this;
  }

  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  then<TResult1 = { data: unknown; error: FakeError | null; count?: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: FakeError | null; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: unknown; error: FakeError | null; count?: number | null } {
    const rules = this.db.rulesOf(this.table);
    const call: LoggedCall = { table: this.table, op: this.op, values: this.values, filters: [...this.filters] };
    this.db.log.push(call);
    const fail = (error: FakeError) => {
      call.error = error;
      return { data: null, error, count: null };
    };
    if (rules.missing) {
      return fail({ code: "PGRST205", message: `Could not find the table 'public.${this.table}' in the schema cache` });
    }
    if (rules.deny?.includes(this.op)) {
      return fail({ code: "42501", message: `permission denied for table ${this.table}` });
    }
    const rows = this.db.rowsOf(this.table);

    if (this.op === "select") {
      const found = rows.filter((row) => matches(row, this.filters)).slice(0, this.max);
      return this.shape(found);
    }
    if (this.op === "delete") {
      const doomed = rows.filter((row) => matches(row, this.filters));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { data: null, error: null, count: doomed.length };
    }
    if (this.op === "update") {
      const changed = rows.filter((row) => matches(row, this.filters));
      for (const row of changed) Object.assign(row, this.values as Row);
      return this.returning ? this.shape(changed) : { data: null, error: null };
    }

    const incoming = (Array.isArray(this.values) ? this.values : [this.values]) as Row[];
    const written: Row[] = [];
    for (const value of incoming) {
      if (this.op === "upsert" && this.onConflict) {
        const key = this.onConflict;
        const existing = rows.find((row) => key.every((column) => row[column] === value[column]));
        if (existing) {
          Object.assign(existing, value);
          written.push(existing);
          continue;
        }
      }
      for (const columns of rules.unique ?? []) {
        if (rows.some((row) => columns.every((column) => row[column] === value[column]))) {
          return fail({ code: "23505", message: `duplicate key value violates unique constraint on (${columns.join(", ")})` });
        }
      }
      const row = { id: this.db.id(this.table), ...value };
      rows.push(row);
      written.push(row);
    }
    return this.returning ? this.shape(written) : { data: null, error: null };
  }

  private shape(found: Row[]): { data: unknown; error: FakeError | null } {
    if (this.mode === "many") return { data: found, error: null };
    if (found.length === 1) return { data: found[0], error: null };
    if (this.mode === "maybeSingle" && found.length === 0) return { data: null, error: null };
    return { data: null, error: { code: "PGRST116", message: `expected one row, got ${found.length}` } };
  }
}
