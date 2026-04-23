const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Phase definitions (authoritative list) ───────────────────────────────────
const PHASES = [
  { id: 'untap',     name: 'Untap',            group: 'Beginning',   defaultTime: 10  },
  { id: 'upkeep',   name: 'Upkeep',           group: 'Beginning',   defaultTime: 30  },
  { id: 'draw',     name: 'Draw',             group: 'Beginning',   defaultTime: 15  },
  { id: 'main1',    name: 'Main Phase 1',      group: 'Pre-Combat',  defaultTime: 90  },
  { id: 'boc',      name: 'Begin Combat',      group: 'Combat',      defaultTime: 15  },
  { id: 'attackers',name: 'Declare Attackers', group: 'Combat',      defaultTime: 30  },
  { id: 'blockers', name: 'Declare Blockers',  group: 'Combat',      defaultTime: 30  },
  { id: 'damage',   name: 'Combat Damage',     group: 'Combat',      defaultTime: 20  },
  { id: 'eoc',      name: 'End of Combat',     group: 'Combat',      defaultTime: 10  },
  { id: 'main2',    name: 'Main Phase 2',      group: 'Post-Combat', defaultTime: 60  },
  { id: 'end',      name: 'End Step',          group: 'Ending',      defaultTime: 20  },
  { id: 'cleanup',  name: 'Cleanup',           group: 'Ending',      defaultTime: 10  },
];

const PLAYER_COLORS = ['#f5a623', '#4caf50', '#2196f3', '#9c27b0', '#f44336'];

// ─── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return sessions.has(code) ? generateCode() : code;
}

function defaultSettings() {
  return {
    phaseTimes: Object.fromEntries(PHASES.map(p => [p.id, p.defaultTime])),
    skipZero: true,
  };
}

function createSession(hostId, hostName) {
  const code = generateCode();
  const session = {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, color: PLAYER_COLORS[0] }],
    settings: defaultSettings(),
    state: {
      phaseIndex: 0,
      timeLeft: 0,
      paused: false,
      currentPlayerIndex: 0,
      running: false,
      started: false,
      turnCount: 1,
    },
    intervalId: null,
    // Auto-cleanup after 3 hours of inactivity
    cleanupTimer: setTimeout(() => cleanupSession(code), 3 * 60 * 60 * 1000),
  };
  sessions.set(code, session);
  return session;
}

function cleanupSession(code) {
  const session = sessions.get(code);
  if (!session) return;
  if (session.intervalId) clearInterval(session.intervalId);
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  sessions.delete(code);
}

function resetCleanupTimer(session) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => cleanupSession(session.code), 3 * 60 * 60 * 1000);
}

// ─── Timer logic (server-authoritative) ───────────────────────────────────────
function broadcastState(session) {
  io.to(session.code).emit('state_update', { ...session.state });
}

function stopTimer(session) {
  if (session.intervalId) {
    clearInterval(session.intervalId);
    session.intervalId = null;
  }
}

function startPhase(session, phaseIndex) {
  stopTimer(session);
  const phase = PHASES[phaseIndex];
  const duration = session.settings.phaseTimes[phase.id];

  if (session.settings.skipZero && duration === 0) {
    const next = phaseIndex + 1;
    if (next >= PHASES.length) { endTurn(session); return; }
    startPhase(session, next);
    return;
  }

  session.state.phaseIndex = phaseIndex;
  session.state.timeLeft = duration;
  session.state.paused = false;
  session.state.running = true;
  broadcastState(session);
  resetCleanupTimer(session);

  if (duration > 0) {
    session.intervalId = setInterval(() => tick(session), 1000);
  }
}

function tick(session) {
  if (session.state.paused) return;
  session.state.timeLeft = Math.max(0, session.state.timeLeft - 1);

  // Sound cues broadcast to all clients
  if (session.state.timeLeft === 0) {
    io.to(session.code).emit('sound_event', { type: 'phase_end' });
    stopTimer(session);
    session.state.running = false;
  } else if (session.state.timeLeft <= 10) {
    io.to(session.code).emit('sound_event', { type: 'warning_beep' });
  }

  broadcastState(session);
}

function advancePhase(session) {
  stopTimer(session);
  io.to(session.code).emit('sound_event', { type: 'advance' });
  const next = session.state.phaseIndex + 1;
  if (next >= PHASES.length) { endTurn(session); return; }
  startPhase(session, next);
}

function endTurn(session) {
  stopTimer(session);
  session.state.running = false;
  const fromIndex = session.state.currentPlayerIndex;
  const toIndex = (fromIndex + 1) % session.players.length;
  io.to(session.code).emit('turn_ended', {
    fromPlayerIndex: fromIndex,
    toPlayerIndex: toIndex,
    state: session.state,
  });
  io.to(session.code).emit('sound_event', { type: 'turn_end' });
}

function startNextTurn(session) {
  session.state.currentPlayerIndex = (session.state.currentPlayerIndex + 1) % session.players.length;
  session.state.turnCount++;
  io.to(session.code).emit('turn_started');
  startPhase(session, 0);
}

// ─── Helper: can this socket control the session? ────────────────────────────
function canControl(session, socketId) {
  if (socketId === session.hostId) return true;
  const activePlayer = session.players[session.state.currentPlayerIndex];
  return activePlayer && activePlayer.id === socketId;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentCode = null;

  socket.on('create_session', ({ playerName }) => {
    const name = (playerName || 'Host').trim().slice(0, 24);
    const session = createSession(socket.id, name);
    currentCode = session.code;
    socket.join(session.code);
    socket.emit('session_created', {
      code: session.code,
      playerId: socket.id,
      playerIndex: 0,
      players: session.players,
      settings: session.settings,
      state: session.state,
      phases: PHASES,
    });
  });

  socket.on('join_session', ({ code, playerName }) => {
    const session = sessions.get((code || '').toUpperCase().trim());
    if (!session) { socket.emit('join_error', { message: 'Session not found. Check the code.' }); return; }
    if (session.players.length >= 5) { socket.emit('join_error', { message: 'Session is full (max 5 players).' }); return; }
    if (session.players.find(p => p.id === socket.id)) { socket.emit('join_error', { message: 'Already in this session.' }); return; }

    const idx = session.players.length;
    const name = (playerName || `Player ${idx + 1}`).trim().slice(0, 24);
    session.players.push({ id: socket.id, name, color: PLAYER_COLORS[idx] });

    currentCode = session.code;
    socket.join(session.code);

    socket.emit('session_joined', {
      code: session.code,
      playerId: socket.id,
      playerIndex: idx,
      players: session.players,
      settings: session.settings,
      state: session.state,
      phases: PHASES,
    });
    io.to(session.code).emit('players_update', { players: session.players });
    resetCleanupTimer(session);
  });

  socket.on('start_game', ({ code }) => {
    const session = sessions.get(code);
    if (!session || session.hostId !== socket.id) return;
    if (session.state.started) return;
    session.state.started = true;
    io.to(session.code).emit('game_started');
    startPhase(session, 0);
  });

  socket.on('advance_phase', ({ code }) => {
    const session = sessions.get(code);
    if (!session || !canControl(session, socket.id)) return;
    advancePhase(session);
  });

  socket.on('restart_phase', ({ code }) => {
    const session = sessions.get(code);
    if (!session || !canControl(session, socket.id)) return;
    startPhase(session, session.state.phaseIndex);
    io.to(session.code).emit('sound_event', { type: 'restart' });
  });

  socket.on('toggle_pause', ({ code }) => {
    const session = sessions.get(code);
    if (!session || !canControl(session, socket.id)) return;
    session.state.paused = !session.state.paused;
    if (!session.state.paused && session.state.timeLeft > 0 && !session.intervalId) {
      session.state.running = true;
      session.intervalId = setInterval(() => tick(session), 1000);
    }
    broadcastState(session);
  });

  socket.on('start_next_turn', ({ code }) => {
    const session = sessions.get(code);
    if (!session) return;
    startNextTurn(session);
  });

  socket.on('update_settings', ({ code, settings }) => {
    const session = sessions.get(code);
    if (!session || session.hostId !== socket.id) return;
    if (settings.phaseTimes) {
      // Clamp each value 0–600
      for (const [k, v] of Object.entries(settings.phaseTimes)) {
        session.settings.phaseTimes[k] = Math.max(0, Math.min(600, Number(v) || 0));
      }
    }
    if (typeof settings.skipZero === 'boolean') session.settings.skipZero = settings.skipZero;
    io.to(session.code).emit('settings_update', { settings: session.settings });
  });

  socket.on('disconnect', () => {
    if (!currentCode) return;
    const session = sessions.get(currentCode);
    if (!session) return;

    session.players = session.players.filter(p => p.id !== socket.id);

    if (session.players.length === 0) { cleanupSession(currentCode); return; }

    if (session.hostId === socket.id) {
      session.hostId = session.players[0].id;
      io.to(session.code).emit('host_changed', { newHostId: session.hostId });
    }

    if (session.state.currentPlayerIndex >= session.players.length) {
      session.state.currentPlayerIndex = 0;
    }

    io.to(session.code).emit('players_update', { players: session.players });
    broadcastState(session);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`MTG Timer running on http://localhost:${PORT}`));
