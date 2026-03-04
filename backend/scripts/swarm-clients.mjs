import { WebSocket } from "ws";

function parseArgs(argv) {
  const args = { count: null, url: null, joinCode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--count" && typeof argv[index + 1] === "string") {
      args.count = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--url" && typeof argv[index + 1] === "string") {
      args.url = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--joinCode" && typeof argv[index + 1] === "string") {
      args.joinCode = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const url = cli.url ?? process.env.BF_WS_URL ?? "ws://127.0.0.1:8080";
const countRaw = cli.count ?? process.env.BF_COUNT ?? "14";
const count = Number(countRaw);
const joinCode = (cli.joinCode ?? process.env.BF_JOIN_CODE ?? "").trim() || null;

if (!Number.isInteger(count) || count <= 0) {
  console.error(`Invalid --count value: ${countRaw}`);
  process.exit(1);
}

const sockets = [];

for (let i = 1; i <= count; i += 1) {
  const playerId = `local-${i}`;
  const name = `Local${i}`;
  const ws = new WebSocket(url);
  sockets.push(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      console.log(`parse-error ${playerId}`);
      return;
    }

    if (msg.type === "connected") {
      if (joinCode) {
        ws.send(JSON.stringify({ type: "join_lobby", joinCode, playerId, name }));
      } else {
        ws.send(JSON.stringify({ type: "join", playerId, name }));
      }
      return;
    }

    if (msg.type === "joined" || msg.type === "lobby_joined") {
      console.log(`joined ${playerId}`);
      return;
    }

    if (msg.type === "error") {
      console.log(`error ${playerId}: ${msg.message}`);
    }
  });

  ws.on("error", (error) => {
    console.log(`socket-error ${playerId}: ${error.message}`);
  });
}

console.log(
  `spawned ${count} clients on ${url}${joinCode ? ` using joinCode=${joinCode}` : " using legacy join"}; Ctrl+C to stop`,
);

process.on("SIGINT", () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  process.exit(0);
});

setInterval(() => {}, 1 << 30);
