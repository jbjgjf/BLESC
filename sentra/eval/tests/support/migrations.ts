// Reads table facts out of sentra/supabase/migrations, for tests that must stay
// in step with the schema (#375). Not a SQL parser: it understands the shapes
// these migrations use — `create table [if not exists] [public.]name ( … )`,
// `alter table … add column owner_user_id`, `drop table`, and `references`
// clauses with their `on delete` action — and a test that depends on it should
// fail loudly if it ever finds nothing.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

export interface ForeignKey {
  child: string;
  parent: string;
  onDelete: string;
  file: string;
}

export interface SchemaFacts {
  /** Tables that have an owner_user_id column, as of the last migration. */
  ownerScoped: Set<string>;
  foreignKeys: ForeignKey[];
}

/** The text between the parenthesis at `start` and its match. */
function balanced(sql: string, start: number): string {
  let depth = 1;
  let index = start;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") depth -= 1;
    index += 1;
  }
  return sql.slice(start, index - 1);
}

const onDeleteOf = (clause: string) =>
  (clause.match(/on delete (cascade|set null|set default|restrict|no action)/i)?.[1] ?? "no action").toLowerCase();

export function readSchema(): SchemaFacts {
  const ownerScoped = new Set<string>();
  const foreignKeys: ForeignKey[] = [];
  const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS}${file}`, "utf8").replace(/--[^\n]*/g, "");
    // Applied in the order they appear, so `drop table x; create table x` in
    // one file ends with x present.
    const statement = /create table (?:if not exists )?(?:public\.)?(\w+)\s*\(|alter table (?:if exists )?(?:only )?(?:public\.)?(\w+)([^;]*)|drop table (?:if exists )?(?:public\.)?(\w+)/gi;
    for (let match = statement.exec(sql); match; match = statement.exec(sql)) {
      const [, created, altered, alteration, dropped] = match;
      if (created) {
        const body = balanced(sql, statement.lastIndex);
        if (/\bowner_user_id\b/.test(body)) ownerScoped.add(created);
        const references = /references\s+(?:public\.|auth\.)?(\w+)\s*\([^)]*\)([^,]*)/gi;
        for (let ref = references.exec(body); ref; ref = references.exec(body)) {
          foreignKeys.push({ child: created, parent: ref[1], onDelete: onDeleteOf(ref[2]), file });
        }
      } else if (altered) {
        if (/add column (?:if not exists )?owner_user_id\b/i.test(alteration)) ownerScoped.add(altered);
        const references = /references\s+(?:public\.|auth\.)?(\w+)\s*\([^)]*\)([^,]*)/gi;
        for (let ref = references.exec(alteration); ref; ref = references.exec(alteration)) {
          foreignKeys.push({ child: altered, parent: ref[1], onDelete: onDeleteOf(ref[2]), file });
        }
      } else if (dropped) {
        ownerScoped.delete(dropped);
        for (const key of foreignKeys.filter((fk) => fk.child === dropped)) foreignKeys.splice(foreignKeys.indexOf(key), 1);
      }
    }
  }
  return { ownerScoped, foreignKeys };
}
