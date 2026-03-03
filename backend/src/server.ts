import { createServer } from "./createServer.js";

const server = createServer();

console.log(`Bannerfall backend listening on ws://localhost:${server.port}`);
