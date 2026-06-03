#!/usr/bin/env node
/**
 * Xizhao CLI entry point.
 *
 * v1 commands: setup, client, dashboard, conn, policy, audit
 */
import { program } from "commander";

program
  .name("xizhao")
  .description("Secure MCP proxy for AI agents accessing MySQL")
  .version("0.0.1");

program.parse();
