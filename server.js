const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function activePlayers(state) {
  return state.players.filter(p => !p.folded);
}

function actingPlayers(state) {
  return state.players.filter(p => !p.folded && !p.allIn && !p.disconnected);
}

function nextActingIndex(state, fromIndex) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    if (state.needToAct.includes(idx)) return idx;
  }
  return -1;
}

function collectBets(state) {
  state.players.forEach(p => {
    state.pot += p.bet;
    p.bet = 0;
  });
  state.currentBet = 0;
}

function checkRoundComplete(state) {
  // Remove from needToAct anyone folded or all-in
  state.needToAct = state.needToAct.filter(i => {
    const p = state.players[i];
    return p && !p.folded && !p.allIn && !p.disconnected;
  });

  const alive = activePlayers(state);
  if (alive.length <= 1) {
    collectBets(state);
    state.currentPlayerIndex = -1;
    if (alive.length === 1) {
      alive[0].stack += state.pot;
      state.log.push(`${alive[0].name} vince ${state.pot} (tutti hanno passato)`);
      state.pot = 0;
    }
    state.phase = 'showdown';
    return;
  }

  if (state.needToAct.length === 0) {
    collectBets(state);
    state.currentPlayerIndex = -1;
    if (state.phase === 'river') state.phase = 'showdown';
    return;
  }

  // Advance to next player who needs to act
  const next = nextActingIndex(state, state.currentPlayerIndex);
  state.currentPlayerIndex = next !== -1 ? next : -1;
}

function startHand(state) {
  const n = state.players.length;
  state.handNumber++;
  state.pot = 0;
  state.phase = 'preflop';
  state.log = [`--- Mano #${state.handNumber} ---`];

  state.players.forEach(p => {
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
  });

  state.dealerIndex = (state.dealerIndex + 1) % n;
  state.log.push(`Dealer: ${state.players[state.dealerIndex].name}`);

  const sbIdx = (state.dealerIndex + 1) % n;
  const bbIdx = (state.dealerIndex + 2) % n;

  const sb = state.players[sbIdx];
  const bb = state.players[bbIdx];

  const sbAmt = Math.min(state.smallBlind, sb.stack);
  sb.stack -= sbAmt;
  sb.bet = sbAmt;
  if (sb.stack === 0) sb.allIn = true;

  const bbAmt = Math.min(state.bigBlind, bb.stack);
  bb.stack -= bbAmt;
  bb.bet = bbAmt;
  if (bb.stack === 0) bb.allIn = true;

  state.currentBet = bbAmt;
  state.log.push(`${sb.name} posta SB ${sbAmt}`);
  state.log.push(`${bb.name} posta BB ${bbAmt}`);

  // needToAct: everyone (including BB for their option)
  state.needToAct = state.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.folded && !p.allIn && !p.disconnected)
    .map(({ i }) => i);

  // UTG acts first (or dealer in heads-up)
  const utgIdx = n === 2 ? state.dealerIndex : (bbIdx + 1) % n;
  state.currentPlayerIndex = state.needToAct.includes(utgIdx)
    ? utgIdx
    : nextActingIndex(state, bbIdx);

  checkRoundComplete(state);
}

function advanceStreet(state) {
  const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const idx = order.indexOf(state.phase);
  if (idx < 0 || idx >= order.length - 1) return;

  state.phase = order[idx + 1];
  state.log.push(`--- ${state.phase.toUpperCase()} ---`);

  if (state.phase === 'showdown') {
    state.currentPlayerIndex = -1;
    return;
  }

  state.players.forEach(p => { p.bet = 0; });
  state.currentBet = 0;

  state.needToAct = state.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.folded && !p.allIn && !p.disconnected)
    .map(({ i }) => i);

  if (state.needToAct.length === 0) {
    state.currentPlayerIndex = -1;
    return;
  }

  // First to act post-flop: first active player left of dealer
  const n = state.players.length;
  let first = -1;
  for (let i = 1; i <= n; i++) {
    const idx = (state.dealerIndex + i) % n;
    if (state.needToAct.includes(idx)) { first = idx; break; }
  }
  state.currentPlayerIndex = first;
}

function emitAll(state) {
  const sockets = io.sockets.adapter.rooms.get(state.roomId);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('game_state', { ...state, myId: sid });
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }) => {
    const roomId = generateRoomId();
    const state = {
      roomId,
      adminId: socket.id,
      phase: 'waiting',
      players: [{
        id: socket.id, name, stack: 0, bet: 0,
        folded: false, allIn: false, disconnected: false, isAdmin: true
      }],
      pot: 0, currentBet: 0, currentPlayerIndex: -1,
      dealerIndex: -1, smallBlind: 10, bigBlind: 20,
      needToAct: [], handNumber: 0, log: []
    };
    rooms.set(roomId, state);
    socket.join(roomId);
    socket.emit('room_created', { roomId });
    emitAll(state);
  });

  socket.on('join_room', ({ roomId, name }) => {
    const state = rooms.get(roomId.toUpperCase().trim());
    if (!state) { socket.emit('error_msg', 'Stanza non trovata'); return; }
    if (state.phase !== 'waiting') { socket.emit('error_msg', 'Partita già in corso'); return; }
    if (state.players.length >= 9) { socket.emit('error_msg', 'Stanza piena (max 9)'); return; }
    if (state.players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('error_msg', 'Nome già in uso'); return;
    }
    state.players.push({
      id: socket.id, name, stack: 0, bet: 0,
      folded: false, allIn: false, disconnected: false, isAdmin: false
    });
    socket.join(state.roomId);
    socket.emit('room_joined', { roomId: state.roomId });
    emitAll(state);
  });

  socket.on('start_game', ({ roomId, startingStack, smallBlind, bigBlind }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;
    if (state.players.length < 2) { socket.emit('error_msg', 'Servono almeno 2 giocatori'); return; }

    state.smallBlind = Math.max(1, Number(smallBlind) || 10);
    state.bigBlind = Math.max(2, Number(bigBlind) || 20);
    const stack = Math.max(1, Number(startingStack) || 1000);
    state.players.forEach(p => { p.stack = stack; });
    state.dealerIndex = state.players.length - 1;
    startHand(state);
    emitAll(state);
  });

  socket.on('player_action', ({ roomId, action, amount }) => {
    const state = rooms.get(roomId);
    if (!state) return;

    const playerIdx = state.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== state.currentPlayerIndex) {
      socket.emit('error_msg', 'Non è il tuo turno'); return;
    }

    const player = state.players[playerIdx];
    state.needToAct = state.needToAct.filter(i => i !== playerIdx);

    switch (action) {
      case 'fold':
        player.folded = true;
        state.log.push(`${player.name} passa`);
        break;

      case 'check':
        if (player.bet < state.currentBet) {
          socket.emit('error_msg', 'Non puoi checkare: devi chiamare o rilanciare');
          state.needToAct.push(playerIdx);
          return;
        }
        state.log.push(`${player.name} checka`);
        break;

      case 'call': {
        const toCall = Math.min(state.currentBet - player.bet, player.stack);
        player.stack -= toCall;
        player.bet += toCall;
        if (player.stack === 0) player.allIn = true;
        state.log.push(`${player.name} chiama ${toCall}${player.allIn ? ' (all-in)' : ''}`);
        break;
      }

      case 'raise': {
        const raiseTo = Number(amount);
        const minRaise = state.currentBet + state.bigBlind;
        if (raiseTo < minRaise && raiseTo < player.stack + player.bet) {
          socket.emit('error_msg', `Rilancio minimo: ${minRaise}`);
          state.needToAct.push(playerIdx);
          return;
        }
        const add = Math.min(raiseTo - player.bet, player.stack);
        player.stack -= add;
        player.bet += add;
        state.currentBet = player.bet;
        if (player.stack === 0) player.allIn = true;
        // Everyone else needs to act again
        state.needToAct = state.players
          .map((p, i) => ({ p, i }))
          .filter(({ p, i }) => i !== playerIdx && !p.folded && !p.allIn && !p.disconnected)
          .map(({ i }) => i);
        state.log.push(`${player.name} rilancia a ${player.bet}${player.allIn ? ' (all-in)' : ''}`);
        break;
      }

      case 'all_in': {
        const allInAdd = player.stack;
        player.stack = 0;
        player.bet += allInAdd;
        player.allIn = true;
        if (player.bet > state.currentBet) {
          state.currentBet = player.bet;
          state.needToAct = state.players
            .map((p, i) => ({ p, i }))
            .filter(({ p, i }) => i !== playerIdx && !p.folded && !p.allIn && !p.disconnected)
            .map(({ i }) => i);
        }
        state.log.push(`${player.name} va all-in: ${player.bet}`);
        break;
      }

      default:
        state.needToAct.push(playerIdx);
        return;
    }

    checkRoundComplete(state);
    emitAll(state);
  });

  socket.on('next_street', ({ roomId }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;
    if (state.currentPlayerIndex !== -1) {
      socket.emit('error_msg', 'Aspetta che il turno finisca'); return;
    }
    advanceStreet(state);
    emitAll(state);
  });

  socket.on('declare_winner', ({ roomId, winnerIds }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;

    const totalPot = state.pot;
    const share = Math.floor(totalPot / winnerIds.length);
    const rem = totalPot % winnerIds.length;

    winnerIds.forEach((wId, i) => {
      const w = state.players.find(p => p.id === wId);
      if (w) {
        const won = share + (i === 0 ? rem : 0);
        w.stack += won;
        state.log.push(`${w.name} vince ${won}`);
      }
    });

    state.pot = 0;
    state.phase = 'showdown';
    state.currentPlayerIndex = -1;
    emitAll(state);
  });

  socket.on('next_hand', ({ roomId }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;
    // Remove players with 0 chips (unless they're the only ones)
    const withChips = state.players.filter(p => p.stack > 0);
    if (withChips.length >= 2) state.players = withChips;
    startHand(state);
    emitAll(state);
  });

  socket.on('add_chips', ({ roomId, playerId, amount }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;
    const p = state.players.find(pl => pl.id === playerId);
    if (p) {
      p.stack += Number(amount);
      state.log.push(`${p.name} rebuy +${amount}`);
    }
    emitAll(state);
  });

  socket.on('kick_player', ({ roomId, playerId }) => {
    const state = rooms.get(roomId);
    if (!state || state.adminId !== socket.id) return;
    if (state.phase !== 'waiting') { socket.emit('error_msg', 'Puoi rimuovere giocatori solo in lobby'); return; }
    state.players = state.players.filter(p => p.id !== playerId);
    emitAll(state);
  });

  socket.on('disconnect', () => {
    rooms.forEach((state) => {
      const idx = state.players.findIndex(p => p.id === socket.id);
      if (idx === -1) return;
      const player = state.players[idx];
      if (state.phase === 'waiting') {
        state.players.splice(idx, 1);
      } else {
        player.disconnected = true;
        if (!player.folded && !player.allIn) {
          player.folded = true;
          state.needToAct = state.needToAct.filter(i => i !== idx);
          if (state.currentPlayerIndex === idx) checkRoundComplete(state);
        }
      }
      emitAll(state);
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Poker server on port ${PORT}`));
