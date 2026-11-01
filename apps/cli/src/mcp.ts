#!/usr/bin/env node
import { reportMcpError, runMcpCommand } from "./mcp-command.js";

runMcpCommand(process.argv.slice(2)).catch(reportMcpError);
