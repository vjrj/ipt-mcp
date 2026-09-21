#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session, configFromEnv, registerTools } from "./tools.ts";

const server = new McpServer({ name: "ipt-mcp", version: "0.2.0" });
registerTools(server, new Session(configFromEnv()));
await server.connect(new StdioServerTransport());
