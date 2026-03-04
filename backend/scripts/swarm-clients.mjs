import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = {
    count: null,
    url: null,
    joinCode: null,
    idPrefix: null,
    namePrefix: null,
    autoplay: null,
    decisionMs: null,
    logActions: null,
  };
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
    if ((token === "--joinCode" || token === "--join-code") && typeof argv[index + 1] === "string") {
      args.joinCode = argv[index + 1];
      index += 1;
      continue;
    }
    if ((token === "--idPrefix" || token === "--id-prefix") && typeof argv[index + 1] === "string") {
      args.idPrefix = argv[index + 1];
      index += 1;
      continue;
    }
    if ((token === "--namePrefix" || token === "--name-prefix") && typeof argv[index + 1] === "string") {
      args.namePrefix = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--decisionMs" || token === "--decision-ms") {
      if (typeof argv[index + 1] === "string") {
        args.decisionMs = argv[index + 1];
        index += 1;
      }
      continue;
    }
    if (token === "--autoplay" || token === "--auto") {
      const next = argv[index + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        args.autoplay = next;
        index += 1;
      } else {
        args.autoplay = "true";
      }
      continue;
    }
    if (token === "--logActions" || token === "--log-actions") {
      const next = argv[index + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        args.logActions = next;
        index += 1;
      } else {
        args.logActions = "true";
      }
    }
  }
  return args;
}

function parseBoolean(raw) {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function chooseAction(client, snapshot) {
  if (snapshot.started !== true || snapshot.ended === true || snapshot.phase !== "combat") {
    return null;
  }

  const tick = asFiniteNumber(snapshot.tick);
  if (tick === null) {
    return null;
  }
  if (client.lastDecisionTick === tick) {
    return null;
  }

  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const factions = Array.isArray(snapshot.factions) ? snapshot.factions : [];
  const self = players.find((candidate) => isRecord(candidate) && candidate.id === client.playerId);
  if (!self || self.isAlive !== true) {
    return { tick, action: null };
  }

  const selfFactionId = asFiniteNumber(self.factionId);
  if (selfFactionId === null) {
    return { tick, action: null };
  }

  const myFaction = factions.find(
    (candidate) => isRecord(candidate) && asFiniteNumber(candidate.id) === selfFactionId,
  );
  if (!myFaction) {
    return { tick, action: null };
  }

  const cooldownRemaining = Math.max(0, asFiniteNumber(self.cooldownRemaining) ?? 0);
  const isCommittedToBurst = self.isCommittedToBurst === true;
  const burstLocked = myFaction.burstLocked === true;
  const aliveCount = Math.max(1, asFiniteNumber(myFaction.aliveCount) ?? 1);
  const burstCommitCount = Math.max(0, asFiniteNumber(myFaction.burstCommitCount) ?? 0);

  if (isCommittedToBurst) {
    if (burstLocked) {
      return { tick, action: null };
    }
    const commitRatio = burstCommitCount / aliveCount;
    if (commitRatio > 0.85 && Math.random() < client.personality.cancelBias) {
      return { tick, action: "burst_cancel" };
    }
    return { tick, action: null };
  }

  if (cooldownRemaining > 0) {
    return { tick, action: null };
  }

  if (burstLocked) {
    if (Math.random() < client.personality.aggression) {
      return { tick, action: "manual_attack" };
    }
    return { tick, action: null };
  }

  const enemiesExposed = players.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    return candidate.factionId !== selfFactionId && candidate.isAlive === true && candidate.isExposed === true;
  });
  const requiredForLock = Math.ceil(aliveCount * 0.7);
  const oneCommitFromLock = burstCommitCount + 1 >= requiredForLock;

  if (oneCommitFromLock && Math.random() < 0.85) {
    return { tick, action: "burst_commit" };
  }
  if (enemiesExposed && Math.random() < 0.8) {
    return { tick, action: "manual_attack" };
  }
  if (Math.random() < client.personality.burstBias) {
    return { tick, action: "burst_commit" };
  }

  return { tick, action: "manual_attack" };
}

const cli = parseArgs(process.argv.slice(2));
const url = cli.url ?? process.env.BF_WS_URL ?? "ws://127.0.0.1:8080";
const countRaw = cli.count ?? process.env.BF_COUNT ?? "14";
const count = Number(countRaw);
const joinCode = (cli.joinCode ?? process.env.BF_JOIN_CODE ?? "").trim() || null;
const runId = (process.env.BF_RUN_ID ?? "").trim() || randomUUID().slice(0, 8);
const idPrefix = (cli.idPrefix ?? process.env.BF_ID_PREFIX ?? "swarm").trim() || "swarm";
const namePrefix = (cli.namePrefix ?? process.env.BF_NAME_PREFIX ?? "Swarm").trim() || "Swarm";
const autoplayRaw = cli.autoplay ?? process.env.BF_AUTOPLAY ?? "true";
const autoplay = parseBoolean(autoplayRaw);
const logActionsRaw = cli.logActions ?? process.env.BF_LOG_ACTIONS ?? "false";
const logActions = parseBoolean(logActionsRaw);
const decisionMsRaw = cli.decisionMs ?? process.env.BF_DECISION_MS ?? "1000";
const decisionMs = Number(decisionMsRaw);

if (!Number.isInteger(count) || count <= 0) {
  console.error(`Invalid --count value: ${countRaw}`);
  process.exit(1);
}
if (autoplay === null) {
  console.error(`Invalid --autoplay value: ${autoplayRaw}`);
  process.exit(1);
}
if (logActions === null) {
  console.error(`Invalid --logActions value: ${logActionsRaw}`);
  process.exit(1);
}
if (!Number.isInteger(decisionMs) || decisionMs <= 0) {
  console.error(`Invalid --decisionMs value: ${decisionMsRaw}`);
  process.exit(1);
}

const clients = [];
let joinedCount = 0;
let errorCount = 0;
let actionCount = 0;
let matchStartedJoinErrorCount = 0;
let printedLobbyStartedHint = false;
let lastAutoplayStatus = "";

function firstSnapshot() {
  for (const client of clients) {
    if (isRecord(client.snapshot)) {
      return client.snapshot;
    }
  }
  return null;
}

function describeAutoplayStatus() {
  if (joinedCount === 0) {
    return `autoplay: waiting for joins (0/${count} connected players).`;
  }

  const snapshot = firstSnapshot();
  if (!snapshot) {
    return "autoplay: waiting for first state snapshot.";
  }

  if (snapshot.started !== true) {
    const lobbyPlayerCount = Array.isArray(snapshot.players) ? snapshot.players.length : "unknown";
    return `autoplay: waiting for match start (lobby players=${lobbyPlayerCount}/14).`;
  }

  if (snapshot.ended === true) {
    return "autoplay: match ended; no further actions will be sent.";
  }

  if (snapshot.phase !== "combat") {
    const remaining = asFiniteNumber(snapshot.phaseRemaining);
    return `autoplay: waiting for combat phase (phase=${snapshot.phase}, remaining=${remaining ?? "?"}s).`;
  }

  return "autoplay: active (combat running, bots may attack each tick).";
}

for (let i = 1; i <= count; i += 1) {
  const playerId = `${idPrefix}-${runId}-${i}`;
  const name = `${namePrefix}${i}`;
  const ws = new WebSocket(url);
  const client = {
    playerId,
    name,
    ws,
    joined: false,
    factionId: null,
    snapshot: null,
    lastDecisionTick: -1,
    actionCount: 0,
    personality: {
      aggression: randomBetween(0.30, 0.95),
      burstBias: randomBetween(0.1, 0.25),
      cancelBias: randomBetween(0.03, 0.1),
    },
  };
  clients.push(client);

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
      if (!client.joined) {
        client.joined = true;
        joinedCount += 1;
        console.log(`joined ${playerId} (${joinedCount}/${count})`);
      }
      client.factionId = asFiniteNumber(msg.factionId);
      return;
    }

    if (msg.type === "state") {
      if (isRecord(msg.snapshot)) {
        client.snapshot = msg.snapshot;
      }
      return;
    }

    if (msg.type === "error") {
      errorCount += 1;
      console.log(`error ${playerId}: ${msg.message}`);
      if (typeof msg.message === "string" && msg.message.includes("Match already started")) {
        matchStartedJoinErrorCount += 1;
        if (!printedLobbyStartedHint && matchStartedJoinErrorCount >= count) {
          printedLobbyStartedHint = true;
          console.log(
            "hint: target lobby already started. Use a fresh lobby/joinCode or restart with a clean legacy lobby.",
          );
        }
      }
    }
  });

  ws.on("error", (error) => {
    console.log(`socket-error ${playerId}: ${error.message}`);
  });
}

let decisionTimer = null;
if (autoplay) {
  decisionTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.joined || client.ws.readyState !== WebSocket.OPEN || !isRecord(client.snapshot)) {
        continue;
      }

      const decision = chooseAction(client, client.snapshot);
      if (!decision) {
        continue;
      }

      client.lastDecisionTick = decision.tick;
      if (!decision.action) {
        continue;
      }

      client.ws.send(JSON.stringify({ type: decision.action }));
      client.actionCount += 1;
      actionCount += 1;
      if (logActions) {
        console.log(`action ${client.playerId} t${decision.tick}: ${decision.action}`);
      }
    }
  }, decisionMs);
}

let statusTimer = null;
if (autoplay) {
  statusTimer = setInterval(() => {
    const status = describeAutoplayStatus();
    if (status !== lastAutoplayStatus) {
      lastAutoplayStatus = status;
      console.log(status);
    }
  }, 1000);
} else {
  console.log("autoplay disabled: swarm will only connect and join.");
}

const keepAliveTimer = setInterval(() => {}, 1 << 30);
console.log(
  `spawned ${count} clients on ${url}${joinCode ? ` using joinCode=${joinCode}` : " using legacy join"} (runId=${runId}, autoplay=${autoplay ? "on" : "off"}${autoplay ? `, decisionMs=${decisionMs}` : ""}); Ctrl+C to stop`,
);

process.on("SIGINT", () => {
  if (decisionTimer) {
    clearInterval(decisionTimer);
    decisionTimer = null;
  }
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  clearInterval(keepAliveTimer);

  for (const { ws } of clients) {
    const socket = ws;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  console.log(`closing swarm: joined=${joinedCount}/${count}, actions=${actionCount}, errors=${errorCount}`);
  process.exit(0);
});
