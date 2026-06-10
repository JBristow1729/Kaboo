import React, { memo, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const h = React.createElement;

const STORAGE_KEY = "kaboo-settings-v1";
const TURN_SECONDS = 20;
const READY_SECONDS = 30;
const RELAY_CONNECT_TIMEOUT_MS = 60000;
const RELAY_RETRY_MS = 4500;
const MOVE_MS = 3200;
const ANIMATION_CUTOFF_MS = 1000;
const SNAP_ANIMATION_CUTOFF_MS = 800;
const COMMIT_AFTER_MOVE_MS = MOVE_MS - ANIMATION_CUTOFF_MS;
const SNAP_MOVE_MS = 2200;
const SNAP_COMMIT_AFTER_MOVE_MS = SNAP_MOVE_MS - SNAP_ANIMATION_CUTOFF_MS;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = [
  { id: "S", glyph: "&spades;", color: "black" },
  { id: "H", glyph: "&hearts;", color: "red" },
  { id: "D", glyph: "&diams;", color: "red" },
  { id: "C", glyph: "&clubs;", color: "black" }
];
const BLOCKED_WORDS = [
  "fuck", "shit", "cunt", "nigg", "fag", "slut", "whore", "bitch", "kike", "spic", "chink", "paki"
];
const DEV_PUBLIC_LOBBIES = [
  { code: "1847", host: "Marnie", players: 3 },
  { code: "6204", host: "Tess", players: 5 },
  { code: "9318", host: "Rook", players: 2 }
];
const PUBLIC_LOBBIES = import.meta.env.DEV ? DEV_PUBLIC_LOBBIES : [];
const RELAY_URL = import.meta.env.VITE_KABOO_RELAY_URL || "";

const state = {
  screen: "title",
  previous: [],
  settings: loadSettings(),
  modal: null,
  toast: "",
  lobby: null,
  publicLobbies: PUBLIC_LOBBIES,
  joinCode: ["", "", "", ""],
  game: null,
  relay: {
    ws: null,
    status: RELAY_URL ? "idle" : "unconfigured",
    clientId: null,
    pending: [],
    attemptStartedAt: 0,
    retryTimer: null,
    timeoutTimer: null,
    lastError: ""
  },
  now: Date.now()
};

let tickHandle = null;
let snapTimer = null;
let aiTimer = null;
let lastWarningSecond = null;
let pointerActive = false;
let pendingRender = false;
let renderVersion = 0;
let root = null;

function loadSettings() {
  const fallback = { username: "", sfx: 68, music: 0 };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function connectRelay() {
  if (!RELAY_URL) {
    state.relay.status = "unconfigured";
    state.relay.lastError = "VITE_KABOO_RELAY_URL is not configured.";
    return false;
  }
  if (state.relay.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.relay.ws.readyState)) return true;
  if (!state.relay.attemptStartedAt || ["idle", "offline", "failed", "unconfigured"].includes(state.relay.status)) {
    state.relay.attemptStartedAt = Date.now();
    clearTimeout(state.relay.timeoutTimer);
    state.relay.timeoutTimer = setTimeout(() => {
      if (state.relay.status === "connected") return;
      state.relay.status = "failed";
      state.relay.lastError = `Could not connect within ${Math.round(RELAY_CONNECT_TIMEOUT_MS / 1000)} seconds. Check the relay URL and Render origin settings.`;
      clearTimeout(state.relay.retryTimer);
      state.relay.retryTimer = null;
      render();
    }, RELAY_CONNECT_TIMEOUT_MS);
  }
  state.relay.status = "connecting";
  const ws = new WebSocket(RELAY_URL);
  state.relay.ws = ws;
  ws.addEventListener("open", () => {
    state.relay.status = "connected";
    state.relay.lastError = "";
    clearTimeout(state.relay.retryTimer);
    clearTimeout(state.relay.timeoutTimer);
    state.relay.retryTimer = null;
    state.relay.timeoutTimer = null;
    const pending = state.relay.pending.splice(0);
    pending.forEach((item) => ws.send(JSON.stringify(item)));
    sendRelay("listLobbies");
    render();
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleRelayMessage(message);
  });
  ws.addEventListener("close", () => {
    if (state.relay.ws === ws) {
      state.relay.ws = null;
      if (Date.now() - state.relay.attemptStartedAt < RELAY_CONNECT_TIMEOUT_MS) {
        state.relay.status = "waking";
        scheduleRelayRetry();
      } else {
        state.relay.status = "failed";
        state.relay.lastError = "The relay did not accept a WebSocket connection in time.";
      }
      render();
    }
  });
  ws.addEventListener("error", () => {
    state.relay.lastError = "Relay connection failed. Render may still be waking up.";
    render();
  });
  return true;
}

function scheduleRelayRetry() {
  if (state.relay.retryTimer || state.relay.status === "connected") return;
  state.relay.retryTimer = setTimeout(() => {
    state.relay.retryTimer = null;
    if (state.relay.status !== "connected" && Date.now() - state.relay.attemptStartedAt < RELAY_CONNECT_TIMEOUT_MS) {
      connectRelay();
      render();
    }
  }, RELAY_RETRY_MS);
}

function sendRelay(type, payload = {}) {
  if (!connectRelay()) return false;
  const ws = state.relay.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    state.relay.pending.push({ type, payload });
    if (state.relay.status === "connecting" || state.relay.status === "waking") {
      state.modal = { type: "relay" };
    }
    return true;
  }
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

function sendGameIntent(action, payload = {}) {
  return sendRelay("gameIntent", { action, ...payload });
}

function handleRelayMessage(message) {
  if (message.type === "hello") {
    state.relay.clientId = message.clientId;
    state.publicLobbies = message.publicLobbies || [];
  }
  if (message.type === "lobbies") {
    state.publicLobbies = message.publicLobbies || [];
  }
  if (message.type === "lobby") {
    state.lobby = message.lobby;
    state.screen = "lobby";
    if (state.modal?.type === "relay") state.modal = null;
  }
  if (message.type === "game") {
    const previousKaboo = state.game?.kabooNotice?.expiresAt || 0;
    const previousSnap = state.game?.snapNotice?.expiresAt || 0;
    state.game = hydrateOnlineGame(message.game);
    if (state.game.kabooNotice && state.game.kabooNotice.expiresAt !== previousKaboo) bloop("streamer");
    if (state.game.snapNotice && state.game.snapNotice.expiresAt !== previousSnap) bloop("bloop");
    state.screen = "game";
    if (state.modal?.type === "relay") state.modal = null;
    if (state.game.phase === "complete" && state.game.leaveAt && state.modal?.type !== "end") state.modal = { type: "end" };
    startTicker();
  }
  if (message.type === "error") {
    state.modal = { type: "alert", title: "Multiplayer", message: message.message || "Something went wrong." };
  }
  if (message.type === "tableClosed") {
    state.game = null;
    state.lobby = null;
    state.screen = "title";
    state.previous = [];
    state.modal = { type: "alert", title: "Table Closed", message: message.message || "All players have left the table." };
  }
  render();
}

function hydrateOnlineGame(game) {
  if (!game) return null;
  const hydrated = {
    ...game,
    visibleToHuman: new Map((game.visibleToHuman || []).map((cardId) => [cardId, Date.now() + 3600000])),
    readyPlayers: new Set(game.readyPlayers || []),
    hiddenSlots: new Set(game.hiddenSlots || []),
    hiddenPiles: new Set(game.hiddenPiles || []),
    snappedCardIds: new Set(game.snappedCardIds || []),
    finalTurns: game.finalTurns ? new Set(game.finalTurns) : null,
    players: (game.players || []).map((player) => ({ ...player, memory: new Set(player.memory || []) })),
    animations: [],
    selection: game.selection || []
  };
  hydrated.animations = (game.animations || []).map((animation) => hydrateAnimation(animation, hydrated));
  return hydrated;
}

function hydrateAnimation(animation, game) {
  if (animation.from && animation.to && animation.mid) return animation;
  const from = positionForTarget(animation.fromTarget || animation.from || "deck", game);
  const to = positionForTarget(animation.toTarget || animation.to || "discard", game);
  const localExpiresAt = Date.now() + Math.max(0, animation.remainingMs ?? animation.duration ?? MOVE_MS);
  return {
    ...animation,
    expiresAt: localExpiresAt,
    from,
    to,
    mid: {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2
    }
  };
}

function refreshOnlineAnimationHides(game) {
  const slots = new Set();
  const piles = new Set();
  (game.animations || []).forEach((animation) => {
    if (animation.hideStatic === false) return;
    [animation.fromTarget, animation.toTarget].forEach((target) => {
      if (target === "deck" || target === "discard") piles.add(target);
      if (target && typeof target === "object" && Number.isInteger(target.playerIndex) && Number.isInteger(target.cardIndex)) {
        slots.add(`${target.playerIndex}:${target.cardIndex}`);
      }
    });
  });
  game.hiddenSlots = slots;
  game.hiddenPiles = piles;
}

function isOnlineLobby() {
  return Boolean(state.lobby?.online);
}

function isOnlineGame(game = state.game) {
  return Boolean(game?.online);
}

function resetRelayAttempt(clearPending = false) {
  clearTimeout(state.relay.retryTimer);
  clearTimeout(state.relay.timeoutTimer);
  state.relay.retryTimer = null;
  state.relay.timeoutTimer = null;
  state.relay.attemptStartedAt = 0;
  state.relay.lastError = "";
  if (clearPending) state.relay.pending = [];
  if (state.relay.ws) {
    const ws = state.relay.ws;
    state.relay.ws = null;
    try {
      ws.close();
    } catch {
      // No-op: closing a half-open socket can throw in old browsers.
    }
  }
}

function retryRelayConnection() {
  resetRelayAttempt(false);
  state.relay.status = RELAY_URL ? "idle" : "unconfigured";
  state.modal = { type: "relay" };
  connectRelay();
}

function cancelRelayConnection() {
  resetRelayAttempt(true);
  state.relay.status = RELAY_URL ? "idle" : "unconfigured";
  state.modal = null;
}

function quitGame() {
  if (isOnlineGame()) sendRelay("leaveRoom");
  state.modal = null;
  state.game = null;
  state.lobby = null;
  cancelQueuedAiActions();
  go("title", true);
}

function render(options = {}) {
  if (pointerActive && !options.force) {
    pendingRender = true;
    return;
  }
  root ||= createRoot(document.querySelector("#app"));
  renderVersion += 1;
  root.render(h(App, { version: renderVersion }));
}

function App() {
  return h("main", { className: "app", onClick: handleRootClick, onInput: handleRootInput },
    state.toast ? h("div", { className: "toast" }, state.toast) : null,
    h(RulesButton),
    h(GameQuitButton),
    renderScreen(),
    renderModal()
  );
}

function handleRootClick(event) {
  if (event.target.classList?.contains("modal-backdrop")) {
    dismissModalByBackdrop();
    render();
    return;
  }
  const actionTarget = event.target.closest?.("[data-action]");
  if (actionTarget && !actionTarget.disabled) {
    handleAction(actionTarget.dataset.action, actionTarget);
    return;
  }
  const cardTarget = event.target.closest?.("[data-card-action]");
  if (!cardTarget || cardTarget.disabled) return;
  const action = cardTarget.dataset.cardAction;
  if (action === "discard" && state.game?.discard.length && canHumanAct() && !state.game.heldCard) {
    drawDiscard();
    render();
    return;
  }
  handleCardAction(action);
}

function dismissModalByBackdrop() {
  if (!state.modal) return;
  if (state.modal.type === "relay") {
    cancelRelayConnection();
    return;
  }
  if (state.modal.type === "confirmQuit") {
    state.modal = null;
    return;
  }
  if (state.modal.type === "end") {
    state.modal = null;
    return;
  }
  state.modal = null;
}

function handleRootInput(event) {
  const input = event.target;
  if (input.dataset.codeIndex !== undefined) {
    const index = Number(input.dataset.codeIndex);
    state.joinCode[index] = input.value.replace(/\D/g, "").slice(-1);
    render();
    setTimeout(() => {
      const next = document.querySelector(`[data-code-index="${Math.min(3, index + 1)}"]`);
      if (state.joinCode[index] && next) next.focus();
    }, 0);
    return;
  }
  if (input.id === "username") {
    state.settings.username = input.value.slice(0, 10);
    saveSettings();
    render();
    return;
  }
  if (input.id === "sfx") {
    state.settings.sfx = Number(input.value);
    saveSettings();
    render();
  }
}

function renderScreen() {
  if (state.screen === "title") return h(MenuScreen, { title: "Kaboo", primary: "Singleplayer", secondary: "Multiplayer", primaryAction: "single", secondaryAction: "multi" });
  if (state.screen === "multiplayer") return h(MenuScreen, { title: "Kaboo", primary: "Host Game", secondary: "Join Game", primaryAction: "host", secondaryAction: "join" });
  if (state.screen === "lobby") return h(LobbyScreen);
  if (state.screen === "join") return h(JoinLobbyScreen);
  if (state.screen === "game") return h(GameScreen);
  return null;
}

function renderMenu(title, primary, secondary, primaryAction, secondaryAction) {
  return `
    <section class="screen menu-screen">
      <div class="brand">
        <h1>${title}</h1>
      </div>
      <div class="menu-actions">
        <button data-action="${primaryAction}">${primary}</button>
        <button data-action="${secondaryAction}">${secondary}</button>
      </div>
      ${state.screen !== "title" ? `<button class="bottom-left ghost" data-action="back">Back</button>` : ""}
      <button class="icon-button bottom-right" title="Options" data-action="options" aria-label="Options">⚙</button>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) return null;
  if (state.modal.type === "options") return h(OptionsDialog);
  if (state.modal.type === "ai") return h(AiDialog);
  if (state.modal.type === "rules") return h(RulesDialog);
  if (state.modal.type === "relay") return h(RelayDialog);
  if (state.modal.type === "confirmQuit") return h(ConfirmQuitDialog);
  if (state.modal.type === "alert") return h(AlertDialog, { title: state.modal.title, message: state.modal.message });
  if (state.modal.type === "end") return h(EndDialog);
  return null;
}

function RulesButton() {
  return h("button", { className: `rules-button ${state.screen === "game" ? "in-game" : ""}`, "data-action": "rules" }, "Rules");
}

function GameQuitButton() {
  if (state.screen !== "game") return null;
  return h("button", { className: "bottom-left quit-button danger", "data-action": "confirm-quit" }, "Quit");
}

function MenuScreen({ title, primary, secondary, primaryAction, secondaryAction }) {
  return h("section", { className: "screen menu-screen" },
    h("div", { className: "brand" }, h("h1", null, title)),
    h("div", { className: "menu-actions" },
      h("button", { "data-action": primaryAction }, primary),
      h("button", { "data-action": secondaryAction }, secondary)
    ),
    state.screen !== "title" ? h("button", { className: "bottom-left ghost", "data-action": "back" }, "Back") : null,
    h("button", { className: "icon-button bottom-right", title: "Options", "data-action": "options", "aria-label": "Options" }, "⚙")
  );
}

function OptionsDialog() {
  const username = state.settings.username;
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog" },
      h("h2", null, "Options"),
      h("div", { className: "field" },
        h("label", { htmlFor: "username" }, "Username"),
        h("input", { id: "username", name: "username", maxLength: 10, value: username, autoComplete: "off", onChange: () => {} }),
        username && !isCleanUsername(username) ? h("p", { className: "danger-text" }, "Please choose a friendlier table name.") : null
      ),
      h("div", { className: "field" },
        h("label", { htmlFor: "sfx" }, "SFX"),
        h("div", { className: "slider-row" },
          h("input", { id: "sfx", name: "sfx", type: "range", min: 0, max: 100, value: state.settings.sfx, onChange: () => {} }),
          h("output", null, state.settings.sfx)
        )
      ),
      h("div", { className: "field" },
        h("label", { htmlFor: "music" }, "Music"),
        h("div", { className: "slider-row muted" },
          h("input", { id: "music", name: "music", type: "range", min: 0, max: 100, value: state.settings.music, disabled: true, onChange: () => {} }),
          h("output", null, state.settings.music)
        )
      ),
      h("div", { className: "dialog-actions" },
        h("button", { className: "ghost", "data-action": "close-modal" }, "Close"),
        h("button", { "data-action": "save-options" }, "Save")
      )
    )
  );
}

function AiDialog() {
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog" },
      h("h2", null, "Singleplayer"),
      h("div", { className: "field" },
        h("label", { htmlFor: "ai-count" }, "AI opponents"),
        h("select", { id: "ai-count", name: "ai-count", defaultValue: "1" },
          Array.from({ length: 7 }, (_, i) => h("option", { key: i + 1, value: i + 1 }, i + 1))
        )
      ),
      h("div", { className: "dialog-actions" },
        h("button", { className: "ghost", "data-action": "close-modal" }, "Cancel"),
        h("button", { "data-action": "start-singleplayer" }, "Start Game")
      )
    )
  );
}

function RulesDialog() {
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog rules-dialog" },
      h("h2", null, "Rules"),
      h("div", { className: "rules-copy" },
        h("p", null, "Start with four face-down cards. Memorize your two bottom cards, then keep your total as low as possible."),
        h("p", null, "On your turn, take the top deck card or discard card. Swap it with one of your cards, or discard a deck draw to use its action."),
        h("p", null, "Snap a table card matching the discard pile. A correct snap removes your own card, or lets you give one of your cards to that opponent. A miss gives you a penalty card."),
        h("p", null, "Call Kaboo on your turn to protect your hand. Everyone else gets one final turn; lowest score wins.")
      ),
      h("div", { className: "rules-actions-list" },
        h(RuleActionRow, { cards: ["7", "8"], text: "Look at one of your own cards" }),
        h(RuleActionRow, { cards: ["9", "10"], text: "Look at one opponent card" }),
        h(RuleActionRow, { cards: ["J", "Q"], text: "Blind swap any two unprotected cards" }),
        h(RuleActionRow, { cards: ["K"], text: "Look at two unprotected cards, then swap or leave them" })
      ),
      h("p", { className: "rules-values" }, "Cards score face value. Aces are 1. J, Q, K are 11, 12, 13, except red 6 is -1 and red K is 0."),
      h("div", { className: "dialog-actions" }, h("button", { "data-action": "close-modal" }, "Ok"))
    )
  );
}

function RuleActionRow({ cards, text }) {
  return h("div", { className: "rule-action-row" },
    h("div", { className: "rule-card-set" }, cards.map((rank) => h(CardView, { key: rank, card: makeRuleCard(rank), visible: true, extra: "small rule-card" }))),
    h("span", { className: "rule-arrow" }, "=>"),
    h("span", null, text)
  );
}

function makeRuleCard(rank) {
  const suit = rank === "K" ? SUITS[1] : SUITS[0];
  return { rank, suit, id: `rules-${rank}-${suit.id}` };
}

function AlertDialog({ title, message }) {
  const action = state.modal?.next === "options" ? "open-options" : "close-modal";
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog" },
      h("h2", null, title),
      h("p", null, message),
      h("div", { className: "dialog-actions" }, h("button", { "data-action": action }, "OK"))
    )
  );
}

function RelayDialog() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const elapsed = state.relay.attemptStartedAt ? now - state.relay.attemptStartedAt : 0;
  const remaining = Math.max(0, Math.ceil((RELAY_CONNECT_TIMEOUT_MS - elapsed) / 1000));
  const failed = state.relay.status === "failed";
  const title = failed ? "Relay Not Connected" : "Waking Multiplayer Relay";
  const message = failed
    ? state.relay.lastError || "The multiplayer relay could not be reached."
    : `Trying to connect for up to ${remaining}s. Free Render services can take a short while to wake after sleeping.`;
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog relay-dialog" },
      h("h2", null, title),
      h("p", null, message),
      h("div", { className: "relay-status" },
        h("span", null, "Relay URL"),
        h("code", null, RELAY_URL || "Not configured")
      ),
      h("p", { className: "hint-text" }, "Expected Render WebSocket format: wss://your-render-service.onrender.com/ws"),
      h("div", { className: "dialog-actions" },
        failed ? h("button", { className: "ghost", "data-action": "close-modal" }, "Close") : h("button", { className: "ghost", "data-action": "cancel-relay-connect" }, "Cancel"),
        h("button", { "data-action": "retry-relay" }, failed ? "Try Again" : "Retry Now")
      )
    )
  );
}

function ConfirmQuitDialog() {
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog" },
      h("h2", null, "Quit Game?"),
      h("p", null, "You will leave this table and return to the main menu."),
      h("div", { className: "dialog-actions" },
        h("button", { className: "ghost", "data-action": "close-modal" }, "No"),
        h("button", { className: "danger", "data-action": "quit-game" }, "Yes, Quit")
      )
    )
  );
}

function LobbyScreen() {
  const lobby = state.lobby || createLobby();
  const allReady = lobby.players.length > 1 && lobby.players.every((p) => p.ready);
  const localPlayer = lobby.players.find((p) => p.local);
  const isHost = !lobby.online || lobby.isHost;
  return h("section", { className: "screen panel-screen" },
    h("div", { className: "panel" },
      h("div", { className: "panel-header" },
        h("div", null,
          h("span", { className: "small-label" }, "Private Code"),
          h("div", { className: "code" }, lobby.code)
        ),
        h("label", { className: "checkbox-row" },
          h("input", { type: "checkbox", "data-action": "toggle-public", checked: lobby.public, disabled: !isHost, onChange: () => {} }),
          " Public"
        )
      ),
      h("div", { className: "lobby-grid" },
        Array.from({ length: 8 }, (_, i) => h(LobbySlot, { key: i, player: lobby.players[i], index: i }))
      ),
      h("div", { className: "panel-footer", style: { marginTop: 20, marginBottom: 0 } },
        h("span", null, allReady ? "The table is ready." : "Waiting for players to ready up."),
        h("div", { className: "dialog-actions", style: { margin: 0 } },
          h("button", { className: "ghost", "data-action": "toggle-ready" }, localPlayer?.ready ? "Unready" : "Ready"),
          h("button", { "data-action": "start-lobby-game", disabled: !allReady || !isHost }, "Start Game")
        )
      )
    ),
    h("button", { className: "bottom-left ghost", "data-action": "back" }, "Back")
  );
}

function LobbySlot({ player, index }) {
  if (!player) {
    return h("div", { className: "player-slot empty" },
      h("span", null, `Seat ${index + 1}`),
      (!state.lobby?.online || state.lobby?.isHost) ? h("button", { "data-action": "add-cpu" }, "Add CPU") : null
    );
  }
  return h("div", { className: "player-slot" },
    h("div", null,
      h("strong", null, player.name),
      h("span", { className: "pill" }, player.ready ? "Ready" : "Waiting")
    ),
    player.ai && (!state.lobby?.online || state.lobby?.isHost) ? h("button", { className: "eject", "data-action": "eject-cpu", "data-index": index, "data-player-id": player.id || "", "aria-label": `Eject ${player.name}` }, "Eject") : null
  );
}

function JoinLobbyScreen() {
  const code = state.joinCode.join("");
  const publicLobbies = state.publicLobbies || [];
  return h("section", { className: "screen panel-screen" },
    h("div", { className: "panel" },
      h("h2", null, "Join Lobby"),
      h("div", { className: "join-layout" },
        h("section", null,
          h("span", { className: "small-label" }, "Private"),
          h("div", { className: "panel-footer", style: { justifyContent: "flex-start", marginTop: 10 } },
            h("div", { className: "code-entry" },
              state.joinCode.map((char, i) => h("input", { key: i, "data-code-index": i, maxLength: 1, value: char, inputMode: "numeric", onChange: () => {} }))
            ),
            h("button", { "data-action": "join-private", disabled: code.length !== 4 }, "Join")
          )
        ),
        h("section", null,
          h("span", { className: "small-label" }, "Public"),
          h("div", { className: "public-list", style: { marginTop: 10 } },
            publicLobbies.length
              ? publicLobbies.map((lobby) => h("div", { className: "public-row", key: lobby.code },
                  h("div", null, h("strong", null, lobby.host), h("br"), h("span", null, `${lobby.players}/8 players`)),
                  h("button", { "data-action": "join-public", "data-code": lobby.code }, "Join")
                ))
              : h("div", { className: "public-row empty" }, h("span", null, "No public lobbies available."))
          )
        )
      )
    ),
    h("button", { className: "bottom-left ghost", "data-action": "back" }, "Back")
  );
}

function GameScreen() {
  const game = state.game;
  if (!game) return null;
  const player = game.players[game.currentPlayer];
  const readyPhase = isReadyPhase(game);
  const endingPhase = game.phase === "revealing" || game.phase === "complete";
  const crowded = game.players.some((p) => p.cards.length >= 7) || game.players.length >= 6;
  return h("section", { className: `game ${readyPhase ? "ready-phase" : ""} ${crowded ? "zoomed-table" : ""} ${endingPhase ? "ending-phase" : ""}` },
    h(Sidebar, { game, readyPhase }),
    h("div", { className: "table" },
      h("div", { className: "turn-card" }, h("strong", null, renderTurnTitle(game, player, readyPhase))),
      h(Confetti, { game }),
      h(KabooShouts, { game }),
      h("div", { className: "help-card" }, readyPhase ? (game.readyPlayers.has(game.localPlayerIndex) ? "Waiting for everyone else to ready up." : "Memorize your bottom cards, then press Ready.") : (endingPhase ? "Cards are being revealed." : game.message)),
      h(AnimationLayer, { animations: game.animations }),
      h("div", { className: "center-piles" }, h(DeckPile, { game }), h(DiscardPile, { game })),
      endingPhase ? null : h(TableTimer, { readyPhase, readyEndsAt: game.readyEndsAt, turnEndsAt: game.turnEndsAt }),
      h(TableButton, { game }),
      game.players.map((p, i) => h(HandView, { key: i, player: p, playerIndex: i, game })),
      h(ActionBar, { game })
    )
  );
}

function Sidebar({ game, readyPhase }) {
  return h("aside", { className: "sidebar" },
    h("div", { className: "chalkboard" },
      game.players.map((p, i) => h("div", { className: "chalk-row", key: i },
        h("span", null, i === game.currentPlayer ? "★" : ""),
        h("span", null, p.name),
        h("span", null, p.left ? "Left" : (readyPhase ? (game.readyPlayers.has(i) ? "Ready" : "Waiting") : ("|".repeat(p.wins || 0) || "-")))
      ))
    ),
    h("div", null, h(StatusLog, { lines: game.log.slice(-7) }))
  );
}

const StatusLog = memo(function StatusLog({ lines }) {
  return h("div", { className: "status-log" }, lines.map((line, index) => h("p", { key: `${index}:${line}` }, line)));
});

function TableTimer({ readyPhase, readyEndsAt, turnEndsAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const max = readyPhase ? READY_SECONDS : TURN_SECONDS;
  const deadline = readyPhase ? readyEndsAt : turnEndsAt;
  const secondsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));
  const warning = !readyPhase && secondsLeft <= 5;
  return h("div", { className: `table-timer ${warning ? "warning" : ""}`, style: { "--timer": `${(secondsLeft / max) * 100}%` } },
    h("span", { className: "stopwatch" }, "◴"),
    h("span", { className: "timer-count" }, `${secondsLeft}s`)
  );
}

function Confetti({ game }) {
  if (game.phase !== "complete" || game.winnerIndex === undefined) return null;
  const pos = positionForTarget({ playerIndex: game.winnerIndex, cardIndex: 0 });
  return h("div", { className: "confetti-burst", style: { left: `${pos.x}%`, top: `${pos.y}%` } },
    Array.from({ length: 28 }, (_, index) => {
      const angle = (-150 + index * 11) * (Math.PI / 180);
      const distance = 70 + (index % 7) * 12;
      return h("span", {
        key: index,
        style: {
          "--i": index,
          "--x": `${Math.round(Math.cos(angle) * distance)}px`,
          "--y": `${Math.round(Math.sin(angle) * distance - 60)}px`,
          "--r": `${index * 37}deg`
        }
      });
    })
  );
}

function KabooShouts({ game }) {
  return h(React.Fragment, null, (game.kabooShouts || []).map((shout, index) => {
    const pos = positionForTarget({ playerIndex: shout.playerIndex, cardIndex: 0 });
    const dx = Math.max(-100, Math.min(100, 50 - pos.x));
    const dy = Math.max(-100, Math.min(100, 50 - pos.y));
    return h("div", { key: `${shout.expiresAt}:${index}`, className: "kaboo-shout", style: { left: `${pos.x}%`, top: `${pos.y}%`, "--dx": `${dx}px`, "--dy": `${dy}px` } }, "Kaboo");
  }));
}

function DeckPile({ game }) {
  const humanHeldDeck = isLocalTurn(game) && game.heldCard && game.source === "deck";
  const stack = Math.min(14, Math.max(1, Math.ceil(game.deck.length / 4)));
  const hidden = isPileHidden("deck", game);
  const canDraw = canHumanAct() && !game.heldCard;
  if (humanHeldDeck && hidden) return h("div", { className: "pile" }, h("button", { className: "card back pile-card stacked", style: { "--stack": `${stack}px` }, "data-action": "draw-deck", disabled: !canDraw, "aria-label": "Draw from deck" }, h(StackLayers, { stack })));
  if (humanHeldDeck) return h("div", { className: "pile" }, h(CardView, { card: game.heldCard, visible: true, extra: `selected pile-card stacked ${hidden ? "in-flight" : ""}`, action: "held-deck", stack }));
  return h("div", { className: "pile" }, h("button", { className: `card back pile-card stacked ${game.source === "deck" ? "selected" : ""}`, style: { "--stack": `${stack}px` }, "data-action": "draw-deck", disabled: !canDraw, "aria-label": "Draw from deck" }, h(StackLayers, { stack })));
}

function DiscardPile({ game }) {
  const humanHeldDiscard = isLocalTurn(game) && game.heldCard && game.source === "discard";
  const stack = Math.min(14, Math.max(1, Math.ceil(game.discard.length / 3)));
  const hidden = isPileHidden("discard", game);
  const canUseDiscard = canHumanAct() && (!game.heldCard || game.source === "deck");
  const action = canUseDiscard ? "discard" : "";
  if (humanHeldDiscard && !hidden) return h("div", { className: "pile" }, h(CardView, { card: game.heldCard, visible: true, extra: "selected pile-card stacked", action: "held-discard", stack }));
  if (hidden) {
    const underCard = game.discard.length > 1 ? game.discard[game.discard.length - 2] : null;
    return h("div", { className: "pile" }, underCard ? h(CardView, { card: underCard, visible: true, extra: "pile-card stacked", action, stack: Math.max(1, stack - 1) }) : h("button", { className: "card pile-card empty table-empty", "data-action": "discard-empty", disabled: !canUseDiscard, "aria-label": "Empty discard pile" }));
  }
  if (game.discard.length) return h("div", { className: "pile" }, h(CardView, { card: last(game.discard), visible: true, extra: "pile-card stacked", action, stack }));
  return h("div", { className: "pile" }, h("button", { className: "card pile-card empty table-empty", "data-action": "discard-empty", disabled: !canUseDiscard, "aria-label": "Empty discard pile" }));
}

function AnimationLayer({ animations }) {
  return h(React.Fragment, null, (animations || []).map((animation) => h("div", {
    key: animation.id,
    className: `flying-card ${animation.red ? "red" : ""}`,
    style: {
      "--from-x": `${animation.from.x}%`,
      "--from-y": `${animation.from.y}%`,
      "--mid-x": `${animation.mid.x}%`,
      "--mid-y": `${animation.mid.y}%`,
      "--to-x": `${animation.to.x}%`,
      "--to-y": `${animation.to.y}%`,
      "--duration": `${animation.duration}ms`,
      "--flip-delay": `${animation.flipDelay}ms`
    }
  },
    h("span", { className: `fly-inner ${animation.startFace === animation.endFace ? `hold-${animation.startFace}` : `flip-${animation.startFace}-to-${animation.endFace}`}` },
      h("span", { className: "fly-face fly-front" }, h(FlyingFront, { animation })),
      h("span", { className: "fly-face fly-back" }, "K")
    )
  )));
}

function FlyingFront({ animation }) {
  if (!animation.rank) return h("span", { className: "suit" }, "K");
  return [
    h("span", { className: "rank", key: "rank" }, animation.rank),
    h("span", { className: "suit", key: "suit", dangerouslySetInnerHTML: { __html: animation.glyph } }),
    h("span", { className: "rank bottom", key: "bottom" }, animation.rank)
  ];
}

function HandView({ player, playerIndex, game }) {
  const position = getHandPosition(playerIndex, game.players.length);
  const klass = isLocalPlayerIndex(playerIndex, game) ? "hand me" : "hand";
  const style = isLocalPlayerIndex(playerIndex, game) ? undefined : { left: `${position.left}%`, top: `${position.top}%` };
  return h("div", { className: klass, style, title: player.name },
    player.cards.map((card, cardIndex) => {
      const visible = isCardVisible(game, playerIndex, cardIndex);
      const selected = game.selection.some((s) => s.playerIndex === playerIndex && s.cardIndex === cardIndex);
      const hidden = isSlotHidden(game, playerIndex, cardIndex);
      const extra = `${selected ? "selected" : ""} ${hidden ? "in-flight" : ""}`.trim();
      return h(CardView, { key: card?.id || `empty-${cardIndex}`, card, visible, extra, action: `table-card:${playerIndex}:${cardIndex}`, extraStyle: slotGridStyleObject(cardIndex) });
    })
  );
}

function CardView({ card, visible, extra = "", action = "", stack = 0, extraStyle = {} }) {
  const style = { ...extraStyle };
  if (stack) style["--stack"] = `${stack}px`;
  if (!card) return h("button", { className: `card slot-empty ${extra}`, style, "data-card-action": action, "aria-label": "Empty card slot" });
  if (!visible) return h("button", { className: `card back ${extra}`, style, "data-card-action": action, "aria-label": "Face down card" }, stack > 1 ? h(StackLayers, { stack }) : null);
  const red = card.suit.color === "red" ? "red" : "";
  return h("button", { className: `card ${red} ${extra}`, style, "data-card-action": action, "aria-label": cardLabel(card) },
    stack > 1 ? h(StackLayers, { stack }) : null,
    h("span", { className: "top-card-face" },
      h("span", { className: "rank" }, card.rank),
      h("span", { className: "suit", dangerouslySetInnerHTML: { __html: card.suit.glyph } }),
      h("span", { className: "rank bottom" }, card.rank)
    )
  );
}

function StackLayers({ stack }) {
  return h(React.Fragment, null, Array.from({ length: Math.min(12, stack - 1) }, (_, index) => h("span", { key: index, className: "stack-layer", style: { "--i": index + 1 } })));
}

function ActionBar({ game }) {
  if (isReadyPhase(game) || !game.pendingAction) return null;
  const action = game.pendingAction;
  if (action.type === "snapGive") {
    if (game.localPlayerIndex !== action.snappingPlayerIndex) return null;
    return h("div", { className: "action-bar" }, h("strong", null, "Choose one of your cards to give."));
  }
  if (!isLocalTurn(game)) return null;
  const copy = {
    ownPeek: "Pick one of your cards to peek.",
    opponentPeek: "Pick an opponent card to peek.",
    blindSwap: "Pick any two table cards to swap.",
    kingSwap: "Pick any two cards to inspect."
  }[action.type] || "";
  if (action.type === "kingChoice") {
    return h("div", { className: "action-bar" },
      h("button", { "data-action": "confirm-king-swap" }, "Swap"),
      h("button", { className: "ghost", "data-action": "cancel-action" }, "Leave")
    );
  }
  return h("div", { className: "action-bar" }, h("strong", null, copy), h("button", { className: "ghost", "data-action": "cancel-action" }, "Skip"));
}

function TableButton({ game }) {
  if (isReadyPhase(game)) {
    const ready = game.readyPlayers.has(game.localPlayerIndex);
    return h("div", { className: "table-button-row" }, h("button", { "data-action": "ready-game", disabled: ready }, "Ready"));
  }
  if (!isLocalTurn(game) || game.actionHoldUntil > Date.now() || game.kabooBy !== null || game.kabooHold || game.pendingAction || game.heldCard || game.source || game.phase !== "playing") return null;
  return h("div", { className: "table-button-row" }, h("button", { className: "kaboo danger", "data-action": "kaboo" }, "KABOO"));
}

function EndDialog() {
  const game = state.game;
  const rows = game.players.map((p) => ({ ...p, score: handScore(p.cards) })).sort((a, b) => a.score - b.score);
  const lowestScore = rows[0]?.score ?? 0;
  const winners = rows.filter((p) => p.score === lowestScore);
  const title = winners.length > 1
    ? `Draw: ${winners.map((p) => p.name).join(" and ")}`
    : `${rows[0].name} ${rows[0].name === "You" ? "win" : "wins"}`;
  return h("div", { className: "modal-backdrop" },
    h("section", { className: "dialog" },
      h("h2", null, title),
      h("table", { className: "score-table" },
        h("thead", null, h("tr", null, h("th", null, "Player"), h("th", null, "Score"), h("th", null, "Cards"))),
        h("tbody", null, rows.map((p) => h("tr", { key: p.name }, h("td", null, p.name), h("td", null, p.score), h("td", null, handLabels(p.cards)))))
      ),
      h(EndCountdown, { leaveAt: game.leaveAt }),
      h("div", { className: "dialog-actions" },
        h("button", { className: "ghost", "data-action": "leave-table" }, "Leave"),
        h("button", { "data-action": "play-again" }, "Play Again")
      )
    )
  );
}

function EndCountdown({ leaveAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  return h("p", null, `Play again timer: ${Math.max(0, Math.ceil((leaveAt - now) / 1000))}s`);
}

function renderOptions() {
  const username = escapeHtml(state.settings.username);
  const nameError = username && !isCleanUsername(username) ? `<p class="danger-text">Please choose a friendlier table name.</p>` : "";
  return `
    <div class="modal-backdrop">
      <section class="dialog">
        <h2>Options</h2>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" maxlength="10" value="${username}" autocomplete="off" />
          ${nameError}
        </div>
        <div class="field">
          <label for="sfx">SFX</label>
          <div class="slider-row">
            <input id="sfx" name="sfx" type="range" min="0" max="100" value="${state.settings.sfx}" />
            <output>${state.settings.sfx}</output>
          </div>
        </div>
        <div class="field">
          <label for="music">Music</label>
          <div class="slider-row muted">
            <input id="music" name="music" type="range" min="0" max="100" value="${state.settings.music}" disabled />
            <output>${state.settings.music}</output>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="ghost" data-action="close-modal">Close</button>
          <button data-action="save-options">Save</button>
        </div>
      </section>
    </div>
  `;
}

function renderAiDialog() {
  return `
    <div class="modal-backdrop">
      <section class="dialog">
        <h2>Singleplayer</h2>
        <div class="field">
          <label for="ai-count">AI opponents</label>
          <select id="ai-count" name="ai-count">
            ${Array.from({ length: 7 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}
          </select>
        </div>
        <div class="dialog-actions">
          <button class="ghost" data-action="close-modal">Cancel</button>
          <button data-action="start-singleplayer">Start Game</button>
        </div>
      </section>
    </div>
  `;
}

function renderAlert(title, message) {
  const action = state.modal?.next === "options" ? "open-options" : "close-modal";
  return `
    <div class="modal-backdrop">
      <section class="dialog">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <div class="dialog-actions"><button data-action="${action}">OK</button></div>
      </section>
    </div>
  `;
}

function renderLobby() {
  const lobby = state.lobby || createLobby();
  const slots = Array.from({ length: 8 }, (_, i) => lobby.players[i]).map((player, i) => {
    if (!player) return `<div class="player-slot empty"><span>Seat ${i + 1}</span><button data-action="add-cpu">Add CPU</button></div>`;
    const eject = player.ai ? `<button class="eject" data-action="eject-cpu" data-index="${i}" aria-label="Eject ${escapeHtml(player.name)}">Eject</button>` : "";
    return `<div class="player-slot"><div><strong>${escapeHtml(player.name)}</strong><span class="pill">${player.ready ? "Ready" : "Waiting"}</span></div>${eject}</div>`;
  }).join("");
  const allReady = lobby.players.length > 1 && lobby.players.every((p) => p.ready);
  return `
    <section class="screen panel-screen">
      <div class="panel">
        <div class="panel-header">
          <div>
            <span class="small-label">Private Code</span>
            <div class="code">${lobby.code}</div>
          </div>
          <label class="checkbox-row"><input type="checkbox" data-action="toggle-public" ${lobby.public ? "checked" : ""} /> Public</label>
        </div>
        <div class="lobby-grid">${slots}</div>
        <div class="panel-footer" style="margin-top:20px;margin-bottom:0">
          <span>${allReady ? "The table is ready." : "Waiting for players to ready up."}</span>
          <div class="dialog-actions" style="margin:0">
            <button class="ghost" data-action="toggle-ready">${lobby.players.find((p) => p.local)?.ready ? "Unready" : "Ready"}</button>
            <button data-action="start-lobby-game" ${allReady ? "" : "disabled"}>Start Game</button>
          </div>
        </div>
      </div>
      <button class="bottom-left ghost" data-action="back">Back</button>
    </section>
  `;
}

function renderJoinLobby() {
  const code = state.joinCode.join("");
  return `
    <section class="screen panel-screen">
      <div class="panel">
        <h2>Join Lobby</h2>
        <div class="join-layout">
          <section>
            <span class="small-label">Private</span>
            <div class="panel-footer" style="justify-content:flex-start;margin-top:10px">
              <div class="code-entry">
                ${state.joinCode.map((char, i) => `<input data-code-index="${i}" maxlength="1" value="${escapeHtml(char)}" inputmode="numeric" />`).join("")}
              </div>
              <button data-action="join-private" ${code.length === 4 ? "" : "disabled"}>Join</button>
            </div>
          </section>
          <section>
            <span class="small-label">Public</span>
            <div class="public-list" style="margin-top:10px">
              ${PUBLIC_LOBBIES.length ? PUBLIC_LOBBIES.map((lobby) => `
                <div class="public-row">
                  <div><strong>${lobby.host}</strong><br><span>${lobby.players}/8 players</span></div>
                  <button data-action="join-public" data-code="${lobby.code}">Join</button>
                </div>
              `).join("") : `<div class="public-row empty"><span>No public lobbies available.</span></div>`}
            </div>
          </section>
        </div>
      </div>
      <button class="bottom-left ghost" data-action="back">Back</button>
    </section>
  `;
}

function renderGame() {
  const game = state.game;
  if (!game) return "";
  const player = game.players[game.currentPlayer];
  const readyPhase = isReadyPhase(game);
  const endingPhase = game.phase === "revealing" || game.phase === "complete";
  const secondsLeft = readyPhase
    ? Math.max(0, Math.ceil((game.readyEndsAt - state.now) / 1000))
    : Math.max(0, Math.ceil((game.turnEndsAt - state.now) / 1000));
  const timerMax = readyPhase ? READY_SECONDS : TURN_SECONDS;
  const timerWarning = !readyPhase && !endingPhase && secondsLeft <= 5;
  const crowded = game.players.some((p) => p.cards.length >= 7) || game.players.length >= 6;
  return `
    <section class="game ${readyPhase ? "ready-phase" : ""} ${crowded ? "zoomed-table" : ""} ${endingPhase ? "ending-phase" : ""}">
      <aside class="sidebar">
        <div class="chalkboard">
          ${game.players.map((p, i) => `
            <div class="chalk-row">
              <span>${i === game.currentPlayer ? "★" : ""}</span>
              <span>${escapeHtml(p.name)}</span>
              <span>${readyPhase ? (game.readyPlayers.has(i) ? "Ready" : "Waiting") : ("|".repeat(p.wins || 0) || "-")}</span>
            </div>
          `).join("")}
        </div>
        <div>
          <div class="status-log">${game.log.slice(-7).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
        </div>
      </aside>
      <div class="table">
        <div class="turn-card">
          <strong>${renderTurnTitle(game, player, readyPhase)}</strong>
        </div>
        ${renderConfetti(game)}
        ${renderKabooShouts(game)}
        <div class="help-card">${readyPhase ? (game.readyPlayers.has(game.localPlayerIndex) ? "Waiting for everyone else to ready up." : "Memorize your bottom cards, then press Ready.") : (endingPhase ? "Cards are being revealed." : game.message)}</div>
        ${renderAnimations(game)}
        <div class="center-piles">
          ${renderDeckPile(game)}
          ${renderDiscardPile(game)}
        </div>
        <div class="table-timer ${timerWarning ? "warning" : ""} ${endingPhase ? "hidden" : ""}" style="--timer:${(secondsLeft / timerMax) * 100}%">
          <span class="stopwatch">◴</span>
          <span class="timer-count">${secondsLeft}s</span>
        </div>
        ${renderTableButton(game)}
        ${game.players.map((p, i) => renderHand(p, i, game)).join("")}
        ${renderActionBar(game)}
      </div>
    </section>
  `;
}

function renderTurnTitle(game, player, readyPhase) {
  if (game.kabooNotice && game.kabooNotice.expiresAt > Date.now()) return `${escapeHtml(game.players[game.kabooNotice.playerIndex].name)} called Kaboo!`;
  if (game.snapNotice && game.snapNotice.expiresAt > Date.now()) return `${escapeHtml(game.players[game.snapNotice.playerIndex].name)} Snapped!`;
  if (game.phase === "complete" && game.winnerIndex !== undefined) return `${escapeHtml(game.players[game.winnerIndex].name)} ${game.players[game.winnerIndex].name === "You" ? "win" : "wins"}!`;
  if (game.phase === "revealing") return "Revealing hands";
  if (readyPhase) return "Memorize your cards";
  return isLocalTurn(game) ? "Your turn" : `${escapeHtml(player.name)}'s turn`;
}

function renderConfetti(game) {
  if (game.phase !== "complete" || game.winnerIndex === undefined) return "";
  const pos = positionForTarget({ playerIndex: game.winnerIndex, cardIndex: 0 });
  return `<div class="confetti-burst" style="left:${pos.x}%;top:${pos.y}%">${Array.from({ length: 28 }, (_, index) => {
    const angle = (-150 + index * 11) * (Math.PI / 180);
    const distance = 70 + (index % 7) * 12;
    const x = Math.round(Math.cos(angle) * distance);
    const y = Math.round(Math.sin(angle) * distance - 60);
    return `<span style="--i:${index};--x:${x}px;--y:${y}px;--r:${index * 37}deg"></span>`;
  }).join("")}</div>`;
}

function renderKabooShouts(game) {
  return (game.kabooShouts || []).map((shout) => {
    const pos = positionForTarget({ playerIndex: shout.playerIndex, cardIndex: 0 });
    const dx = Math.max(-100, Math.min(100, 50 - pos.x));
    const dy = Math.max(-100, Math.min(100, 50 - pos.y));
    return `<div class="kaboo-shout" style="left:${pos.x}%;top:${pos.y}%;--dx:${dx}px;--dy:${dy}px">Kaboo</div>`;
  }).join("");
}

function renderDeckPile(game) {
  const humanHeldDeck = isLocalTurn(game) && game.heldCard && game.source === "deck";
  const stack = Math.min(14, Math.max(1, Math.ceil(game.deck.length / 4)));
  const hidden = isPileHidden("deck", game);
  if (humanHeldDeck && hidden) return `<div class="pile"><button class="card back pile-card stacked" style="--stack:${stack}px" data-action="draw-deck" aria-label="Draw from deck">${renderStackLayers(stack)}</button></div>`;
  if (humanHeldDeck) return `<div class="pile">${renderCard(game.heldCard, true, `selected pile-card stacked ${hidden ? "in-flight" : ""}`, "held-deck", stack)}</div>`;
  return `<div class="pile"><button class="card back pile-card stacked ${game.source === "deck" ? "selected" : ""}" style="--stack:${stack}px" data-action="draw-deck" aria-label="Draw from deck">${renderStackLayers(stack)}</button></div>`;
}

function renderDiscardPile(game) {
  const humanHeldDiscard = isLocalTurn(game) && game.heldCard && game.source === "discard";
  const stack = Math.min(14, Math.max(1, Math.ceil(game.discard.length / 3)));
  const hidden = isPileHidden("discard", game);
  if (humanHeldDiscard && !hidden) return `<div class="pile">${renderCard(game.heldCard, true, "selected pile-card stacked", "held-discard", stack)}</div>`;
  if (hidden) {
    const underCard = game.discard.length > 1 ? game.discard[game.discard.length - 2] : null;
    return `<div class="pile">${underCard ? renderCard(underCard, true, "pile-card stacked", "discard", Math.max(1, stack - 1)) : `<button class="card pile-card empty table-empty" data-action="discard-empty" aria-label="Empty discard pile"></button>`}</div>`;
  }
  if (game.discard.length) return `<div class="pile">${renderCard(last(game.discard), true, "pile-card stacked", "discard", stack)}</div>`;
  return `<div class="pile"><button class="card pile-card empty table-empty" data-action="discard-empty" aria-label="Empty discard pile"></button></div>`;
}

function renderAnimations(game) {
  return (game.animations || []).map((animation) => `
    <div class="flying-card ${animation.red ? "red" : ""}"
      style="--from-x:${animation.from.x}%;--from-y:${animation.from.y}%;--mid-x:${animation.mid.x}%;--mid-y:${animation.mid.y}%;--to-x:${animation.to.x}%;--to-y:${animation.to.y}%;--duration:${animation.duration}ms;--flip-delay:${animation.flipDelay}ms">
      <span class="fly-inner ${animation.startFace === animation.endFace ? `hold-${animation.startFace}` : `flip-${animation.startFace}-to-${animation.endFace}`}">
        <span class="fly-face fly-front">${renderFlyingFront(animation)}</span>
        <span class="fly-face fly-back">K</span>
      </span>
    </div>
  `).join("");
}

function renderFlyingFront(animation) {
  if (!animation.rank) return `<span class="suit">K</span>`;
  return `
    <span class="rank">${animation.rank}</span>
    <span class="suit">${animation.glyph}</span>
    <span class="rank bottom">${animation.rank}</span>
  `;
}

function renderHand(player, playerIndex, game) {
  const position = getHandPosition(playerIndex, game.players.length);
  const klass = isLocalPlayerIndex(playerIndex, game) ? "hand me" : "hand";
  const style = isLocalPlayerIndex(playerIndex, game) ? "" : `style="left:${position.left}%;top:${position.top}%"`;
  return `
    <div class="${klass}" ${style} title="${escapeHtml(player.name)}">
      ${player.cards.map((card, cardIndex) => {
        const visible = isCardVisible(game, playerIndex, cardIndex);
        const selected = game.selection.some((s) => s.playerIndex === playerIndex && s.cardIndex === cardIndex);
        const hidden = isSlotHidden(game, playerIndex, cardIndex);
        const extra = `${selected ? "selected" : ""} ${hidden ? "in-flight" : ""}`.trim();
        return renderCard(card, visible, extra, `table-card:${playerIndex}:${cardIndex}`, 0, slotGridStyle(cardIndex));
      }).join("")}
    </div>
  `;
}

function getHandPosition(playerIndex, totalPlayers) {
  const localIndex = state.game?.localPlayerIndex ?? 0;
  if (playerIndex === localIndex) return { left: 50, top: 86 };
  const opponentOrder = Array.from({ length: totalPlayers }, (_, index) => index).filter((index) => index !== localIndex);
  const opponents = opponentOrder.length;
  const opponentIndex = opponentOrder.indexOf(playerIndex);
  if (opponents <= 1) return { left: 50, top: 12 };
  if (opponents === 2) return [{ left: 24, top: 22 }, { left: 76, top: 22 }][opponentIndex];
  const start = 218;
  const end = -38;
  const angle = (start + ((end - start) * opponentIndex) / (opponents - 1)) * (Math.PI / 180);
  return {
    left: Math.round(50 + Math.cos(angle) * 39),
    top: Math.round(49 - Math.sin(angle) * 39)
  };
}

function slotGridPosition(index) {
  const slots = [
    { col: 2, row: 1 },
    { col: 3, row: 1 },
    { col: 2, row: 2 },
    { col: 3, row: 2 },
    { col: 4, row: 1 },
    { col: 1, row: 1 },
    { col: 4, row: 2 },
    { col: 1, row: 2 }
  ];
  if (slots[index]) return slots[index];
  const overflow = index - slots.length;
  return { col: 2 + (overflow % 2), row: 3 + Math.floor(overflow / 2) };
}

function slotGridStyle(index) {
  const { col, row } = slotGridPosition(index);
  return `grid-column:${col};grid-row:${row}`;
}

function slotGridStyleObject(index) {
  const { col, row } = slotGridPosition(index);
  return { gridColumn: col, gridRow: row };
}

function slotOffset(index, local = false) {
  const { col, row } = slotGridPosition(index);
  return {
    x: (col - 2.5) * (local ? 4.8 : 4.2),
    y: (row - 1.5) * (local ? 7 : 6)
  };
}

function renderActionBar(game) {
  if (isReadyPhase(game)) return "";
  if (!game.pendingAction || !isLocalTurn(game)) return "";
  const action = game.pendingAction;
  const copy = {
    ownPeek: "Pick one of your cards to peek.",
    opponentPeek: "Pick an opponent card to peek.",
    blindSwap: "Pick any two table cards to swap.",
    kingSwap: "Pick any two cards to inspect."
  }[action.type] || "";
  if (action.type === "kingChoice") {
    return `
      <div class="action-bar">
        <button data-action="confirm-king-swap">Swap</button>
        <button class="ghost" data-action="cancel-action">Leave</button>
      </div>
    `;
  }
  return `<div class="action-bar"><strong>${copy}</strong><button class="ghost" data-action="cancel-action">Skip</button></div>`;
}

function renderTableButton(game) {
  if (isReadyPhase(game)) {
    const ready = game.readyPlayers.has(game.localPlayerIndex);
    return `
      <div class="table-button-row">
        <button data-action="ready-game" ${ready ? "disabled" : ""}>Ready</button>
      </div>
    `;
  }
  if (!isLocalTurn(game) || game.kabooBy !== null || game.pendingAction || game.heldCard || game.source || game.phase !== "playing") return "";
  return `
    <div class="table-button-row">
      <button class="kaboo danger" data-action="kaboo">KABOO</button>
    </div>
  `;
}

function renderEndDialog() {
  const game = state.game;
  const rows = game.players.map((p) => ({ ...p, score: handScore(p.cards) })).sort((a, b) => a.score - b.score);
  return `
    <div class="modal-backdrop">
      <section class="dialog">
        <h2>${escapeHtml(rows[0].name)} ${rows[0].name === "You" ? "win" : "wins"}</h2>
        <table class="score-table">
          <thead><tr><th>Player</th><th>Score</th><th>Cards</th></tr></thead>
          <tbody>
            ${rows.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.score}</td><td>${handLabels(p.cards)}</td></tr>`).join("")}
          </tbody>
        </table>
        <p>Play again timer: ${Math.max(0, Math.ceil((game.leaveAt - state.now) / 1000))}s</p>
        <div class="dialog-actions">
          <button class="ghost" data-action="leave-table">Leave</button>
          <button data-action="play-again">Play Again</button>
        </div>
      </section>
    </div>
  `;
}

function renderCard(card, visible, extra = "", action = "", stack = 0, extraStyle = "") {
  const styles = [stack ? `--stack:${stack}px` : "", extraStyle].filter(Boolean).join(";");
  const styleAttr = styles ? `style="${styles}"` : "";
  if (!card) return `<button class="card slot-empty ${extra}" ${styleAttr} data-card-action="${action}" aria-label="Empty card slot"></button>`;
  const layers = stack > 1 ? renderStackLayers(stack) : "";
  if (!visible) return `<button class="card back ${extra}" ${styleAttr} data-card-action="${action}" aria-label="Face down card"></button>`;
  const red = card.suit.color === "red" ? "red" : "";
  return `
    <button class="card ${red} ${extra}" ${styleAttr} data-card-action="${action}" aria-label="${cardLabel(card)}">
      ${layers}
      <span class="top-card-face">
        <span class="rank">${card.rank}</span>
        <span class="suit">${card.suit.glyph}</span>
        <span class="rank bottom">${card.rank}</span>
      </span>
    </button>
  `;
}

function renderStackLayers(stack) {
  return Array.from({ length: Math.min(12, stack - 1) }, (_, index) => `<span class="stack-layer" style="--i:${index + 1}"></span>`).join("");
}

function bindEvents() {
  document.querySelectorAll("[data-code-index]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const index = Number(input.dataset.codeIndex);
      state.joinCode[index] = event.target.value.replace(/\D/g, "").slice(-1);
      render();
      const next = document.querySelector(`[data-code-index="${Math.min(3, index + 1)}"]`);
      if (state.joinCode[index] && next) next.focus();
    });
  });
  const username = document.querySelector("#username");
  if (username) username.addEventListener("input", (event) => {
    state.settings.username = event.target.value.slice(0, 10);
    saveSettings();
  });
  const sfx = document.querySelector("#sfx");
  if (sfx) sfx.addEventListener("input", (event) => {
    state.settings.sfx = Number(event.target.value);
    saveSettings();
    render();
  });
}

function handleAction(action, target) {
  if (isAnimating(state.game) && !["options", "close-modal", "save-options"].includes(action)) return;
  if (["cancel-action", "confirm-king-swap"].includes(action) && !isLocalTurn(state.game)) return;
  if (action !== "kaboo") bloop("bloop");
  if (action === "options") state.modal = { type: "options" };
  if (action === "rules") state.modal = { type: "rules" };
  if (action === "close-modal") state.modal = null;
  if (action === "confirm-quit") state.modal = { type: "confirmQuit" };
  if (action === "quit-game") quitGame();
  if (action === "retry-relay") retryRelayConnection();
  if (action === "cancel-relay-connect") cancelRelayConnection();
  if (action === "open-options") state.modal = { type: "options" };
  if (action === "save-options") saveOptions();
  if (action === "single") state.modal = { type: "ai" };
  if (action === "multi") {
    connectRelay();
    go("multiplayer");
  }
  if (action === "host") hostLobby();
  if (action === "join") {
    connectRelay();
    sendRelay("listLobbies");
    go("join");
  }
  if (action === "back") back();
  if (action === "toggle-public") togglePublic();
  if (action === "toggle-ready") toggleReady();
  if (action === "add-cpu") addCpuToLobby();
  if (action === "eject-cpu") ejectCpuFromLobby(Number(target.dataset.index), target.dataset.playerId);
  if (action === "start-lobby-game") {
    if (isOnlineLobby()) sendRelay("startGame");
    else startGame(state.lobby.players);
  }
  if (action === "start-singleplayer") {
    const count = Number(document.querySelector("#ai-count").value);
    startGame(makePlayers(count));
  }
  if (action === "join-private") joinPrivate();
  if (action === "join-public") joinPublic(target.dataset.code);
  if (action === "draw-deck") drawDeck();
  if (action === "ready-game") markPlayerReady(state.game?.localPlayerIndex);
  if (action === "discard-empty") {
    if (state.game?.heldCard && state.game.source === "deck" && isLocalTurn(state.game)) {
      if (isOnlineGame(state.game)) sendGameIntent("playHeld");
      else playHeldCard();
    }
    else toast("No discard card yet.");
  }
  if (action === "kaboo") callKaboo();
  if (action === "cancel-action") cancelAction(Boolean(state.game?.pendingAction));
  if (action === "confirm-king-swap") confirmKingSwap();
  if (action === "play-again") {
    if (isOnlineGame()) sendRelay("playAgain");
    else startGame(state.game.players.map((p, index) => ({ name: p.name, ai: p.ai, local: index === state.game.localPlayerIndex, ready: true, wins: p.wins })));
  }
  if (action === "leave-table") {
    if (isOnlineGame()) sendRelay("leaveRoom");
    state.modal = null;
    state.game = null;
    go("title", true);
  }
  render();
}

function handleCardAction(action) {
  if (!action || !state.game) return;
  const game = state.game;
  if (isAnimating(game)) return;
  if (action === "discard") {
    if (game.heldCard && game.source === "deck" && isLocalTurn(game)) {
      if (isOnlineGame(game)) sendGameIntent("playHeld");
      else playHeldCard();
    }
    return render();
  }
  if (!action.startsWith("table-card")) return;
  const [, playerIndexText, cardIndexText] = action.split(":");
  const playerIndex = Number(playerIndexText);
  const cardIndex = Number(cardIndexText);
  bloop("bloop");
  if (isOnlineGame(game)) {
    if (game.pendingAction?.type === "snapGive") {
      if (playerIndex === game.localPlayerIndex) sendGameIntent("giveSnapCard", { cardIndex });
      else toast("Choose one of your own cards to give.");
    } else if (game.pendingAction && isLocalTurn(game)) {
      sendGameIntent("cardAction", { targetPlayerIndex: playerIndex, cardIndex });
    } else if (game.heldCard && isLocalTurn(game) && isLocalPlayerIndex(playerIndex, game)) {
      sendGameIntent("swapHeld", { cardIndex });
    } else if (game.discard.length) {
      sendGameIntent("snap", { ownerIndex: playerIndex, cardIndex });
    }
    return render();
  }
  if (game.pendingAction?.type === "snapGive") {
    if (game.pendingAction.snappingPlayerIndex !== game.localPlayerIndex) return;
    if (playerIndex !== game.localPlayerIndex) return toast("Choose one of your own cards to give.");
    giveSnapCard(cardIndex);
    return render();
  }
  if (game.pendingAction) {
    if (!isLocalTurn(game)) return;
    handlePendingAction(playerIndex, cardIndex);
  } else if (game.heldCard && isLocalTurn(game) && isLocalPlayerIndex(playerIndex, game)) {
    swapHeldWithOwn(cardIndex);
  } else if (game.discard.length) {
    attemptSnap(game.localPlayerIndex, playerIndex, cardIndex);
  }
  render();
}

function saveOptions() {
  const clean = isCleanUsername(state.settings.username);
  if (!clean) {
    state.modal = { type: "alert", title: "Try another name", message: "That username is too close to blocked language." };
    return;
  }
  saveSettings();
  state.modal = null;
  toast("Options saved.");
}

function go(screen, replace = false) {
  if (!replace) state.previous.push(state.screen);
  state.screen = screen;
}

function back() {
  if ((state.screen === "lobby" || state.screen === "game") && (isOnlineLobby() || isOnlineGame())) {
    sendRelay("leaveRoom");
    state.lobby = null;
    state.game = null;
  }
  state.screen = state.previous.pop() || "title";
}

function hostLobby() {
  if (!requireUsername()) return;
  if (RELAY_URL) {
    sendRelay("createLobby", { username: state.settings.username });
    return;
  } else {
    state.modal = {
      type: "alert",
      title: "Relay not configured",
      message: "Set VITE_KABOO_RELAY_URL in Netlify to enable online multiplayer."
    };
    return;
  }
  state.lobby = createLobby();
  go("lobby");
}

function createLobby() {
  return {
    code: String(Math.floor(1000 + Math.random() * 9000)),
    public: false,
    players: [
      { name: state.settings.username || "Player", ready: false, ai: false, local: true, wins: 0 }
    ]
  };
}

function addCpuToLobby() {
  if (isOnlineLobby()) {
    sendRelay("addCpu");
    return;
  }
  const lobby = state.lobby;
  if (!lobby || lobby.players.length >= 8) return;
  const cpuNames = ["Scout", "Pip", "Dot", "Finn", "Bea", "Kit", "Nia"];
  const used = new Set(lobby.players.map((player) => player.name));
  const name = cpuNames.find((candidate) => !used.has(candidate)) || `CPU ${lobby.players.filter((player) => player.ai).length + 1}`;
  lobby.players.push({ name, ready: true, ai: true, wins: 0 });
}

function ejectCpuFromLobby(index, playerId = "") {
  if (isOnlineLobby()) {
    sendRelay("ejectCpu", { playerId });
    return;
  }
  const lobby = state.lobby;
  if (!lobby || !lobby.players[index]?.ai) return;
  lobby.players.splice(index, 1);
}

function togglePublic() {
  if (isOnlineLobby()) {
    sendRelay("setPublic", { public: !state.lobby.public });
    return;
  }
  state.lobby.public = !state.lobby.public;
}

function toggleReady() {
  if (isOnlineLobby()) {
    const local = state.lobby.players.find((player) => player.local);
    sendRelay("setReady", { ready: !local?.ready });
    return;
  }
  const local = state.lobby.players.find((player) => player.local);
  if (local) local.ready = !local.ready;
}

function joinPrivate() {
  const code = state.joinCode.join("");
  if (!requireUsername()) return;
  if (RELAY_URL) {
    sendRelay("joinLobby", { code, username: state.settings.username });
    return;
  }
  if (PUBLIC_LOBBIES.some((l) => l.code === code) || state.lobby?.code === code) {
    joinPublic(code);
  } else {
    state.modal = { type: "alert", title: "Lobby not found", message: "That game code does not exist or is already full." };
  }
}

function joinPublic(code) {
  if (!requireUsername()) return;
  if (RELAY_URL) {
    sendRelay("joinLobby", { code, username: state.settings.username });
    return;
  }
  const lobby = PUBLIC_LOBBIES.find((item) => item.code === code);
  if (!lobby) {
    state.modal = { type: "alert", title: "Lobby not found", message: "That public game is no longer available." };
    return;
  }
  state.lobby = {
    code: lobby.code,
    public: true,
    players: [
      { name: lobby.host, ready: true, ai: true, wins: 0 },
      { name: state.settings.username, ready: false, ai: false, local: true, wins: 0 },
      { name: "Guest", ready: true, ai: true, wins: 0 }
    ]
  };
  go("lobby");
}

function requireUsername() {
  if (state.settings.username && isCleanUsername(state.settings.username)) return true;
  state.modal = {
    type: "alert",
    title: "Username needed",
    message: "Set a username before multiplayer. The options menu will open next.",
    next: "options"
  };
  return false;
}

function makePlayers(aiCount) {
  const names = ["Dot", "Finn", "Max", "Bea", "Kit", "Nia", "Sol"];
  return [
    { name: state.settings.username || "You", ai: false, local: true, ready: true, wins: 0 },
    ...Array.from({ length: aiCount }, (_, i) => ({ name: names[i], ai: true, ready: true, wins: 0 }))
  ];
}

function startGame(players) {
  if (aiTimer) clearTimeout(aiTimer);
  if (snapTimer) clearTimeout(snapTimer);
  const deck = shuffle(makeDeck());
  const now = Date.now();
  const gamePlayers = players.map((player) => ({
    ...player,
    cards: [deck.pop(), deck.pop(), deck.pop(), deck.pop()],
    memory: new Set(),
    protected: false
  }));
  gamePlayers.forEach((player) => {
    [2, 3].forEach((index) => rememberCard(player, player.cards[index]));
  });
  state.game = {
    players: gamePlayers,
    localPlayerIndex: Math.max(0, gamePlayers.findIndex((player) => player.local)),
    deck,
    discard: [],
    visibleToHuman: new Map(),
    animations: [],
    kabooShouts: [],
    kabooNotice: null,
    snapNotice: null,
    hiddenSlots: new Set(),
    hiddenPiles: new Set(),
    snapLockedDiscardId: null,
    currentPlayer: Math.floor(Math.random() * gamePlayers.length),
    heldCard: null,
    source: null,
    selection: [],
    pendingAction: null,
    snappedCardIds: new Set(),
    phase: "ready",
    readyPlayers: new Set(gamePlayers.map((player, index) => player.ai ? index : -1).filter((index) => index >= 0)),
    readyEndsAt: now + READY_SECONDS * 1000,
    turnEndsAt: now + TURN_SECONDS * 1000,
    kabooBy: null,
    kabooHold: false,
    finalTurns: null,
    message: "Memorize your bottom two cards.",
    log: ["Cards dealt. AI players are ready. Ready up when you have memorized your cards."]
  };
  state.now = now;
  state.screen = "game";
  state.modal = null;
  startTicker();
}

function isLocalTurn(game = state.game) {
  return Boolean(game && game.currentPlayer === game.localPlayerIndex);
}

function isLocalPlayerIndex(playerIndex, game = state.game) {
  return Boolean(game && playerIndex === game.localPlayerIndex);
}

function isReadyPhase(game = state.game) {
  return Boolean(game && game.phase === "ready");
}

function areAllPlayersReady(game = state.game) {
  return Boolean(game && game.players.every((_, index) => game.readyPlayers.has(index)));
}

function markPlayerReady(playerIndex, game = state.game) {
  if (!isReadyPhase(game)) return;
  if (isOnlineGame(game)) {
    sendGameIntent("readyGame");
    return;
  }
  game.readyPlayers.add(playerIndex);
  if (areAllPlayersReady(game)) beginTurns(game);
}

function beginTurns(game = state.game) {
  if (!isReadyPhase(game)) return;
  game.phase = "playing";
  game.message = "Draw from the deck or pick up the discard pile.";
  game.log.push("Everyone is ready. The first turn begins.");
  resetTurnTimer(game);
  scheduleAiSnap();
  scheduleAiTurn();
}

function hasUnprotectedOpponent(playerIndex, game = state.game) {
  return Boolean(game?.players.some((player, index) => index !== playerIndex && !player.protected));
}

function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit, id: `${rank}${suit.id}-${crypto.randomUUID()}` })));
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function drawDeck() {
  const game = state.game;
  if (!canHumanAct()) return;
  if (isOnlineGame(game)) {
    sendGameIntent("drawDeck");
    return;
  }
  if (game.heldCard) return toast("Play or swap your held card first.");
  if (!ensureDeck()) return toast("No cards left to draw.");
  resetTurnTimer(game);
  game.heldCard = game.deck.pop();
  game.source = "deck";
  game.message = "Swap with one of your cards, or play it to the discard pile.";
}

function drawDiscard() {
  const game = state.game;
  if (!canHumanAct()) return;
  if (isOnlineGame(game)) {
    sendGameIntent("drawDiscard");
    return;
  }
  if (!game.discard.length) return;
  resetTurnTimer(game);
  game.heldCard = game.discard.pop();
  game.source = "discard";
  game.message = "Swap the discard card with one of your cards.";
}

function swapHeldWithOwn(cardIndex) {
  const game = state.game;
  const player = game.players[game.currentPlayer];
  const oldCard = player.cards[cardIndex];
  if (!oldCard) return toast("Choose a card, not an empty slot.");
  const incoming = game.heldCard;
  const source = game.source;
  const incomingStart = source === "discard" ? "up" : (isLocalTurn(game) ? "up" : "down");
  hidePile(source, game);
  hideSlot(game.currentPlayer, cardIndex, game);
  addAnimation("pile", { playerIndex: game.currentPlayer, cardIndex }, incoming, { startFace: incomingStart, endFace: "down" });
  addAnimation({ playerIndex: game.currentPlayer, cardIndex }, "discard", oldCard, { startFace: "down", endFace: "up" });
  game.animationLock = true;
  setTimeout(() => {
    if (state.game !== game) return;
    clearAnimations(game);
    player.cards[cardIndex] = incoming;
    rememberCard(player, incoming);
    game.discard.push(oldCard);
    game.snapLockedDiscardId = null;
    rememberDiscard(oldCard, false);
    game.log.push(`${player.name} swapped a card.`);
    game.heldCard = null;
    game.source = null;
    game.animationLock = false;
    clearHiddenSlots(game);
    clearHiddenPiles(game);
    render();
    scheduleAiSnap();
    endTurn();
  }, COMMIT_AFTER_MOVE_MS);
}

function playHeldCard() {
  const game = state.game;
  const card = game.heldCard;
  const startFace = game.source === "deck" && !isLocalTurn(game) ? "down" : "up";
  resetTurnTimer(game);
  hidePile(game.source, game);
  addAnimation("pile", "discard", card, { startFace, endFace: "up" });
  game.animationLock = true;
  setTimeout(() => {
    if (state.game !== game) return;
    clearAnimations(game);
    game.discard.push(card);
    game.snapLockedDiscardId = null;
    rememberDiscard(card, false);
    game.log.push(`${game.players[game.currentPlayer].name} played ${cardLabel(card)}.`);
    game.heldCard = null;
    game.source = null;
    game.animationLock = false;
    clearHiddenPiles(game);
    render();
    scheduleAiSnap();
    setActionFor(card);
  }, COMMIT_AFTER_MOVE_MS);
}

function setActionFor(card) {
  const game = state.game;
  resetTurnTimer(game);
  if (["7", "8"].includes(card.rank)) {
    game.pendingAction = { type: "ownPeek" };
    game.message = "Peek at one of your own cards.";
  } else if (["9", "10"].includes(card.rank)) {
    if (!hasUnprotectedOpponent(game.currentPlayer)) return endTurn();
    game.pendingAction = { type: "opponentPeek" };
    game.message = "Peek at an opponent card.";
  } else if (["J", "Q"].includes(card.rank)) {
    if (!hasUnprotectedOpponent(game.currentPlayer)) return endTurn();
    game.pendingAction = { type: "blindSwap", picks: [] };
    game.message = "Blind swap any two cards.";
  } else if (card.rank === "K") {
    if (!hasUnprotectedOpponent(game.currentPlayer)) return endTurn();
    game.pendingAction = { type: "kingSwap", picks: [] };
    game.message = "Look at any two cards, then swap or leave.";
  } else {
    endTurn();
  }
  if (game.pendingAction && !isLocalTurn(game)) {
    setTimeout(() => {
      if (state.game === game && game.pendingAction && !isLocalTurn(game) && !game.animationLock) {
        aiResolveAction();
        render();
      }
    }, 900);
  }
}

function handlePendingAction(playerIndex, cardIndex) {
  const game = state.game;
  const action = game.pendingAction;
  resetTurnTimer(game);
  if (game.players[playerIndex]?.protected && playerIndex !== game.currentPlayer) {
    toast("This player is protected.");
    return;
  }
  if (action.type === "ownPeek" && playerIndex === game.currentPlayer) {
    revealTemporarily(playerIndex, cardIndex);
    cancelAction(true);
  } else if (action.type === "opponentPeek" && playerIndex !== game.currentPlayer) {
    revealTemporarily(playerIndex, cardIndex);
    cancelAction(true);
  } else if (action.type === "blindSwap" || action.type === "kingSwap") {
    action.picks.push({ playerIndex, cardIndex });
    game.selection = action.picks;
    if (action.picks.length === 2) {
      if (action.type === "blindSwap") {
        game.pendingAction = null;
        game.selection = [];
        swapTwo(action.picks[0], action.picks[1], true);
      } else {
        revealTemporarily(action.picks[0].playerIndex, action.picks[0].cardIndex, 30000);
        revealTemporarily(action.picks[1].playerIndex, action.picks[1].cardIndex, 30000);
        game.pendingAction = { type: "kingChoice", picks: action.picks };
        game.message = "Swap those cards or leave them where they are.";
      }
    }
  }
}

function confirmKingSwap() {
  const game = state.game;
  if (isOnlineGame(game)) {
    sendGameIntent("confirmKingSwap");
    return;
  }
  const picks = game.pendingAction?.picks || [];
  clearVisiblePicks(picks, game);
  game.pendingAction = null;
  game.selection = [];
  if (picks.length === 2) swapTwo(picks[0], picks[1], true);
}

function cancelAction(advance = false) {
  const game = state.game;
  if (isOnlineGame(game)) {
    sendGameIntent("cancelAction", { advance });
    return;
  }
  resetTurnTimer(game);
  if (game.pendingAction?.type === "kingChoice" || game.pendingAction?.type === "kingSwap") {
    clearVisiblePicks(game.pendingAction.picks || [], game);
  }
  game.pendingAction = null;
  game.selection = [];
  if (advance) endTurn();
}

function revealTemporarily(playerIndex, cardIndex, duration = 3500) {
  const player = state.game.players[playerIndex];
  if (!player || cardIndex < 0 || !player.cards[cardIndex]) return;
  rememberCard(state.game.players[state.game.currentPlayer], player.cards[cardIndex]);
  if (isLocalTurn(state.game)) {
    state.game.visibleToHuman.set(player.cards[cardIndex].id, Date.now() + duration);
  }
  state.game.log.push(`${state.game.players[state.game.currentPlayer].name} peeked at a card.`);
}

function clearVisiblePicks(picks, game = state.game) {
  if (!game) return;
  picks.forEach(({ playerIndex, cardIndex }) => {
    const card = game.players[playerIndex]?.cards[cardIndex];
    if (card) game.visibleToHuman.delete(card.id);
  });
}

function swapTwo(a, b, advanceAfter = false) {
  const game = state.game;
  const cardA = game.players[a.playerIndex].cards[a.cardIndex];
  const cardB = game.players[b.playerIndex].cards[b.cardIndex];
  if (!cardA || !cardB) return;
  hideSlot(a.playerIndex, a.cardIndex, game);
  hideSlot(b.playerIndex, b.cardIndex, game);
  addAnimation(a, b, cardA, { startFace: "down", endFace: "down" });
  addAnimation(b, a, cardB, { startFace: "down", endFace: "down" });
  game.animationLock = true;
  setTimeout(() => {
    if (state.game !== game) return;
    clearAnimations(game);
    game.players[a.playerIndex].cards[a.cardIndex] = cardB;
    game.players[b.playerIndex].cards[b.cardIndex] = cardA;
    game.animationLock = false;
    clearHiddenSlots(game);
    game.log.push("Two table cards were swapped.");
    render();
    if (advanceAfter) endTurn();
  }, COMMIT_AFTER_MOVE_MS);
}

function attemptSnap(snappingPlayerIndex, ownerIndex, cardIndex) {
  const game = state.game;
  if (isAnimating(game)) return;
  cancelQueuedAiActions();
  const snapper = game.players[snappingPlayerIndex];
  const owner = game.players[ownerIndex];
  if (owner.protected) return toast("That hand is locked.");
  const target = owner.cards[cardIndex];
  if (!target || game.snappedCardIds.has(target.id)) return toast("That card has already been snapped.");
  const top = last(game.discard);
  if (!top) return;
  if (game.snapLockedDiscardId === top.id) return toast("Snap has already been attempted.");
  game.snapLockedDiscardId = top.id;
  if (target.rank === top.rank) {
    game.snappedCardIds.add(target.id);
    hideSlot(ownerIndex, cardIndex, game);
    addAnimation({ playerIndex: ownerIndex, cardIndex }, "discard", target, { startFace: "down", endFace: "up", duration: SNAP_MOVE_MS });
    game.animationLock = true;
    setTimeout(() => {
      if (state.game !== game) return;
      clearAnimations(game);
      game.discard.push(target);
      game.snapLockedDiscardId = target.id;
      rememberDiscard(target);
      owner.cards[cardIndex] = null;
      clearAnimations(game);
      game.animationLock = false;
      clearHiddenSlots(game);
      clearHiddenPiles(game);
      game.log.push(`${snapper.name} snapped ${cardLabel(top)} correctly.`);
      game.snapNotice = { playerIndex: snappingPlayerIndex, expiresAt: Date.now() + 1800 };
      if (ownerIndex !== snappingPlayerIndex) {
        game.pendingAction = { type: "snapGive", snappingPlayerIndex, ownerIndex, ownerCardIndex: cardIndex };
        game.selection = [];
        game.message = `${snapper.name} must choose a card to give.`;
        resetTurnTimer(game);
        if (snapper.ai) {
          setTimeout(() => {
            if (state.game === game && game.pendingAction?.type === "snapGive") giveSnapCard(pickWorstKnownCard(snapper));
            render();
          }, 900 + Math.floor(Math.random() * 900));
        }
      }
      render();
      scheduleAiTurn();
    }, SNAP_COMMIT_AFTER_MOVE_MS);
  } else {
    hideSlot(ownerIndex, cardIndex, game);
    addAnimation({ playerIndex: ownerIndex, cardIndex }, "discard", target, { startFace: "down", endFace: "up", duration: SNAP_MOVE_MS });
    game.animationLock = true;
    setTimeout(() => {
      if (state.game !== game) return;
      clearAnimations(game);
      addAnimation("discard", { playerIndex: ownerIndex, cardIndex }, target, { startFace: "up", endFace: "down", duration: SNAP_MOVE_MS });
      if (ensureDeck()) {
        const penalty = game.deck.pop();
        const penaltyIndex = placeCardInHand(snapper, penalty);
        hidePile("deck", game);
        hideSlot(snappingPlayerIndex, penaltyIndex, game);
        addAnimation("deck", { playerIndex: snappingPlayerIndex, cardIndex: penaltyIndex }, penalty, { startFace: "down", endFace: "down", duration: SNAP_MOVE_MS });
      }
      render();
      setTimeout(() => {
        if (state.game !== game) return;
        clearAnimations(game);
        game.animationLock = false;
        clearHiddenSlots(game);
        clearHiddenPiles(game);
        game.log.push(`${snapper.name} missed a snap and took a penalty card.`);
        toast("Missed snap. Penalty card.");
        render();
        scheduleAiTurn();
      }, SNAP_COMMIT_AFTER_MOVE_MS);
    }, SNAP_COMMIT_AFTER_MOVE_MS);
  }
}

function giveSnapCard(giveIndex) {
  const game = state.game;
  const action = game?.pendingAction;
  if (!game || action?.type !== "snapGive" || isAnimating(game)) return;
  const snapper = game.players[action.snappingPlayerIndex];
  const owner = game.players[action.ownerIndex];
  const giveCard = snapper?.cards[giveIndex];
  if (!giveCard) {
    if (randomIndex(snapper?.cards || []) < 0) {
      game.pendingAction = null;
      game.selection = [];
      render();
      scheduleAiTurn();
      return;
    }
    return toast("Choose a card, not an empty slot.");
  }
  hideSlot(action.snappingPlayerIndex, giveIndex, game);
  hideSlot(action.ownerIndex, action.ownerCardIndex, game);
  addAnimation(
    { playerIndex: action.snappingPlayerIndex, cardIndex: giveIndex },
    { playerIndex: action.ownerIndex, cardIndex: action.ownerCardIndex },
    giveCard,
    { startFace: "down", endFace: "down", duration: SNAP_MOVE_MS }
  );
  game.animationLock = true;
  setTimeout(() => {
    if (state.game !== game) return;
    clearAnimations(game);
    owner.cards[action.ownerCardIndex] = giveCard;
    snapper.cards[giveIndex] = null;
    game.pendingAction = null;
    game.selection = [];
    game.animationLock = false;
    clearHiddenSlots(game);
    game.log.push(`${snapper.name} gave a card to ${owner.name}.`);
    render();
    scheduleAiTurn();
  }, SNAP_COMMIT_AFTER_MOVE_MS);
}

function callKaboo() {
  const game = state.game;
  if (isOnlineGame(game)) {
    sendGameIntent("kaboo");
    return;
  }
  if ((!canHumanAct() && !game.players[game.currentPlayer]?.ai) || game.kabooBy !== null) return;
  game.kabooBy = game.currentPlayer;
  game.kabooHold = true;
  game.players[game.currentPlayer].protected = true;
  game.finalTurns = new Set(game.players.map((_, i) => i).filter((i) => i !== game.currentPlayer));
  game.log.push(`${game.players[game.currentPlayer].name} called KABOO.`);
  announceKaboo(game.currentPlayer);
  render();
  setTimeout(() => {
    if (state.game !== game || game.kabooBy === null) return;
    game.kabooHold = false;
    endTurn();
    render();
  }, 1900);
}

function announceKaboo(playerIndex, game = state.game) {
  if (!game) return;
  const now = Date.now();
  game.kabooNotice = { playerIndex, expiresAt: now + 2200 };
  game.kabooShouts.push({ playerIndex, expiresAt: now + 1800 });
  bloop("streamer");
}

function endTurn() {
  const game = state.game;
  if (game.kabooHold) return;
  game.heldCard = null;
  game.source = null;
  game.pendingAction = null;
  game.selection = [];
  if (game.finalTurns) {
    game.finalTurns.delete(game.currentPlayer);
    if (game.finalTurns.size === 0) return finishGame();
  }
  advanceCurrentPlayer();
  resetTurnTimer(game);
  game.message = "Draw from the deck or pick up the discard pile.";
  scheduleAiSnap();
  scheduleAiTurn();
}

function advanceCurrentPlayer() {
  const game = state.game;
  do {
    game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
  } while (game.players[game.currentPlayer].protected && game.finalTurns);
}

function finishGame() {
  const game = state.game;
  const winner = game.players.map((p, i) => ({ i, score: handScore(p.cards) })).sort((a, b) => a.score - b.score)[0];
  game.players[winner.i].wins = (game.players[winner.i].wins || 0) + 1;
  game.winnerIndex = winner.i;
  game.phase = "revealing";
  game.message = "Revealing every hand.";
  game.heldCard = null;
  game.source = null;
  game.pendingAction = null;
  game.selection = [];
  game.animationLock = true;
  cancelQueuedAiActions();
  game.players.forEach((player, playerIndex) => {
    player.cards.forEach((card, cardIndex) => {
      if (card) {
        hideSlot(playerIndex, cardIndex, game);
        addAnimation({ playerIndex, cardIndex }, { playerIndex, cardIndex }, card, { startFace: "down", endFace: "up", duration: MOVE_MS, cutoff: 0 });
      }
    });
  });
  setTimeout(() => {
    if (state.game !== game) return;
    clearAnimations(game);
    clearHiddenSlots(game);
    game.animationLock = false;
    game.phase = "complete";
    game.message = `${game.players[winner.i].name} Wins!`;
    bloop("streamer");
    render();
    setTimeout(() => {
      if (state.game !== game) return;
      game.leaveAt = Date.now() + 30000;
      state.modal = { type: "end" };
      render();
    }, 4000);
  }, MOVE_MS);
  render();
}

function timeoutTurn() {
  const game = state.game;
  if (isAnimating(game)) {
    resetTurnTimer(game);
    return;
  }
  if (game.pendingAction?.type === "snapGive") {
    const snapper = game.players[game.pendingAction.snappingPlayerIndex];
    giveSnapCard(randomIndex(snapper.cards));
    return;
  }
  const player = game.players[game.currentPlayer];
  if (player.ai) {
    resetTurnTimer(game);
    aiTurn();
    scheduleAiTurn();
    return;
  }
  if (ensureDeck()) placeCardInHand(player, game.deck.pop());
  game.log.push(`${player.name} timed out and took a penalty card.`);
  endTurn();
}

function aiTurn() {
  const game = state.game;
  if (!game || state.screen !== "game" || isLocalTurn(game) || isAnimating(game) || game.pendingAction || state.modal?.type === "end") return;
  const player = game.players[game.currentPlayer];
  if (shouldAiCallKaboo(game.currentPlayer)) return aiCallKaboo();
  const useDiscard = shouldAiPickDiscard(game.currentPlayer);
  if (useDiscard) {
    game.heldCard = game.discard.pop();
    game.source = "discard";
  } else {
    if (!ensureDeck()) return endTurn();
    game.heldCard = game.deck.pop();
    game.source = "deck";
  }
  rememberCard(player, game.heldCard);
  const cardIndex = pickWorstKnownCard(player);
  if (cardIndex < 0) return playHeldCard();
  const heldValue = cardValue(game.heldCard);
  const worstValue = estimatedCardValue(player, player.cards[cardIndex]);
  if (game.source === "discard" || heldValue <= 4 || heldValue < worstValue - 1) {
    swapHeldWithOwn(cardIndex);
  } else {
    playHeldCard();
  }
  render();
}

function aiResolveAction() {
  const game = state.game;
  const action = game.pendingAction;
  if (!action) return;
  if (action.type === "ownPeek") {
    const cardIndex = leastCertainOwnCardIndex(game.players[game.currentPlayer]);
    if (cardIndex >= 0) revealTemporarily(game.currentPlayer, cardIndex);
  } else if (action.type === "opponentPeek") {
    const opponent = mostThreateningOpponentIndex(game.currentPlayer);
    const cardIndex = opponent >= 0 ? leastKnownOpponentCardIndex(game.players[game.currentPlayer], game.players[opponent]) : -1;
    if (cardIndex >= 0) revealTemporarily(opponent, cardIndex);
  } else if (action.type === "blindSwap" || action.type === "kingSwap") {
    const plan = chooseAiSwapPlan(game.currentPlayer);
    if (plan && (action.type === "blindSwap" || plan.margin > 2 || Math.random() > 0.25)) {
      game.pendingAction = null;
      game.selection = [];
      swapTwo(plan.own, plan.opponent, true);
      return;
    }
  }
  cancelAction(true);
}

function pickWorstKnownCard(player) {
  let worst = randomIndex(player.cards);
  if (worst < 0) return -1;
  let worstValue = -Infinity;
  player.cards.forEach((card, i) => {
    if (!card) return;
    const remembered = player.memory.has(card.id);
    const value = remembered ? cardValue(card) : 7;
    if (value > worstValue) {
      worst = i;
      worstValue = value;
    }
  });
  return worst;
}

function estimatedCardValue(player, card) {
  if (!card) return 0;
  return player.memory.has(card.id) ? cardValue(card) : 6.5;
}

function estimatedHandScoreFor(player) {
  return player.cards.reduce((sum, card) => sum + estimatedCardValue(player, card), 0);
}

function knownCardCount(player) {
  return player.cards.filter((card) => card && player.memory.has(card.id)).length;
}

function shouldAiPickDiscard(playerIndex) {
  const game = state.game;
  const top = last(game.discard);
  if (!top) return false;
  const player = game.players[playerIndex];
  const worstIndex = pickWorstKnownCard(player);
  const worstValue = worstIndex >= 0 ? estimatedCardValue(player, player.cards[worstIndex]) : 6.5;
  const value = cardValue(top);
  if (value <= 1) return true;
  if (game.players.length > 4 && value <= 3) return true;
  return value <= 5 && value < worstValue - 0.5;
}

function shouldAiCallKaboo(playerIndex) {
  const game = state.game;
  if (game.kabooBy !== null || game.heldCard || game.finalTurns) return false;
  const player = game.players[playerIndex];
  const score = estimatedHandScoreFor(player);
  const confidence = knownCardCount(player) / Math.max(1, player.cards.filter(Boolean).length);
  const threshold = game.players.length <= 2 ? 7 : game.players.length <= 4 ? 6 : 5;
  const bestOpponent = Math.min(...game.players
    .map((opponent, index) => index === playerIndex || opponent.protected ? Infinity : estimateOpponentScore(player, opponent))
    .filter(Number.isFinite));
  return confidence >= 0.5 && score <= threshold && score <= bestOpponent + 1.5;
}

function aiCallKaboo() {
  callKaboo();
}

function estimateOpponentScore(aiPlayer, opponent) {
  return opponent.cards.reduce((sum, card) => {
    if (!card) return sum;
    return sum + (aiPlayer.memory.has(card.id) ? cardValue(card) : 6.5);
  }, 0);
}

function leastCertainOwnCardIndex(player) {
  const unknown = player.cards.findIndex((card) => card && !player.memory.has(card.id));
  return unknown >= 0 ? unknown : pickWorstKnownCard(player);
}

function mostThreateningOpponentIndex(aiIndex) {
  const game = state.game;
  const aiPlayer = game.players[aiIndex];
  let best = -1;
  let bestScore = Infinity;
  game.players.forEach((player, index) => {
    if (index === aiIndex || player.protected) return;
    const score = estimateOpponentScore(aiPlayer, player);
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function leastKnownOpponentCardIndex(aiPlayer, opponent) {
  const unknown = opponent.cards.findIndex((card) => card && !aiPlayer.memory.has(card.id));
  return unknown >= 0 ? unknown : randomIndex(opponent.cards);
}

function chooseAiSwapPlan(aiIndex) {
  const game = state.game;
  const aiPlayer = game.players[aiIndex];
  const ownIndex = pickWorstKnownCard(aiPlayer);
  const opponentIndex = mostThreateningOpponentIndex(aiIndex);
  if (ownIndex < 0 || opponentIndex < 0) return null;
  const opponent = game.players[opponentIndex];
  let bestOpponentCard = -1;
  let bestOpponentValue = Infinity;
  opponent.cards.forEach((card, index) => {
    if (!card) return;
    const value = aiPlayer.memory.has(card.id) ? cardValue(card) : 6.5;
    if (value < bestOpponentValue) {
      bestOpponentCard = index;
      bestOpponentValue = value;
    }
  });
  if (bestOpponentCard < 0) return null;
  const ownValue = estimatedCardValue(aiPlayer, aiPlayer.cards[ownIndex]);
  return {
    own: { playerIndex: aiIndex, cardIndex: ownIndex },
    opponent: { playerIndex: opponentIndex, cardIndex: bestOpponentCard },
    margin: ownValue - bestOpponentValue
  };
}

function nextOpponentIndex() {
  const game = state.game;
  return game.players.findIndex((p, i) => i !== game.currentPlayer && !p.protected);
}

function randomIndex(array) {
  const filled = array.map((card, index) => card ? index : -1).filter((index) => index >= 0);
  if (!filled.length) return -1;
  return filled[Math.floor(Math.random() * filled.length)];
}

function canHumanAct() {
  const game = state.game;
  if (!game || !isLocalTurn(game)) return false;
  if (game.actionHoldUntil > Date.now()) return false;
  if (isAnimating(game)) return false;
  if (isReadyPhase(game) || game.phase === "revealing" || game.phase === "complete") return false;
  return true;
}

function resetTurnTimer(game = state.game) {
  if (game) {
    game.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    lastWarningSecond = null;
  }
}

function playTimerWarning(game = state.game) {
  if (!game || isReadyPhase(game) || state.modal?.type === "end") return;
  const secondsLeft = Math.max(0, Math.ceil((game.turnEndsAt - Date.now()) / 1000));
  if (secondsLeft > 5 || secondsLeft === lastWarningSecond) return;
  lastWarningSecond = secondsLeft;
  bloop("warning", secondsLeft);
}

function isCardVisible(game, playerIndex, cardIndex) {
  const card = game.players[playerIndex].cards[cardIndex];
  if (!card) return false;
  if (isOnlineGame(game) && card.rank && !card.hidden) return true;
  if (state.modal?.type === "end") return true;
  if (game.phase === "revealing" || game.phase === "complete") return true;
  if (isReadyPhase(game) && isLocalPlayerIndex(playerIndex, game) && !game.readyPlayers.has(playerIndex) && cardIndex >= 2) return true;
  return (game.visibleToHuman.get(card.id) || 0) > Date.now();
}

function startTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    state.now = Date.now();
    let needsRender = false;
    const game = state.game;
    if (game && state.screen === "game" && !state.modal) {
      const shoutCount = game.kabooShouts?.length || 0;
      game.kabooShouts = (game.kabooShouts || []).filter((shout) => shout.expiresAt > Date.now());
      if (game.kabooShouts.length !== shoutCount) needsRender = true;
      if (game.kabooNotice?.expiresAt <= Date.now()) {
        game.kabooNotice = null;
        needsRender = true;
      }
      if (game.snapNotice?.expiresAt <= Date.now()) {
        game.snapNotice = null;
        needsRender = true;
      }
      if (isOnlineGame(game)) {
        const hadAnimations = game.animations.length > 0;
        game.animations = game.animations.filter((animation) => animation.expiresAt > Date.now());
        if (hadAnimations) {
          refreshOnlineAnimationHides(game);
          needsRender = true;
        }
        if (needsRender) render();
        return;
      }
      if (game.phase === "revealing" || game.phase === "complete") {
        const hadAnimations = game.animations.length > 0;
        game.animations = game.animations.filter((animation) => animation.expiresAt > Date.now());
        if (hadAnimations && game.animations.length === 0) needsRender = true;
        if (hadAnimations && game.animations.length > 0) return;
      } else if (isReadyPhase(game)) {
        if (Date.now() >= game.readyEndsAt) {
          game.players.forEach((_, index) => game.readyPlayers.add(index));
          beginTurns(game);
          needsRender = true;
        }
      } else if (!game.kabooHold) {
        playTimerWarning(game);
        if (Date.now() >= game.turnEndsAt) {
          timeoutTurn();
          needsRender = true;
        }
      }
      const hadAnimations = game.animations.length > 0;
      game.animations = game.animations.filter((animation) => animation.expiresAt > Date.now());
      if (hadAnimations && game.animations.length === 0 && !game.animationLock) {
        scheduleAiSnap();
        scheduleAiTurn();
        needsRender = true;
      }
      if (hadAnimations && game.animations.length > 0) return;
    }
    if (state.modal?.type === "end" && state.game?.leaveAt && Date.now() >= state.game.leaveAt) {
      state.modal = null;
      state.game = null;
      state.screen = "title";
      needsRender = true;
    }
    if (needsRender) render();
  }, 500);
}

function scheduleAiTurn() {
  if (aiTimer) clearTimeout(aiTimer);
  const game = state.game;
  if (!game || game.kabooHold || isReadyPhase(game) || game.phase === "revealing" || game.phase === "complete" || isLocalTurn(game) || isAnimating(game) || game.pendingAction || state.modal?.type === "end") return;
  const delay = 2000 + Math.floor(Math.random() * 2000);
  aiTimer = setTimeout(() => {
    aiTimer = null;
    if (!state.game || isAnimating(state.game)) return;
    aiTurn();
  }, delay);
}

function cancelQueuedAiActions() {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (snapTimer) {
    clearTimeout(snapTimer);
    snapTimer = null;
  }
}

function addAnimation(from, to, card, options = {}) {
  const game = state.game;
  if (!game) return;
  const startFace = options.startFace || "down";
  const endFace = options.endFace || startFace;
  const duration = options.duration || MOVE_MS;
  const cutoff = options.cutoff ?? (duration === SNAP_MOVE_MS ? SNAP_ANIMATION_CUTOFF_MS : ANIMATION_CUTOFF_MS);
  const visibleDuration = Math.max(300, duration - cutoff);
  const id = crypto.randomUUID();
  game.animations.push({
    id,
    from: positionForTarget(from),
    to: positionForTarget(to),
    startFace,
    endFace,
    red: card?.suit?.color === "red",
    rank: card?.rank || "",
    glyph: card?.suit?.glyph || "",
    label: card ? cardLabel(card) : "K",
    duration,
    flipDelay: Math.max(200, Math.floor((duration - 1500) / 2)),
    expiresAt: Date.now() + visibleDuration
  });
  const animation = game.animations[game.animations.length - 1];
  animation.mid = {
    x: (animation.from.x + animation.to.x) / 2,
    y: (animation.from.y + animation.to.y) / 2
  };
  setTimeout(() => {
    if (state.game !== game) return;
    const before = game.animations.length;
    game.animations = game.animations.filter((item) => item.id !== id);
    if (before !== game.animations.length && !game.animationLock) render();
  }, visibleDuration);
}

function clearAnimations(game = state.game) {
  if (game) game.animations = [];
}

function hideSlot(playerIndex, cardIndex, game = state.game) {
  if (game) game.hiddenSlots.add(`${playerIndex}:${cardIndex}`);
}

function clearHiddenSlots(game = state.game) {
  if (game) game.hiddenSlots.clear();
}

function isSlotHidden(game, playerIndex, cardIndex) {
  return Boolean(game?.hiddenSlots?.has(`${playerIndex}:${cardIndex}`));
}

function hidePile(pile, game = state.game) {
  if (game && pile) game.hiddenPiles.add(pile);
}

function clearHiddenPiles(game = state.game) {
  if (game) game.hiddenPiles.clear();
}

function isPileHidden(pile, game = state.game) {
  return Boolean(game?.hiddenPiles?.has(pile));
}

function isAnimating(game = state.game) {
  return Boolean(game && (game.animationLock || game.animations.length));
}

function positionForTarget(target, game = state.game) {
  if (target === "deck") return { x: 47, y: 50 };
  if (target === "discard") return { x: 55, y: 50 };
  if (target === "pile") {
    const source = game?.source;
    return source === "discard" ? positionForTarget("discard") : positionForTarget("deck");
  }
  if (target && typeof target === "object") {
    const hand = getHandPosition(target.playerIndex, game.players.length);
    if (isLocalPlayerIndex(target.playerIndex, game)) {
      const offset = slotOffset(target.cardIndex, true);
      return { x: 50 + offset.x, y: 86 + offset.y };
    }
    const offset = slotOffset(target.cardIndex, false);
    return { x: hand.left + offset.x, y: hand.top + offset.y };
  }
  return { x: 50, y: 50 };
}

function lastFilledIndex(cards) {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    if (cards[index]) return index;
  }
  return -1;
}

function firstEmptySlotIndex(cards) {
  const index = cards.findIndex((card) => !card);
  return index >= 0 ? index : cards.length;
}

function placeCardInHand(player, card) {
  const index = firstEmptySlotIndex(player.cards);
  player.cards[index] = card;
  return index;
}

function ensureDeck() {
  const game = state.game;
  if (!game) return false;
  if (game.deck.length) return true;
  if (!game.discard.length) return false;
  game.deck = shuffle(game.discard.splice(0));
  game.log.push("The discard pile was shuffled into a fresh deck.");
  game.message = "The discard pile becomes the deck.";
  return true;
}

function rememberCard(player, card) {
  if (player?.memory && card) player.memory.add(card.id);
}

function rememberDiscard(card) {
  const game = state.game;
  if (!game || !card) return;
  game.players.forEach((player) => rememberCard(player, card));
}

function scheduleAiSnap() {
  const game = state.game;
  if (!game || !game.discard.length || state.modal?.type === "end" || isAnimating(game)) return;
  if (snapTimer) clearTimeout(snapTimer);
  const top = last(game.discard);
  if (game.snapLockedDiscardId === top.id) return;
  const candidates = [];
  game.players.forEach((player, snappingPlayerIndex) => {
    if (!player.ai) return;
    game.players.forEach((owner, ownerIndex) => {
      if (owner.protected) return;
      owner.cards.forEach((card, cardIndex) => {
        if (
          card &&
          card.rank === top.rank &&
          !game.snappedCardIds.has(card.id) &&
          player.memory.has(card.id) &&
          shouldAiSnapCandidate(player, snappingPlayerIndex, ownerIndex, card)
        ) {
          candidates.push({ snappingPlayerIndex, ownerIndex, cardIndex });
        }
      });
    });
  });
  if (!candidates.length) return;
  const owned = candidates.find((candidate) => candidate.snappingPlayerIndex === candidate.ownerIndex);
  const choice = owned || candidates[Math.floor(Math.random() * candidates.length)];
  const delay = 650 + Math.floor(Math.random() * 1050);
  const targetId = game.players[choice.ownerIndex].cards[choice.cardIndex]?.id;
  snapTimer = setTimeout(() => {
    if (!state.game || isAnimating(state.game) || state.game.snapLockedDiscardId === top.id || last(state.game.discard)?.id !== top.id) return;
    const owner = state.game.players[choice.ownerIndex];
    const currentIndex = owner.cards.findIndex((card) => card.id === targetId);
    if (currentIndex >= 0) attemptSnap(choice.snappingPlayerIndex, choice.ownerIndex, currentIndex);
    render();
  }, delay);
}

function shouldAiSnapCandidate(aiPlayer, snappingPlayerIndex, ownerIndex, targetCard) {
  const value = cardValue(targetCard);
  if (snappingPlayerIndex === ownerIndex) return value >= 3;
  const giveIndex = pickWorstKnownCard(aiPlayer);
  const giveValue = giveIndex >= 0 ? estimatedCardValue(aiPlayer, aiPlayer.cards[giveIndex]) : 0;
  return giveValue >= 8 || (giveValue - value >= 5 && value > 1);
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
  return `${card.rank}${suitSymbol(card.suit)}`;
}

function handLabels(cards) {
  return cards.map((card) => card ? cardLabel(card) : "--").join(" ");
}

function suitSymbol(suit) {
  return ({ S: "♠", H: "♥", D: "♦", C: "♣" })[suit.id] || "";
}

function isCleanUsername(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
  if (!normalized.trim()) return false;
  return !BLOCKED_WORDS.some((word) => normalized.includes(word) || levenshtein(normalized, word) <= 1);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function bloop(kind, value = 0) {
  const volume = state.settings.sfx / 100;
  if (!volume) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  if (kind === "streamer") {
    const whistle = ctx.createOscillator();
    const whistleGain = ctx.createGain();
    whistle.type = "triangle";
    whistle.frequency.setValueAtTime(520, ctx.currentTime);
    whistle.frequency.exponentialRampToValueAtTime(980, ctx.currentTime + 0.2);
    whistleGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    whistleGain.gain.exponentialRampToValueAtTime(0.14 * volume, ctx.currentTime + 0.025);
    whistleGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    whistle.connect(whistleGain).connect(ctx.destination);
    whistle.start();
    whistle.stop(ctx.currentTime + 0.34);

    const pop = ctx.createOscillator();
    const popGain = ctx.createGain();
    pop.type = "square";
    pop.frequency.setValueAtTime(180, ctx.currentTime + 0.18);
    pop.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.28);
    popGain.gain.setValueAtTime(0.0001, ctx.currentTime + 0.16);
    popGain.gain.exponentialRampToValueAtTime(0.09 * volume, ctx.currentTime + 0.19);
    popGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    pop.connect(popGain).connect(ctx.destination);
    pop.start(ctx.currentTime + 0.16);
    pop.stop(ctx.currentTime + 0.31);
    return;
  }
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  const start = kind === "kaboo" ? 120 : kind === "warning" ? 420 + ((5 - value) * 55) : 360;
  const end = kind === "kaboo" ? 260 : kind === "warning" ? start * 1.18 : 540;
  osc.frequency.setValueAtTime(start, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(end, ctx.currentTime + 0.11);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime((kind === "warning" ? 0.1 : 0.18) * volume, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (kind === "kaboo" ? 0.38 : 0.13));
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + (kind === "kaboo" ? 0.4 : 0.15));
}

function toast(message) {
  state.toast = message;
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = "";
      render();
    }
  }, 1800);
}

function last(array) {
  return array[array.length - 1];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

document.addEventListener("pointerdown", () => {
  pointerActive = true;
}, { capture: true });

document.addEventListener("pointerup", () => {
  pointerActive = false;
  if (pendingRender) {
    pendingRender = false;
    setTimeout(() => render({ force: true }), 0);
  }
}, { capture: true });

document.addEventListener("pointercancel", () => {
  pointerActive = false;
  pendingRender = false;
}, { capture: true });

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
} else if ("serviceWorker" in navigator && import.meta.env.DEV) {
  navigator.serviceWorker.getRegistrations?.().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  }).catch(() => {});
}

render();

