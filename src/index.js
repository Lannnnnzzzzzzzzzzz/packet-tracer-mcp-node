#!/usr/bin/env node
// Packet Tracer MCP — Node.js port of Mats2208/MCP-Packet-Tracer (MIT).
import { main } from "./server.js";

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
