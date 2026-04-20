#!/usr/bin/env node
/**
 * MySQL MCP Server
 *
 * Provides tools to interact with a MySQL database:
 * list databases, list tables, describe tables, execute queries, etc.
 *
 * Configuration via environment variables:
 *   MYSQL_HOST     (required)
 *   MYSQL_PORT     (default: 3306)
 *   MYSQL_USER     (required)
 *   MYSQL_PASSWORD (required)
 *   MYSQL_DATABASE (optional, default database)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql, { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { z } from "zod";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHARACTER_LIMIT = 25000;
const DEFAULT_QUERY_LIMIT = 100;

// ─── Config validation ────────────────────────────────────────────────────────

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD) {
  const missing = [
    !MYSQL_HOST && "MYSQL_HOST",
    !MYSQL_USER && "MYSQL_USER",
    !MYSQL_PASSWORD && "MYSQL_PASSWORD",
  ]
    .filter(Boolean)
    .join(", ");
  console.error(`[mysql] Error: Missing required environment variables: ${missing}`);
  process.exit(1);
}

// ─── DB connection pool ───────────────────────────────────────────────────────

const pool: Pool = mysql.createPool({
  host: MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || "3306"),
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || undefined,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 10000,
  multipleStatements: false, // Security: prevent multiple statement injection
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateIfNeeded(text: string): string {
  if (text.length > CHARACTER_LIMIT) {
    return (
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n[Truncated: response exceeded ${CHARACTER_LIMIT} chars. Use LIMIT/filters to reduce results.]`
    );
  }
  return text;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("ECONNREFUSED")) {
      return `Error: Cannot connect to MySQL server. Check host/port and ensure the server is running.`;
    }
    if (msg.includes("ER_ACCESS_DENIED")) {
      return `Error: Access denied. Check MYSQL_USER and MYSQL_PASSWORD.`;
    }
    if (msg.includes("ER_BAD_DB_ERROR")) {
      return `Error: Unknown database. Check MYSQL_DATABASE or the 'database' parameter.`;
    }
    if (msg.includes("ER_NO_SUCH_TABLE")) {
      return `Error: Table not found. Use mysql_list_tables to see available tables.`;
    }
    if (msg.includes("ER_PARSE_ERROR")) {
      return `Error: SQL syntax error — ${msg}`;
    }
    return `Error: ${msg}`;
  }
  return `Error: ${String(error)}`;
}

async function executeQuery<T extends RowDataPacket[]>(
  sql: string,
  params: unknown[] = [],
  database?: string
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    if (database) {
      await conn.query(`USE \`${database}\``);
    }
    const [rows] = await conn.query<T>(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

async function executeWrite(
  sql: string,
  params: unknown[] = [],
  database?: string
): Promise<ResultSetHeader> {
  const conn = await pool.getConnection();
  try {
    if (database) {
      await conn.query(`USE \`${database}\``);
    }
    const [result] = await conn.query<ResultSetHeader>(sql, params);
    return result;
  } finally {
    conn.release();
  }
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' or 'json'");

const DatabaseParamSchema = z
  .string()
  .optional()
  .describe("Database name (uses MYSQL_DATABASE env var if omitted)");

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mysql",
  version: "1.0.0",
});

// ── Tool 1: mysql_list_databases ──────────────────────────────────────────────

server.registerTool(
  "mysql_list_databases",
  {
    title: "List MySQL Databases",
    description: `List all databases on the MySQL server.

Returns database names the current user has access to.

Returns:
  - markdown: formatted list
  - json: { databases: string[] }`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ response_format }) => {
    try {
      const rows = await executeQuery<RowDataPacket[]>("SHOW DATABASES");
      const databases = rows.map((r) => Object.values(r)[0] as string);

      if (response_format === ResponseFormat.JSON) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ databases }, null, 2) },
          ],
          structuredContent: { databases },
        };
      }

      const text = `# MySQL Databases\n\n${databases.map((d) => `- \`${d}\``).join("\n")}`;
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 2: mysql_list_tables ─────────────────────────────────────────────────

server.registerTool(
  "mysql_list_tables",
  {
    title: "List Tables in Database",
    description: `List all tables in a MySQL database.

Args:
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  - markdown: formatted table list
  - json: { database: string, tables: string[], count: number }`,
    inputSchema: z.object({
      database: DatabaseParamSchema,
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ database, response_format }) => {
    try {
      const db = database || process.env.MYSQL_DATABASE;
      if (!db) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No database specified. Provide 'database' parameter or set MYSQL_DATABASE env var.",
            },
          ],
        };
      }

      const rows = await executeQuery<RowDataPacket[]>(`SHOW TABLES FROM \`${db}\``);
      const tables = rows.map((r) => Object.values(r)[0] as string);

      const output = { database: db, tables, count: tables.length };

      if (response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const text =
        `# Tables in \`${db}\`\n\nTotal: ${tables.length}\n\n` +
        tables.map((t) => `- \`${t}\``).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 3: mysql_describe_table ──────────────────────────────────────────────

server.registerTool(
  "mysql_describe_table",
  {
    title: "Describe Table Structure",
    description: `Get column definitions for a MySQL table (equivalent to DESCRIBE or SHOW COLUMNS).

Args:
  - table (string, required): Table name
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns column info: Field, Type, Null, Key, Default, Extra`,
    inputSchema: z.object({
      table: z.string().min(1).describe("Table name to describe"),
      database: DatabaseParamSchema,
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ table, database, response_format }) => {
    try {
      const db = database || process.env.MYSQL_DATABASE;
      const rows = await executeQuery<RowDataPacket[]>(
        `SHOW COLUMNS FROM \`${table}\``,
        [],
        db
      );

      if (response_format === ResponseFormat.JSON) {
        const output = { table, database: db, columns: rows };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const lines = [
        `# Table: \`${db ? db + "." : ""}${table}\``,
        "",
        "| Field | Type | Null | Key | Default | Extra |",
        "|-------|------|------|-----|---------|-------|",
      ];
      for (const col of rows) {
        lines.push(
          `| \`${col.Field}\` | ${col.Type} | ${col.Null} | ${col.Key || "-"} | ${col.Default ?? "NULL"} | ${col.Extra || "-"} |`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 4: mysql_show_create_table ──────────────────────────────────────────

server.registerTool(
  "mysql_show_create_table",
  {
    title: "Show CREATE TABLE Statement",
    description: `Get the full CREATE TABLE DDL statement for a table.

Args:
  - table (string, required): Table name
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.

Returns the complete CREATE TABLE SQL with all indexes, constraints, and engine settings.`,
    inputSchema: z.object({
      table: z.string().min(1).describe("Table name"),
      database: DatabaseParamSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ table, database }) => {
    try {
      const db = database || process.env.MYSQL_DATABASE;
      const rows = await executeQuery<RowDataPacket[]>(
        `SHOW CREATE TABLE \`${table}\``,
        [],
        db
      );
      const ddl = rows[0]["Create Table"] as string;
      return {
        content: [
          { type: "text", text: "```sql\n" + ddl + "\n```" },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 5: mysql_query ───────────────────────────────────────────────────────

server.registerTool(
  "mysql_query",
  {
    title: "Execute SELECT Query",
    description: `Execute a read-only SELECT query against MySQL.

Only SELECT and SHOW/EXPLAIN statements are permitted. Use mysql_execute for write operations.

Args:
  - sql (string, required): SQL SELECT statement. Use ? placeholders for params.
  - params (array, optional): Bind parameters corresponding to ? placeholders.
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.
  - limit (number, optional): Max rows to return (default: 100, max: 1000).
  - response_format ('markdown' | 'json'): Output format (default: 'json')

Returns:
  - json: { rows: object[], count: number, has_more: boolean }
  - markdown: formatted table

Examples:
  - sql: "SELECT * FROM biz_exhaust_yg WHERE jcrq = ? LIMIT 10", params: ["2026-03"]
  - sql: "SELECT COUNT(*) as cnt FROM biz_exhaust_hy"`,
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .describe("SELECT SQL statement. Use ? for bind parameters."),
      params: z
        .array(z.union([z.string(), z.number(), z.null()]))
        .optional()
        .default([])
        .describe("Bind parameters for ? placeholders"),
      database: DatabaseParamSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(DEFAULT_QUERY_LIMIT)
        .describe("Maximum rows to return (default 100)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.JSON)
        .describe("Output format: 'markdown' or 'json'"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ sql, params, database, limit, response_format }) => {
    try {
      // Security: only allow read-only statements
      const trimmed = sql.trim().toUpperCase();
      if (
        !trimmed.startsWith("SELECT") &&
        !trimmed.startsWith("SHOW") &&
        !trimmed.startsWith("EXPLAIN") &&
        !trimmed.startsWith("DESCRIBE")
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Only SELECT/SHOW/EXPLAIN/DESCRIBE statements are allowed. Use mysql_execute for write operations.",
            },
          ],
        };
      }

      // Inject LIMIT if not present to cap results
      const limitedSql = injectLimit(sql, limit);
      const db = database || process.env.MYSQL_DATABASE;
      const rows = await executeQuery<RowDataPacket[]>(limitedSql, params ?? [], db);

      const output = {
        count: rows.length,
        rows: rows as Record<string, unknown>[],
        has_more: rows.length === limit,
      };

      let text: string;
      if (response_format === ResponseFormat.MARKDOWN && rows.length > 0) {
        text = formatRowsAsMarkdown(rows as Record<string, unknown>[]);
        text += `\n\n_Rows: ${rows.length}${output.has_more ? " (may have more — increase limit or add filters)" : ""}_`;
      } else {
        text = JSON.stringify(output, null, 2);
      }

      return {
        content: [{ type: "text", text: truncateIfNeeded(text) }],
        structuredContent: output,
      };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 6: mysql_execute ─────────────────────────────────────────────────────

server.registerTool(
  "mysql_execute",
  {
    title: "Execute Write SQL",
    description: `Execute a write SQL statement (INSERT, UPDATE, DELETE, DDL).

WARNING: This tool modifies data. Use with caution.

Args:
  - sql (string, required): SQL statement. Use ? placeholders for parameters.
  - params (array, optional): Bind parameters corresponding to ? placeholders.
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.

Returns:
  { affectedRows: number, insertId: number, changedRows: number }

Examples:
  - sql: "UPDATE biz_exhaust_hy SET DELETE_FLAG = 'DELETED' WHERE ID = ?", params: [123]
  - sql: "INSERT INTO my_table (name) VALUES (?)", params: ["test"]`,
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .describe("Write SQL statement. Use ? for bind parameters."),
      params: z
        .array(z.union([z.string(), z.number(), z.null()]))
        .optional()
        .default([])
        .describe("Bind parameters for ? placeholders"),
      database: DatabaseParamSchema,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ sql, params, database }) => {
    try {
      const db = database || process.env.MYSQL_DATABASE;
      const result = await executeWrite(sql, params ?? [], db);
      const output = {
        affectedRows: result.affectedRows,
        insertId: result.insertId,
        changedRows: result.changedRows,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ── Tool 7: mysql_table_stats ─────────────────────────────────────────────────

server.registerTool(
  "mysql_table_stats",
  {
    title: "Get Table Statistics",
    description: `Get row count and size statistics for tables in a database.

Args:
  - database (string, optional): Database name. Uses MYSQL_DATABASE if omitted.
  - table (string, optional): Filter to a specific table. If omitted, returns all tables.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns per table: table_name, row_count, data_size_mb, index_size_mb, engine, create_time`,
    inputSchema: z.object({
      database: DatabaseParamSchema,
      table: z
        .string()
        .optional()
        .describe("Optional: filter to a specific table name"),
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ database, table, response_format }) => {
    try {
      const db = database || process.env.MYSQL_DATABASE;
      if (!db) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No database specified. Provide 'database' parameter or set MYSQL_DATABASE env var.",
            },
          ],
        };
      }

      const params: string[] = [db];
      let sql = `
        SELECT
          TABLE_NAME AS table_name,
          TABLE_ROWS AS row_count,
          ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_size_mb,
          ROUND(INDEX_LENGTH / 1024 / 1024, 2) AS index_size_mb,
          ENGINE AS engine,
          CREATE_TIME AS create_time
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?`;

      if (table) {
        sql += " AND TABLE_NAME = ?";
        params.push(table);
      }

      sql += " ORDER BY TABLE_ROWS DESC";

      const rows = await executeQuery<RowDataPacket[]>(sql, params);

      if (response_format === ResponseFormat.JSON) {
        const output = { database: db, tables: rows, count: rows.length };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const lines = [
        `# Table Statistics: \`${db}\``,
        "",
        "| Table | Rows | Data (MB) | Index (MB) | Engine | Created |",
        "|-------|------|-----------|------------|--------|---------|",
      ];
      for (const r of rows) {
        lines.push(
          `| \`${r.table_name}\` | ${r.row_count ?? "?"} | ${r.data_size_mb} | ${r.index_size_mb} | ${r.engine} | ${r.create_time ?? "-"} |`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }] };
    }
  }
);

// ─── Utility Functions ────────────────────────────────────────────────────────

/**
 * Inject a LIMIT clause into a SELECT query if none is present.
 * Adds the limit before any trailing semicolon.
 */
function injectLimit(sql: string, limit: number): string {
  const upper = sql.trim().toUpperCase();
  if (upper.includes("LIMIT")) return sql;
  const trimmed = sql.trim().replace(/;$/, "");
  return `${trimmed} LIMIT ${limit}`;
}

/**
 * Format an array of row objects as a Markdown table.
 */
function formatRowsAsMarkdown(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No rows returned_";
  const keys = Object.keys(rows[0]);
  const header = "| " + keys.join(" | ") + " |";
  const separator = "| " + keys.map(() => "---").join(" | ") + " |";
  const dataRows = rows.map(
    (r) =>
      "| " +
      keys
        .map((k) => {
          const v = r[k];
          return v === null || v === undefined ? "NULL" : String(v).replace(/\|/g, "\\|");
        })
        .join(" | ") +
      " |"
  );
  return [header, separator, ...dataRows].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify DB connectivity on startup
  try {
    await pool.query("SELECT 1");
    console.error(
      `[mysql] Connected to MySQL at ${MYSQL_HOST}:${process.env.MYSQL_PORT || 3306}`
    );
  } catch (error) {
    console.error("[mysql] WARNING: Could not connect to MySQL on startup:", formatError(error));
    console.error("[mysql] Server will start anyway — check MYSQL_HOST/MYSQL_PASSWORD env vars.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mysql] MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
