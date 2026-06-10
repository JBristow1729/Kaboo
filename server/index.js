import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const TURN_SECONDS = 20;
const READY_SECONDS = 30;
const LOOK_MS = 4000;
const MOVE_MS = 3200;
const SNAP_MOVE_MS = 2200;
const MAX_PLAYERS = 8;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = [
  { id: "S", glyph: "&spades;", color: "black" },
  { id: "H", glyph: "&hearts;", color: "red" },
  { id: "D", glyph: "&diams;", color: "red" },
  { id: "C", glyph: "&clubs;", color: "black" }
];
const CPU_NAMES = ["Dot", "Finn", "Max", "Bea", "Kit", "Nia", "Sol", "Pip"];
const BLOCKED_WORDS = ["fuck", "shit", "cunt", "nigg", "fag", "slut", "whore", "bitch", "kike", "spic", "chink", "paki"];

const clients = new Map();
const rooms = new Map();

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Kaboo relay is running.");
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }, done) => {
    if (ALLOWED_ORIGIN === "*" || !origin || origin === ALLOWED_ORIGIN) return done(true);
    done(false, 403, "Origin not allowed");
  }
});

wss.on("connection", (ws) => {
  const client = { id: randomUUID(), ws, roomCode: null, playerId: null };
  clients.set(client.id, client);
  send(client, "hello", { clientId: client.id, publicLobbies: listPublicLobbies() });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return sendError(client, "Bad message.");
    }
    handleMessage(client, message);
  });

  ws.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.updatedAt > 60 * 60 * 1000) rooms.delete(room.code);
    if (room.game) tickGame(room, now);
  }
}, 500);

server.listen(PORT, () => {
  console.log(`Kaboo relay listening on ${PORT}`);
});

function handleMessage(client, message) {
  const type = message?.type;
  const payload = message?.payload || {};
  if (typeof payload.username === "string") client.pendingUsername = payload.username.slice(0, 10);
  if (type === "listLobbies") return send(client, "lobbies", { publicLobbies: listPublicLobbies() });
  if (type === "leaveRoom") {
    leaveRoom(client);
    broadcastPublicLobbies();
    return;
  }
  if (type === "createLobby") return createLobby(client, payload);
  if (type === "joinLobby") return joinLobby(client, payload.code);
  if (type === "setPublic") return mutateLobby(client, (room) => {
    if (room.hostClientId !== client.id) return sendError(client, "Only the host can change lobby visibility.");
    room.public = Boolean(payload.public);
  });
  if (type === "setReady") return mutateLobby(client, (room) => setPlayerReady(room, client.playerId, Boolean(payload.ready)));
  if (type === "addCpu") return mutateLobby(client, (room) => addCpu(room, client));
  if (type === "ejectCpu") return mutateLobby(client, (room) => ejectCpu(room, client, payload.playerId));
  if (type === "startGame") return mutateLobby(client, (room) => startGame(room, client));
  if (type === "gameIntent") return mutateGame(client, (room, game, playerIndex) => handleGameIntent(room, game, playerIndex, payload));
  if (type === "playAgain") return mutateLobby(client, (room) => {
    setPlayerReady(room, client.playerId, true);
    if (room.players.filter((p) => !p.left).every((p) => p.ready)) startGame(room, { id: room.hostClientId });
  });
}

function createLobby(client, payload) {
  if (!cleanName(payload.username)) return sendError(client, "Set a valid username before hosting.");
  leaveRoom(client);
  const code = uniqueCode();
  const player = makeHumanPlayer(payload.username, client.id);
  const room = {
    code,
    public: false,
    hostClientId: client.id,
    players: [player],
    game: null,
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  client.roomCode = code;
  client.playerId = player.id;
  broadcastLobby(room);
  broadcastPublicLobbies();
}

function joinLobby(client, code) {
  if (!cleanName(client.ws.username || "")) {
    const requestedName = client.pendingUsername;
    if (!cleanName(requestedName)) return sendError(client, "Set a valid username before joining.");
  }
  const room = rooms.get(String(code || "").padStart(4, "0"));
  if (!room || room.players.filter((p) => !p.left).length >= MAX_PLAYERS || room.game) {
    return sendError(client, "Lobby not found, full, or already in game.");
  }
  const name = cleanName(client.pendingUsername) ? client.pendingUsername : "Player";
  leaveRoom(client);
  const player = makeHumanPlayer(name, client.id);
  room.players.push(player);
  room.updatedAt = Date.now();
  client.roomCode = room.code;
  client.playerId = player.id;
  broadcastLobby(room);
  broadcastPublicLobbies();
}

function mutateLobby(client, fn) {
  const room = rooms.get(client.roomCode);
  if (!room) return sendError(client, "You are not in a lobby.");
  fn(room);
  room.updatedAt = Date.now();
  if (room.game) broadcastGame(room);
  else broadcastLobby(room);
  broadcastPublicLobbies();
}

function mutateGame(client, fn) {
  const room = rooms.get(client.roomCode);
  const game = room?.game;
  if (!room || !game) return sendError(client, "No active game.");
  const playerIndex = game.players.findIndex((p) => p.id === client.playerId);
  if (playerIndex < 0) return sendError(client, "You are not seated at this table.");
  fn(room, game, playerIndex);
  room.updatedAt = Date.now();
  broadcastGame(room);
}

function setPlayerReady(room, playerId, ready) {
  const player = room.players.find((p) => p.id === playerId);
  if (player) player.ready = ready;
}

function addCpu(room, client) {
  if (room.hostClientId !== client.id) return sendError(client, "Only the host can add CPUs.");
  if (room.players.length >= MAX_PLAYERS) return;
  const used = new Set(room.players.map((p) => p.name));
  const name = CPU_NAMES.find((candidate) => !used.has(candidate)) || `CPU ${room.players.filter((p) => p.ai).length + 1}`;
  room.players.push({ id: randomUUID(), name, ai: true, ready: true, wins: 0 });
}

function ejectCpu(room, client, playerId) {
  if (room.hostClientId !== client.id) return sendError(client, "Only the host can eject CPUs.");
  const index = room.players.findIndex((p) => p.id === playerId && p.ai);
  if (index >= 0) room.players.splice(index, 1);
}

function startGame(room, client) {
  if (room.hostClientId !== client.id) return sendError(client, "Only the host can start.");
  const players = room.players.filter((p) => !p.left);
  if (players.length < 2 || players.length > MAX_PLAYERS || !players.every((p) => p.ready)) return;
  const deck = shuffle(makeDeck());
  const gamePlayers = players.map((player) => ({
    id: player.id,
    clientId: player.clientId,
    name: player.name,
    ai: player.ai,
    wins: player.wins || 0,
    ready: player.ai,
    cards: [deck.pop(), deck.pop(), deck.pop(), deck.pop()],
    memory: new Set(),
    protected: false
  }));
  gamePlayers.forEach((player) => {
    [2, 3].forEach((index) => rememberCard(player, player.cards[index]));
  });
  room.game = {
    roomCode: room.code,
    players: gamePlayers,
    deck,
    discard: [],
    currentPlayer: Math.floor(Math.random() * gamePlayers.length),
    heldCard: null,
    source: null,
    heldBy: null,
    pendingAction: null,
    selection: [],
    animations: [],
    visible: new Map(),
    snappedCardIds: new Set(),
    snapLockedDiscardId: null,
    phase: "ready",
    readyPlayers: new Set(gamePlayers.map((p, index) => p.ai ? index : -1).filter((index) => index >= 0)),
    readyEndsAt: Date.now() + READY_SECONDS * 1000,
    turnEndsAt: Date.now() + TURN_SECONDS * 1000,
    kabooBy: null,
    finalTurns: null,
    message: "Memorize your bottom two cards.",
    log: ["Cards dealt. AI players are ready. Ready up when you have memorized your cards."],
    notice: null
  };
  broadcastGame(room);
}

function handleGameIntent(room, game, playerIndex, intent) {
  const player = game.players[playerIndex];
  if (intent.action === "readyGame") {
    if (game.phase !== "ready") return;
    game.readyPlayers.add(playerIndex);
    if (allReady(game)) beginTurns(game);
    return;
  }
  if (game.phase !== "playing") return;
  if (intent.action === "snap") return attemptSnap(game, playerIndex, Number(intent.ownerIndex), Number(intent.cardIndex));
  if (game.currentPlayer !== playerIndex) return;
  resetTurnTimer(game);
  if (intent.action === "drawDeck") return drawDeck(game, playerIndex);
  if (intent.action === "drawDiscard") return drawDiscard(game, playerIndex);
  if (intent.action === "playHeld") return playHeld(game, playerIndex);
  if (intent.action === "swapHeld") return swapHeld(game, playerIndex, Number(intent.cardIndex));
  if (intent.action === "cardAction") return handlePendingCard(room, game, playerIndex, Number(intent.targetPlayerIndex), Number(intent.cardIndex));
  if (intent.action === "cancelAction") return cancelAction(game, true);
  if (intent.action === "confirmKingSwap") return confirmKingSwap(game);
  if (intent.action === "giveSnapCard") return giveSnapCard(game, Number(intent.cardIndex));
  if (intent.action === "kaboo") return callKaboo(game, playerIndex);
}

function tickGame(room, now) {
  const game = room.game;
  clearExpiredVisibility(game, now);
  clearExpiredAnimations(game, now);
  if (game.phase === "ready" && now >= game.readyEndsAt) {
    game.players.forEach((_, index) => game.readyPlayers.add(index));
    beginTurns(game);
    broadcastGame(room);
    return;
  }
  if (game.phase !== "playing") return;
  if (game.actionHoldUntil && now < game.actionHoldUntil) return;
  const current = game.players[game.currentPlayer];
  if (current?.ai && !game.heldCard && !game.pendingAction && now + 16000 >= game.turnEndsAt) {
    aiTurn(game);
    broadcastGame(room);
    return;
  }
  if (now >= game.turnEndsAt) {
    timeoutTurn(game);
    broadcastGame(room);
  }
}

function beginTurns(game) {
  game.phase = "playing";
  game.message = "Draw from the deck or pick up the discard pile.";
  game.log.push("Everyone is ready. The first turn begins.");
  resetTurnTimer(game);
}

function drawDeck(game, playerIndex) {
  if (game.heldCard || !ensureDeck(game)) return;
  game.heldCard = game.deck.pop();
  game.heldBy = playerIndex;
  game.source = "deck";
  rememberCard(game.players[playerIndex], game.heldCard);
  game.message = "Swap with one of your cards, or play it to the discard pile.";
}

function drawDiscard(game, playerIndex) {
  if (game.heldCard || !game.discard.length) return;
  game.heldCard = game.discard.pop();
  game.heldBy = playerIndex;
  game.source = "discard";
  rememberCard(game.players[playerIndex], game.heldCard);
  game.message = "Swap the discard card with one of your cards.";
}

function swapHeld(game, playerIndex, cardIndex) {
  const player = game.players[playerIndex];
  const oldCard = player.cards[cardIndex];
  if (!game.heldCard || !oldCard || game.heldBy !== playerIndex) return;
  const incoming = game.heldCard;
  const source = game.source;
  pushAnimation(game, source === "discard" ? "discard" : "deck", { playerIndex, cardIndex }, incoming, {
    startFace: source === "discard" ? "up" : "up",
    endFace: "down",
    startVisibleTo: source === "discard" ? null : [player.id]
  });
  pushAnimation(game, { playerIndex, cardIndex }, "discard", oldCard, { startFace: "down", endFace: "up" });
  player.cards[cardIndex] = game.heldCard;
  rememberCard(player, incoming);
  game.discard.push(oldCard);
  rememberDiscard(game, oldCard);
  game.log.push(`${player.name} swapped a card.`);
  game.heldCard = null;
  game.heldBy = null;
  game.source = null;
  game.snapLockedDiscardId = null;
  scheduleEndTurn(game, MOVE_MS);
}

function playHeld(game, playerIndex) {
  if (!game.heldCard || game.source !== "deck" || game.heldBy !== playerIndex) return;
  const card = game.heldCard;
  pushAnimation(game, game.source === "discard" ? "discard" : "deck", "discard", card, {
    startFace: "up",
    endFace: "up",
    startVisibleTo: game.source === "deck" ? [game.players[playerIndex].id] : null
  });
  game.discard.push(card);
  rememberDiscard(game, card);
  game.log.push(`${game.players[playerIndex].name} played ${cardLabel(card)}.`);
  game.heldCard = null;
  game.heldBy = null;
  game.source = null;
  game.snapLockedDiscardId = null;
  setActionFor(game, card, MOVE_MS);
}

function setActionFor(game, card, delay = 0) {
  if (delay) {
    game.actionHoldUntil = Math.max(game.actionHoldUntil || 0, Date.now() + delay);
    setTimeout(() => {
      if (!rooms.get(game.roomCode)?.game || rooms.get(game.roomCode).game !== game) return;
      resetTurnTimer(game);
      broadcastGame(rooms.get(game.roomCode));
    }, delay);
  }
  if (["7", "8"].includes(card.rank)) {
    game.pendingAction = { type: "ownPeek" };
    game.message = "Peek at one of your own cards.";
  } else if (["9", "10"].includes(card.rank)) {
    if (!hasUnprotectedOpponent(game, game.currentPlayer)) return scheduleEndTurn(game, delay);
    game.pendingAction = { type: "opponentPeek" };
    game.message = "Peek at an opponent card.";
  } else if (["J", "Q"].includes(card.rank)) {
    if (!hasUnprotectedOpponent(game, game.currentPlayer)) return scheduleEndTurn(game, delay);
    game.pendingAction = { type: "blindSwap", picks: [] };
    game.message = "Blind swap any two cards.";
  } else if (card.rank === "K") {
    if (!hasUnprotectedOpponent(game, game.currentPlayer)) return scheduleEndTurn(game, delay);
    game.pendingAction = { type: "kingSwap", picks: [] };
    game.message = "Look at any two cards, then swap or leave.";
  } else {
    scheduleEndTurn(game, delay);
  }
  if (game.players[game.currentPlayer]?.ai) aiResolveAction(game);
}

function handlePendingCard(room, game, playerIndex, targetPlayerIndex, cardIndex) {
  const action = game.pendingAction;
  if (!action) return;
  if (action.type === "snapGive") {
    if (action.snappingPlayerIndex !== playerIndex || targetPlayerIndex !== playerIndex) return;
    return giveSnapCard(game, cardIndex);
  }
  if (game.currentPlayer !== playerIndex) return;
  const target = game.players[targetPlayerIndex];
  if (!target?.cards[cardIndex]) return;
  if (target.protected && targetPlayerIndex !== playerIndex) {
    game.message = "This player is protected.";
    return;
  }
  if (action.type === "ownPeek" && targetPlayerIndex === playerIndex) {
    return revealForAction(room, game, playerIndex, targetPlayerIndex, cardIndex, true);
  }
  if (action.type === "opponentPeek" && targetPlayerIndex !== playerIndex) {
    return revealForAction(room, game, playerIndex, targetPlayerIndex, cardIndex, true);
  }
  if (action.type === "blindSwap" || action.type === "kingSwap") {
    action.picks.push({ playerIndex: targetPlayerIndex, cardIndex });
    game.selection = action.picks;
    if (action.picks.length < 2) return;
    if (action.type === "blindSwap") {
      game.pendingAction = null;
      game.selection = [];
      swapTwo(game, action.picks[0], action.picks[1], true);
    } else {
      action.picks.forEach((pick) => revealForAction(room, game, playerIndex, pick.playerIndex, pick.cardIndex, false));
      game.pendingAction = { type: "kingChoice", picks: action.picks };
      game.message = "Swap those cards or leave them where they are.";
    }
  }
}

function confirmKingSwap(game) {
  const picks = game.pendingAction?.picks || [];
  clearVisiblePicks(game, picks);
  game.pendingAction = null;
  game.selection = [];
  if (picks.length === 2) swapTwo(game, picks[0], picks[1], true);
}

function cancelAction(game, advance = false) {
  if (game.pendingAction?.picks) clearVisiblePicks(game, game.pendingAction.picks);
  game.pendingAction = null;
  game.selection = [];
  if (advance) scheduleEndTurn(game, 0);
}

function attemptSnap(game, snappingPlayerIndex, ownerIndex, cardIndex) {
  const snapper = game.players[snappingPlayerIndex];
  const owner = game.players[ownerIndex];
  const target = owner?.cards[cardIndex];
  const top = last(game.discard);
  if (!snapper || !owner || owner.protected || !target || !top) return;
  if (game.snappedCardIds.has(target.id) || game.snapLockedDiscardId === top.id) return;
  game.snapLockedDiscardId = top.id;
  game.notice = { kind: "snap", playerIndex: snappingPlayerIndex, expiresAt: Date.now() + 1800 };
  if (target.rank === top.rank) {
    game.snappedCardIds.add(target.id);
    pushAnimation(game, { playerIndex: ownerIndex, cardIndex }, "discard", target, { startFace: "down", endFace: "up", duration: SNAP_MOVE_MS });
    owner.cards[cardIndex] = null;
    game.discard.push(target);
    rememberDiscard(game, target);
    game.log.push(`${snapper.name} snapped ${cardLabel(top)} correctly.`);
    if (ownerIndex !== snappingPlayerIndex) {
      game.pendingAction = { type: "snapGive", snappingPlayerIndex, ownerIndex, ownerCardIndex: cardIndex };
      game.message = `${snapper.name} must choose a card to give.`;
      if (snapper.ai) giveSnapCard(game, pickWorstKnownCard(snapper));
    }
  } else {
    pushAnimation(game, { playerIndex: ownerIndex, cardIndex }, "discard", target, { startFace: "down", endFace: "up", duration: SNAP_MOVE_MS });
    pushAnimation(game, "discard", { playerIndex: ownerIndex, cardIndex }, target, { startFace: "up", endFace: "down", duration: SNAP_MOVE_MS });
    if (ensureDeck(game)) {
      const penalty = game.deck.pop();
      const penaltyIndex = placeCardInHand(snapper, penalty);
      pushAnimation(game, "deck", { playerIndex: snappingPlayerIndex, cardIndex: penaltyIndex }, penalty, { startFace: "down", endFace: "down", duration: SNAP_MOVE_MS });
    }
    game.log.push(`${snapper.name} missed a snap and took a penalty card.`);
  }
}

function giveSnapCard(game, giveIndex) {
  const action = game.pendingAction;
  if (action?.type !== "snapGive") return;
  const snapper = game.players[action.snappingPlayerIndex];
  const owner = game.players[action.ownerIndex];
  if (!snapper.cards[giveIndex]) giveIndex = randomIndex(snapper.cards);
  if (giveIndex < 0) {
    game.pendingAction = null;
    game.selection = [];
    return;
  }
  pushAnimation(game, { playerIndex: action.snappingPlayerIndex, cardIndex: giveIndex }, { playerIndex: action.ownerIndex, cardIndex: action.ownerCardIndex }, snapper.cards[giveIndex], { startFace: "down", endFace: "down", duration: SNAP_MOVE_MS });
  owner.cards[action.ownerCardIndex] = snapper.cards[giveIndex];
  snapper.cards[giveIndex] = null;
  game.pendingAction = null;
  game.selection = [];
  game.log.push(`${snapper.name} gave a card to ${owner.name}.`);
  game.actionHoldUntil = Math.max(game.actionHoldUntil || 0, Date.now() + SNAP_MOVE_MS);
}

function swapTwo(game, a, b, advanceAfter = false) {
  const cardA = game.players[a.playerIndex]?.cards[a.cardIndex];
  const cardB = game.players[b.playerIndex]?.cards[b.cardIndex];
  if (!cardA || !cardB) return;
  pushAnimation(game, a, b, cardA, { startFace: "down", endFace: "down" });
  pushAnimation(game, b, a, cardB, { startFace: "down", endFace: "down" });
  game.players[a.playerIndex].cards[a.cardIndex] = cardB;
  game.players[b.playerIndex].cards[b.cardIndex] = cardA;
  game.log.push("Two table cards were swapped.");
  if (advanceAfter) scheduleEndTurn(game, MOVE_MS);
}

function callKaboo(game, playerIndex) {
  if (game.kabooBy !== null || game.heldCard || game.pendingAction) return;
  game.kabooBy = playerIndex;
  game.players[playerIndex].protected = true;
  game.finalTurns = new Set(game.players.map((_, i) => i).filter((i) => i !== playerIndex));
  game.notice = { kind: "kaboo", playerIndex, expiresAt: Date.now() + 2200 };
  game.log.push(`${game.players[playerIndex].name} called KABOO.`);
  setTimeout(() => {
    endTurn(game);
    const room = rooms.get(game.roomCode);
    if (room) broadcastGame(room);
  }, 1900);
}

function endTurn(game) {
  game.heldCard = null;
  game.heldBy = null;
  game.source = null;
  game.actionHoldUntil = 0;
  if (game.pendingAction?.type !== "snapGive") {
    game.pendingAction = null;
    game.selection = [];
  }
  if (game.finalTurns) {
    game.finalTurns.delete(game.currentPlayer);
    if (game.finalTurns.size === 0) return finishGame(game);
  }
  do {
    game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
  } while (game.players[game.currentPlayer].protected && game.finalTurns);
  game.message = "Draw from the deck or pick up the discard pile.";
  resetTurnTimer(game);
}

function scheduleEndTurn(game, delay = 0) {
  if (!delay) return endTurn(game);
  clearTimeout(game.endTurnTimer);
  game.actionHoldUntil = Math.max(game.actionHoldUntil || 0, Date.now() + delay);
  game.endTurnTimer = setTimeout(() => {
    const room = rooms.get(game.roomCode);
    if (!room || room.game !== game) return;
    endTurn(game);
    broadcastGame(room);
  }, delay);
}

function finishGame(game) {
  const scores = game.players.map((p, i) => ({ i, score: handScore(p.cards) })).sort((a, b) => a.score - b.score);
  const lowest = scores[0].score;
  const winners = scores.filter((item) => item.score === lowest);
  winners.forEach((winner) => {
    game.players[winner.i].wins = (game.players[winner.i].wins || 0) + 1;
  });
  game.winnerIndex = winners[0].i;
  game.phase = "revealing";
  game.message = "Revealing hands.";
  game.actionHoldUntil = Date.now() + 4000;
  game.players.forEach((player, playerIndex) => {
    player.cards.forEach((card, cardIndex) => {
      if (card) pushAnimation(game, { playerIndex, cardIndex }, { playerIndex, cardIndex }, card, { startFace: "down", endFace: "up", duration: 1800 });
    });
  });
  setTimeout(() => {
    const room = rooms.get(game.roomCode);
    if (!room || room.game !== game) return;
    game.phase = "complete";
    game.message = winners.length > 1 ? "The game is a draw." : `${game.players[winners[0].i].name} Wins!`;
    game.leaveAt = Date.now() + 30000;
    broadcastGame(room);
  }, 4000);
}

function timeoutTurn(game) {
  if (game.pendingAction?.type === "snapGive") return giveSnapCard(game, randomIndex(game.players[game.pendingAction.snappingPlayerIndex].cards));
  if (game.pendingAction) {
    game.log.push(`${game.players[game.currentPlayer].name}'s action timed out.`);
    return cancelAction(game, true);
  }
  const player = game.players[game.currentPlayer];
  if (player.ai) return aiTurn(game);
  if (ensureDeck(game)) placeCardInHand(player, game.deck.pop());
  game.log.push(`${player.name} timed out and took a penalty card.`);
  endTurn(game);
}

function aiTurn(game) {
  const playerIndex = game.currentPlayer;
  const player = game.players[playerIndex];
  if (!player?.ai || game.pendingAction || game.heldCard || game.phase !== "playing") return;
  if (shouldAiCallKaboo(game, playerIndex)) return callKaboo(game, playerIndex);
  if (shouldAiPickDiscard(game, playerIndex)) drawDiscard(game, playerIndex);
  else drawDeck(game, playerIndex);
  const cardIndex = pickWorstKnownCard(player);
  const heldValue = cardValue(game.heldCard);
  const worstValue = cardIndex >= 0 ? estimatedCardValue(player, player.cards[cardIndex]) : 6.5;
  if (game.source === "discard" || heldValue <= 4 || heldValue < worstValue - 1) swapHeld(game, playerIndex, cardIndex);
  else playHeld(game, playerIndex);
}

function aiResolveAction(game) {
  const action = game.pendingAction;
  const aiIndex = game.currentPlayer;
  const room = rooms.get(game.roomCode);
  if (!action) return;
  if (action.type === "ownPeek") {
    const index = leastCertainOwnCardIndex(game.players[aiIndex]);
    if (index >= 0 && room) return revealForAction(room, game, aiIndex, aiIndex, index, true);
    return cancelAction(game, true);
  }
  if (action.type === "opponentPeek") {
    const opponent = nextOpponentIndex(game, aiIndex);
    const cardIndex = opponent >= 0 ? randomIndex(game.players[opponent].cards) : -1;
    if (cardIndex >= 0 && room) return revealForAction(room, game, aiIndex, opponent, cardIndex, true);
    return cancelAction(game, true);
  }
  if (action.type === "blindSwap" || action.type === "kingSwap") {
    const own = pickWorstKnownCard(game.players[aiIndex]);
    const opponent = nextOpponentIndex(game, aiIndex);
    const their = opponent >= 0 ? randomIndex(game.players[opponent].cards) : -1;
    if (own >= 0 && their >= 0) swapTwo(game, { playerIndex: aiIndex, cardIndex: own }, { playerIndex: opponent, cardIndex: their }, true);
    else cancelAction(game, true);
  }
}

function broadcastLobby(room) {
  for (const client of clients.values()) {
    if (client.roomCode === room.code) send(client, "lobby", { lobby: lobbyView(room, client) });
  }
}

function broadcastGame(room) {
  for (const client of clients.values()) {
    if (client.roomCode === room.code) send(client, "game", { game: gameView(room.game, client) });
  }
}

function broadcastPublicLobbies() {
  const publicLobbies = listPublicLobbies();
  for (const client of clients.values()) send(client, "lobbies", { publicLobbies });
}

function lobbyView(room, client) {
  return {
    online: true,
    code: room.code,
    public: room.public,
    isHost: room.hostClientId === client.id,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      ai: p.ai,
      local: p.id === client.playerId,
      wins: p.wins || 0
    }))
  };
}

function gameView(game, client) {
  const localIndex = game.players.findIndex((p) => p.id === client.playerId);
  const visibleIds = new Set();
  const now = Date.now();
  for (const [cardId, visibility] of game.visible.entries()) {
    if (visibility.playerId === client.playerId && visibility.expiresAt > now) visibleIds.add(cardId);
  }
  return {
    online: true,
    players: game.players.map((p, playerIndex) => ({
      id: p.id,
      name: p.name,
      ai: p.ai,
      local: playerIndex === localIndex,
      wins: p.wins || 0,
      protected: p.protected,
      left: Boolean(p.left),
      ready: p.ready,
      memory: [],
      cards: p.cards.map((card, cardIndex) => sanitizeCard(card, canSeeCard(game, localIndex, playerIndex, cardIndex, visibleIds)))
    })),
    localPlayerIndex: localIndex,
    deck: Array.from({ length: game.deck.length }, (_, index) => ({ id: `deck-${index}` })),
    discard: game.discard.map((card) => sanitizeCard(card, true)),
    currentPlayer: game.currentPlayer,
    heldCard: game.heldBy === localIndex ? sanitizeCard(game.heldCard, true) : sanitizeCard(game.heldCard, false),
    source: game.source,
    selection: game.selection || [],
    pendingAction: game.pendingAction,
    visibleToHuman: [],
    animations: (game.animations || []).filter((animation) => animation.expiresAt > now).map((animation) => animationView(animation, client)),
    kabooShouts: game.notice?.kind === "kaboo" && game.notice.expiresAt > now ? [{ playerIndex: game.notice.playerIndex, expiresAt: game.notice.expiresAt }] : [],
    kabooNotice: game.notice?.kind === "kaboo" && game.notice.expiresAt > now ? { playerIndex: game.notice.playerIndex, expiresAt: game.notice.expiresAt } : null,
    snapNotice: game.notice?.kind === "snap" && game.notice.expiresAt > now ? { playerIndex: game.notice.playerIndex, expiresAt: game.notice.expiresAt } : null,
    hiddenSlots: hiddenSlotsFor(game),
    hiddenPiles: hiddenPilesFor(game),
    snapLockedDiscardId: game.snapLockedDiscardId,
    snappedCardIds: Array.from(game.snappedCardIds),
    phase: game.phase,
    readyPlayers: Array.from(game.readyPlayers),
    readyEndsAt: game.readyEndsAt,
    turnEndsAt: game.turnEndsAt,
    actionHoldUntil: game.actionHoldUntil || 0,
    kabooBy: game.kabooBy,
    kabooHold: false,
    finalTurns: game.finalTurns ? Array.from(game.finalTurns) : null,
    message: game.message,
    log: game.log.slice(-80),
    winnerIndex: game.winnerIndex,
    leaveAt: game.leaveAt
  };
}

function canSeeCard(game, localIndex, playerIndex, cardIndex, visibleIds) {
  const card = game.players[playerIndex].cards[cardIndex];
  if (!card) return false;
  if (game.phase === "complete") return true;
  if (game.phase === "ready" && playerIndex === localIndex && !game.readyPlayers.has(localIndex) && cardIndex >= 2) return true;
  return visibleIds.has(card.id);
}

function animationView(animation, client) {
  const startFace = visibleFaceFor(animation.startFace, animation.startVisibleTo, client.playerId);
  const endFace = visibleFaceFor(animation.endFace, animation.endVisibleTo, client.playerId);
  const expose = startFace === "up" || endFace === "up";
  return {
    id: animation.id,
    fromTarget: animation.from,
    toTarget: animation.to,
    startFace,
    endFace,
    red: expose && animation.card?.suit?.color === "red",
    rank: expose ? animation.card?.rank || "" : "",
    glyph: expose ? animation.card?.suit?.glyph || "" : "",
    duration: animation.duration,
    flipDelay: Math.max(200, Math.floor((animation.duration - 1500) / 2)),
    expiresAt: animation.expiresAt
  };
}

function visibleFaceFor(face, visibleTo, playerId) {
  if (face !== "up") return face;
  if (!visibleTo || visibleTo.includes(playerId)) return "up";
  return "down";
}

function hiddenSlotsFor(game) {
  const slots = new Set();
  (game.animations || []).forEach((animation) => {
    [animation.from, animation.to].forEach((target) => {
      if (target && typeof target === "object" && Number.isInteger(target.playerIndex) && Number.isInteger(target.cardIndex)) {
        slots.add(`${target.playerIndex}:${target.cardIndex}`);
      }
    });
  });
  return Array.from(slots);
}

function hiddenPilesFor(game) {
  const piles = new Set();
  (game.animations || []).forEach((animation) => {
    [animation.from, animation.to].forEach((target) => {
      if (target === "deck" || target === "discard") piles.add(target);
    });
  });
  return Array.from(piles);
}

function sanitizeCard(card, visible) {
  if (!card) return null;
  if (visible) return card;
  return { id: card.id, hidden: true };
}

function listPublicLobbies() {
  return Array.from(rooms.values())
    .filter((room) => room.public && !room.game && room.players.length < MAX_PLAYERS)
    .map((room) => ({ code: room.code, host: room.players[0]?.name || "Host", players: room.players.length }));
}

function send(client, type, payload = {}) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type, ...payload }));
}

function sendError(client, message) {
  send(client, "error", { message });
}

function leaveRoom(client) {
  const room = rooms.get(client.roomCode);
  if (!room) return;
  if (room.game) {
    leaveActiveGame(room, client);
    client.roomCode = null;
    client.playerId = null;
    return;
  }
  const player = room.players.find((p) => p.id === client.playerId);
  if (player) player.left = true;
  if (room.hostClientId === client.id) {
    const nextHost = room.players.find((p) => !p.left && !p.ai);
    room.hostClientId = nextHost?.clientId || room.hostClientId;
  }
  room.players = room.players.filter((p) => !p.left || p.ai);
  if (!room.players.some((p) => !p.ai)) rooms.delete(room.code);
  else broadcastLobby(room);
  client.roomCode = null;
  client.playerId = null;
}

function leaveActiveGame(room, client) {
  const game = room.game;
  const playerIndex = game.players.findIndex((p) => p.id === client.playerId);
  if (playerIndex < 0) return;
  const activePlayers = game.players.filter((p) => !p.left);
  const remaining = activePlayers.filter((p) => p.id !== client.playerId);
  if (remaining.length <= 1) {
    for (const other of clients.values()) {
      if (other.roomCode === room.code && other.id !== client.id) {
        send(other, "tableClosed", { message: "All other players have left the table." });
        other.roomCode = null;
        other.playerId = null;
      }
    }
    rooms.delete(room.code);
    return;
  }
  const player = game.players[playerIndex];
  player.left = true;
  player.protected = true;
  player.cards.forEach((card, cardIndex) => {
    if (!card) return;
    pushAnimation(game, { playerIndex, cardIndex }, "discard", card, { startFace: "down", endFace: "up", duration: SNAP_MOVE_MS });
    game.discard.push(card);
    player.cards[cardIndex] = null;
    rememberDiscard(game, card);
  });
  game.log.push(`${player.name} left the table. Their cards went to the discard pile.`);
  if (game.finalTurns) game.finalTurns.delete(playerIndex);
  if (game.currentPlayer === playerIndex) endTurn(game);
  broadcastGame(room);
}

function uniqueCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function makeHumanPlayer(username, clientId) {
  return { id: randomUUID(), clientId, name: username.slice(0, 10), ai: false, ready: false, wins: 0 };
}

function cleanName(name) {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
  if (!normalized.trim()) return false;
  return !BLOCKED_WORDS.some((word) => normalized.includes(word) || levenshtein(normalized, word) <= 1);
}

function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit, id: `${rank}${suit.id}-${randomUUID()}` })));
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function ensureDeck(game) {
  if (game.deck.length) return true;
  if (!game.discard.length) return false;
  game.deck = shuffle(game.discard.splice(0));
  game.log.push("The discard pile was shuffled into a fresh deck.");
  return true;
}

function placeCardInHand(player, card) {
  const index = player.cards.findIndex((item) => !item);
  const targetIndex = index >= 0 ? index : player.cards.length;
  player.cards[targetIndex] = card;
  return targetIndex;
}

function revealTo(game, playerIndex, card, duration) {
  if (!card) return;
  rememberCard(game.players[playerIndex], card);
  game.visible.set(card.id, { playerId: game.players[playerIndex].id, expiresAt: Date.now() + duration });
}

function revealForAction(room, game, viewingPlayerIndex, targetPlayerIndex, cardIndex, advanceAfter) {
  const card = game.players[targetPlayerIndex]?.cards[cardIndex];
  if (!card) return;
  const viewerId = game.players[viewingPlayerIndex].id;
  revealTo(game, viewingPlayerIndex, card, LOOK_MS);
  pushAnimation(game, { playerIndex: targetPlayerIndex, cardIndex }, { playerIndex: targetPlayerIndex, cardIndex }, card, {
    startFace: "down",
    endFace: "up",
    startVisibleTo: [],
    endVisibleTo: [viewerId],
    duration: LOOK_MS
  });
  setTimeout(() => {
    if (room.game !== game) return;
    pushAnimation(game, { playerIndex: targetPlayerIndex, cardIndex }, { playerIndex: targetPlayerIndex, cardIndex }, card, {
      startFace: "up",
      endFace: "down",
      startVisibleTo: [viewerId],
      endVisibleTo: [],
      duration: 1500
    });
    clearVisiblePicks(game, [{ playerIndex: targetPlayerIndex, cardIndex }]);
    if (advanceAfter && game.pendingAction) {
      game.pendingAction = null;
      game.selection = [];
      setTimeout(() => {
        if (room.game !== game) return;
        endTurn(game);
        broadcastGame(room);
      }, 1500);
    }
    broadcastGame(room);
  }, LOOK_MS);
  game.actionHoldUntil = Math.max(game.actionHoldUntil || 0, Date.now() + LOOK_MS + (advanceAfter ? 1500 : 0));
  if (advanceAfter) {
    game.pendingAction = null;
    game.selection = [];
  }
}

function pushAnimation(game, from, to, card, options = {}) {
  game.animations ||= [];
  const duration = options.duration || MOVE_MS;
  game.animations.push({
    id: randomUUID(),
    from,
    to,
    card,
    startFace: options.startFace || "down",
    endFace: options.endFace || options.startFace || "down",
    startVisibleTo: normalizeVisibleTo(options.startVisibleTo),
    endVisibleTo: normalizeVisibleTo(options.endVisibleTo),
    duration,
    expiresAt: Date.now() + duration
  });
}

function normalizeVisibleTo(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  return Array.isArray(value) ? value : [value];
}

function clearExpiredAnimations(game, now) {
  game.animations = (game.animations || []).filter((animation) => animation.expiresAt > now);
}

function clearVisiblePicks(game, picks) {
  picks.forEach((pick) => {
    const card = game.players[pick.playerIndex]?.cards[pick.cardIndex];
    if (card) game.visible.delete(card.id);
  });
}

function clearExpiredVisibility(game, now) {
  for (const [cardId, visibility] of game.visible.entries()) {
    if (visibility.expiresAt <= now) game.visible.delete(cardId);
  }
}

function rememberCard(player, card) {
  if (player?.memory && card) player.memory.add(card.id);
}

function rememberDiscard(game, card) {
  game.players.forEach((player) => rememberCard(player, card));
}

function hasUnprotectedOpponent(game, playerIndex) {
  return game.players.some((player, index) => index !== playerIndex && !player.protected);
}

function allReady(game) {
  return game.players.every((_, index) => game.readyPlayers.has(index));
}

function resetTurnTimer(game) {
  game.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
}

function handScore(cards) {
  return cards.reduce((sum, card) => sum + (card ? cardValue(card) : 0), 0);
}

function cardValue(card) {
  if (card.rank === "6" && card.suit.color === "red") return -1;
  if (card.rank === "K" && card.suit.color === "red") return 0;
  if (card.rank === "A") return 1;
  if (card.rank === "J") return 11;
  if (card.rank === "Q") return 12;
  if (card.rank === "K") return 13;
  return Number(card.rank);
}

function cardLabel(card) {
  return `${card.rank}${({ S: "S", H: "H", D: "D", C: "C" })[card.suit.id] || ""}`;
}

function last(array) {
  return array[array.length - 1];
}

function randomIndex(array) {
  const filled = array.map((card, index) => card ? index : -1).filter((index) => index >= 0);
  return filled.length ? filled[Math.floor(Math.random() * filled.length)] : -1;
}

function pickWorstKnownCard(player) {
  let worst = -1;
  let worstValue = -Infinity;
  player.cards.forEach((card, index) => {
    if (!card) return;
    const value = estimatedCardValue(player, card);
    if (value > worstValue) {
      worst = index;
      worstValue = value;
    }
  });
  return worst;
}

function estimatedCardValue(player, card) {
  if (!card) return 0;
  return player.memory.has(card.id) ? cardValue(card) : 6.5;
}

function leastCertainOwnCardIndex(player) {
  const unknown = player.cards.findIndex((card) => card && !player.memory.has(card.id));
  return unknown >= 0 ? unknown : pickWorstKnownCard(player);
}

function nextOpponentIndex(game, playerIndex) {
  return game.players.findIndex((p, index) => index !== playerIndex && !p.protected);
}

function shouldAiPickDiscard(game, playerIndex) {
  const top = last(game.discard);
  if (!top) return false;
  const player = game.players[playerIndex];
  const worstIndex = pickWorstKnownCard(player);
  const worstValue = worstIndex >= 0 ? estimatedCardValue(player, player.cards[worstIndex]) : 6.5;
  const value = cardValue(top);
  return value <= 5 && value < worstValue - 0.5;
}

function shouldAiCallKaboo(game, playerIndex) {
  if (game.kabooBy !== null || game.heldCard || game.finalTurns) return false;
  const player = game.players[playerIndex];
  const score = player.cards.reduce((sum, card) => sum + estimatedCardValue(player, card), 0);
  const known = player.cards.filter((card) => card && player.memory.has(card.id)).length;
  const threshold = game.players.length <= 2 ? 7 : game.players.length <= 4 ? 6 : 5;
  return known / Math.max(1, player.cards.filter(Boolean).length) >= 0.5 && score <= threshold;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
