// PostgREST → SQL for the local (Docker Postgres) leg of the load rehearsal.
//
// GV-438. lib/hotpaths.mjs is the mirror of the mobile data gateway and stays the
// ONLY description of what the client reads. The local aged-workspace harness has
// no PostgREST in front of it, so it needs the same reads as SQL — and hand-writing
// them would create a second, silently drifting copy of the gateway. This module
// translates the hotpaths descriptors instead, so the measured SQL is derived from
// the mirror rather than parallel to it.
//
// Deliberately a SMALL translator: it supports exactly the PostgREST grammar
// hotpaths.mjs uses (select, eq, is.null, in, not.in, order, limit) and THROWS on
// anything else, so a future gateway filter shape fails loudly here instead of
// being measured as something subtly different.

// A single-quoted SQL literal. Values come from lib/hotpaths.mjs and the fixture
// (never from user input), but quoting is cheap insurance.
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// PostgREST scalars: true/false/null are keywords, everything else is text-ish and
// safe to hand to Postgres as a quoted literal (implicit cast does the rest).
function scalar(raw) {
  const value = decodeURIComponent(raw);
  if (value === "true" || value === "false" || value === "null") return value;
  return lit(value);
}

function splitList(raw) {
  // `in.(a,b,c)` — hotpaths only ever puts simple, comma-free values in these.
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  if (inner === "") return [];
  return inner.split(",").map((v) => scalar(v));
}

function condition(column, expression) {
  const dot = expression.indexOf(".");
  const op = dot === -1 ? expression : expression.slice(0, dot);
  const rest = dot === -1 ? "" : expression.slice(dot + 1);

  switch (op) {
    case "eq":
      return `${column} = ${scalar(rest)}`;
    case "neq":
      return `${column} <> ${scalar(rest)}`;
    case "is":
      return `${column} is ${decodeURIComponent(rest)}`;
    case "in":
      return `${column} in (${splitList(rest).join(", ")})`;
    case "not": {
      // `not.in.(…)` / `not.is.null`
      const innerDot = rest.indexOf(".");
      const innerOp = innerDot === -1 ? rest : rest.slice(0, innerDot);
      const innerRest = innerDot === -1 ? "" : rest.slice(innerDot + 1);
      if (innerOp === "in") return `${column} not in (${splitList(innerRest).join(", ")})`;
      if (innerOp === "is") return `${column} is not ${decodeURIComponent(innerRest)}`;
      throw new Error(`Unsupported PostgREST negation: ${column}=${expression}`);
    }
    default:
      throw new Error(`Unsupported PostgREST operator: ${column}=${expression}`);
  }
}

// Translate one { table, query } hot-path descriptor into a SQL statement.
export function postgrestToSql({ table, query }, { schema = "public" } = {}) {
  if (!table) throw new Error("postgrestToSql needs a table");
  let columns = "*";
  const where = [];
  const order = [];
  let limit = null;

  for (const part of String(query || "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) throw new Error(`Unsupported PostgREST query part: ${part}`);
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);

    if (key === "select") {
      columns = value === "*" ? "*" : value.split(",").map((c) => c.trim()).join(", ");
    } else if (key === "order") {
      for (const spec of value.split(",")) {
        const [col, dir] = spec.split(".");
        if (dir && dir !== "asc" && dir !== "desc") {
          throw new Error(`Unsupported PostgREST order direction: ${spec}`);
        }
        order.push(`${col} ${(dir || "asc").toUpperCase()}`);
      }
    } else if (key === "limit") {
      limit = Number(value);
      if (!Number.isFinite(limit)) throw new Error(`Unsupported PostgREST limit: ${value}`);
    } else if (key === "offset") {
      throw new Error("Unsupported PostgREST offset (the gateway does not paginate — that is GVM-535)");
    } else {
      where.push(condition(key, value));
    }
  }

  let sql = `select ${columns} from ${schema}.${table}`;
  if (where.length > 0) sql += ` where ${where.join(" and ")}`;
  if (order.length > 0) sql += ` order by ${order.join(", ")}`;
  if (limit !== null) sql += ` limit ${limit}`;
  return sql;
}

// A capped variant of a hot-path descriptor: the same read with `limit N` applied
// (or tightened). Used to measure what a fetch cap would buy on the reads that are
// unbounded over time — the GVM-535 question — without changing the mirror.
export function withLimit(request, limit) {
  const parts = String(request.query || "").split("&").filter((p) => p !== "" && !p.startsWith("limit="));
  parts.push(`limit=${limit}`);
  return { ...request, label: `${request.label}@${limit}`, query: parts.join("&") };
}
