# @longlonga/mysql

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for interacting with MySQL databases. Provides tools for querying, inspecting, and modifying MySQL databases directly from Claude.

## Installation

### Via Claude Code (recommended)

```bash
claude mcp add --scope user mysql \
  -e MYSQL_HOST=your-host \
  -e MYSQL_PORT=3306 \
  -e MYSQL_USER=your-user \
  -e MYSQL_PASSWORD=your-password \
  -e MYSQL_DATABASE=your-database \
  -- npx -y @longlonga/mysql
```

### Via claude_desktop_config.json

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": ["-y", "@longlonga/mysql"],
      "env": {
        "MYSQL_HOST": "your-host",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "your-user",
        "MYSQL_PASSWORD": "your-password",
        "MYSQL_DATABASE": "your-database"
      }
    }
  }
}
```

## Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `MYSQL_HOST` | Yes | — | MySQL server hostname or IP |
| `MYSQL_PORT` | No | `3306` | MySQL server port |
| `MYSQL_USER` | Yes | — | MySQL username |
| `MYSQL_PASSWORD` | Yes | — | MySQL password |
| `MYSQL_DATABASE` | No | — | Default database (can be overridden per tool call) |

## Tools

| Tool | Description |
|---|---|
| `mysql_list_databases` | List all databases the user has access to |
| `mysql_list_tables` | List all tables in a database |
| `mysql_describe_table` | Get column definitions for a table |
| `mysql_show_create_table` | Get the full CREATE TABLE DDL statement |
| `mysql_query` | Execute a read-only SELECT/SHOW/EXPLAIN query |
| `mysql_execute` | Execute a write SQL statement (INSERT/UPDATE/DELETE/DDL) |
| `mysql_table_stats` | Get row count and size statistics for tables |

## Usage Examples

Once connected, you can ask Claude things like:

- "List all tables in my database"
- "Describe the structure of the users table"
- "Query the last 10 orders"
- "How many rows are in each table?"

## License

MIT
