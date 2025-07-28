const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Import the mock players.  For now the project does not depend on any
// external API; all data is contained within this file.  Each entry
// contains a name, club and optional image URL.
const mockPlayers = require('./mockPlayers');

// In‑memory store for all rooms.  Because persistence is not
// required, everything lives in memory and is lost when the server
// restarts.  Each room will have a unique id, a list of players
// (with id, name, role, assigned player and alive flag), a state
// machine, collections for clues and votes, a creator id and
// structures to support communal actions.  When players confirm
// actions like starting a game or moving to the next phase, their
// ids are recorded in the corresponding list within
// `confirmations`.  The server compares the number of confirmations
// with the required number of participants (alive players or all
// players depending on the action) and automatically triggers the
// transition when enough confirmations have been gathered.  The
// creator (host) can also force an action regardless of how many
// confirmations have been collected via the /force endpoint.
const rooms = {};

/**
 * Helper to compute the required number of confirmations for a given
 * action.  Some actions involve only the alive players (e.g. moving
 * from clues to voting or starting a new clue round) while others
 * require participation from all players (e.g. starting a game or
 * initiating a new round).  Eliminated players (alive === false)
 * remain in the room but do not count towards the required count for
 * actions involving only active gameplay.
 *
 * @param {Object} room The room object
 * @param {string} action One of 'start', 'votePhase', 'nextClue', 'nextRound'
 */
function requiredConfirmations(room, action) {
  switch (action) {
    case 'start':
      // At the beginning all players are alive; this uses the total count
      return room.players.length;
    case 'votePhase':
    case 'nextClue':
      // Only alive players participate in clue and vote phases
      return room.players.filter(p => p.alive).length;
    case 'showResults':
      // To reveal results we require confirmations from all alive players.  Eliminated
      // participants no longer take an active role, so they are excluded from the
      // required count.  This ensures that results are only computed when every
      // surviving player agrees to see them.
      return room.players.filter(p => p.alive).length;
    case 'nextRound':
      // Everyone (alive or eliminated) must opt in for a new game
      return room.players.length;
    default:
      return 0;
  }
}

/**
 * Assign roles and a soccer player to all alive participants at the
 * beginning of a round.  One of the alive players becomes the
 * impostor and the rest receive the same soccer player.  Eliminated
 * players retain their previous role (null) and assigned player.
 *
 * @param {Object} room The room to initialise
 */
function assignRolesForRound(room) {
  // Choose a soccer player randomly and assign to all alive players
  const soccerPlayer = randomElement(mockPlayers);
  room.soccerPlayer = soccerPlayer;
  // Pick a random alive player as the impostor
  const aliveIndices = room.players
    .map((p, idx) => (p.alive ? idx : null))
    .filter(idx => idx !== null);
  const impostorIndex = aliveIndices[Math.floor(Math.random() * aliveIndices.length)];
  room.players.forEach((p, idx) => {
    if (!p.alive) {
      // Eliminated players retain null role and assigned player
      p.role = null;
      p.assignedPlayer = null;
      return;
    }
    if (idx === impostorIndex) {
      p.role = 'impostor';
      p.assignedPlayer = null;
    } else {
      p.role = 'player';
      p.assignedPlayer = soccerPlayer;
    }
  });
}

/**
 * Reset the room to begin a completely new game.  All players are
 * marked alive, roles and assignments are cleared, clues and votes
 * emptied and confirmations reset.  A new round is immediately
 * initialised and the state is set to 'clues'.  This function is
 * called when a new round is started after the game is over.
 *
 * @param {Object} room The room to reset
 */
function startNewGame(room) {
  // Bring all players back to life and clear previous roles/assignments
  room.players.forEach(p => {
    p.alive = true;
    p.role = null;
    p.assignedPlayer = null;
  });
  // Clear clues and votes
  room.clues = [];
  room.votes = [];
  // Reset result flags
  room.gameOver = false;
  room.impostorWon = false;
  room.awaiting = null;
  room.resultsData = null;
  // Reset confirmations
  Object.keys(room.confirmations).forEach(key => {
    room.confirmations[key] = [];
  });
  // Assign roles for the first round and switch to clues phase
  assignRolesForRound(room);
  room.state = 'clues';
}

/**
 * Progress the game to the next clue round after an incorrect vote.
 * Removes the previously accused player from active play (alive=false),
 * clears clues and votes, resets confirmations and maintains the same
 * impostor and soccer player.  The state transitions back to 'clues'.
 *
 * @param {Object} room The room to update
 */
function startNextClueRound(room) {
  // Clear clues and votes for the next round
  room.clues = [];
  room.votes = [];
  // Reset confirmations
  room.confirmations.start = [];
  room.confirmations.votePhase = [];
  room.confirmations.nextClue = [];
  room.confirmations.nextRound = [];
  room.confirmations.showResults = [];
  room.awaiting = null;
  // State returns to clues
  room.state = 'clues';
}

/**
 * Progress the game from clues to voting phase.  This simply
 * transitions the state and resets vote confirmations.
 *
 * @param {Object} room The room to update
 */
function startVotePhase(room) {
  room.state = 'voting';
  room.confirmations.votePhase = [];
}

/**
 * Returns a MIME type based on file extension.  Only a handful of
 * common types are included; unknown types default to plain text.
 * @param {string} ext The file extension (including the dot)
 */
function getContentType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.js':
      return 'text/javascript';
    case '.css':
      return 'text/css';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'text/plain';
  }
}

/**
 * Serves a static file from the client directory.  The method
 * resolves the requested pathname to an absolute path within the
 * client directory and checks existence.  If a file is not found
 * the function falls back to serving `index.html` for client side
 * routing support.
 *
 * @param {string} pathname Requested path
 * @param {http.ServerResponse} res Response object
 */
function serveStatic(pathname, res) {
  const clientDir = path.join(__dirname, '../client');
  let filePath = path.join(clientDir, pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(clientDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // If file doesn't exist serve index.html (for client routing)
      filePath = path.join(clientDir, 'index.html');
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': getContentType(ext) });
      res.end(content);
    });
  });
}

/**
 * Generates a unique identifier for rooms and players.  Uses the
 * crypto module to produce a random UUID.  Should be unique
 * across server sessions.
 */
function generateId() {
  // crypto.randomUUID is available in recent versions of Node.
  // We remove dashes to create shorter ids.
  return randomUUID().replace(/-/g, '');
}

// Utility to compute results when voting ends.  Returns an object
// containing message, success flag, gameOver flag, impostorWon flag,
// a copy of votes and the list of remaining players with alive status.
function computeResults(room) {
  // Copy votes to return but do not clear them yet
  const votesCopy = room.votes.slice();
  // Compute vote counts and determine the accused player with most votes
  const counts = {};
  room.votes.forEach(v => {
    counts[v.voteForId] = (counts[v.voteForId] || 0) + 1;
  });
  let maxVotes = 0;
  let accusedId = null;
  Object.entries(counts).forEach(([pid, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      accusedId = pid;
    }
  });
  const impostor = room.players.find(p => p.role === 'impostor');
  const impostorId = impostor ? impostor.id : null;
  const success = accusedId && accusedId === impostorId;
  let gameOver = false;
  let impostorWon = false;
  let awaiting;
  if (success) {
    gameOver = true;
    impostorWon = false;
    awaiting = 'nextRound';
  } else {
    if (accusedId) {
      const accused = room.players.find(p => p.id === accusedId);
      if (accused) {
        accused.alive = false;
      }
    }
    const aliveCount = room.players.filter(p => p.alive).length;
    if (aliveCount <= 2) {
      gameOver = true;
      impostorWon = true;
      awaiting = 'nextRound';
    } else {
      gameOver = false;
      impostorWon = false;
      awaiting = 'nextClue';
    }
  }
  return {
    message: success
      ? 'El impostor fue descubierto'
      : gameOver
      ? 'El impostor gana por quedar sólo con un jugador'
      : 'El impostor no fue descubierto, próxima ronda',
    success,
    gameOver,
    impostorWon,
    votes: votesCopy,
    remainingPlayers: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive })),
    awaiting,
  };
}

/**
 * Picks a random element from an array.  Returns undefined
 * if the array is empty.
 * @param {Array} arr
 */
function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Handles API requests.  All API routes are prefixed with `/api`.
 * Each endpoint expects and returns JSON.  CORS headers are
 * configured to allow any origin to access the API (useful for
 * serving the frontend from a different origin during development).
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url Parsed URL object
 */
function handleApi(req, res, url) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/create-room') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data || !Array.isArray(data.players) || data.players.length === 0) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        const roomId = generateId();
        // Create players with alive flag
        const players = data.players.map(name => ({
          id: generateId(),
          name,
          role: null,
          assignedPlayer: null,
          alive: true,
        }));
        const room = {
          id: roomId,
          state: 'lobby',
          players,
          soccerPlayer: null,
          clues: [],
          votes: [],
          // The first player is considered creator/host
          creatorId: players[0].id,
          // Confirmation queues for communal actions
          confirmations: {
            start: [],
            votePhase: [],
            nextClue: [],
            nextRound: [],
            showResults: [],
          },
          awaiting: null,
          gameOver: false,
          impostorWon: false,
          resultsData: null,
          // Record the initial number of participants expected in this room.  This
          // prevents adding arbitrary new players beyond the original list.
          expectedPlayers: players.length,
        };
        rooms[roomId] = room;
        sendJson(201, {
          roomId,
          players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
          })),
          state: room.state,
          creatorId: room.creatorId,
        });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Start the game immediately.  This endpoint exists for backward
  // compatibility and for the host to bypass communal confirmation.  A
  // game can only be started while in lobby.  It assigns roles,
  // resets confirmations and moves the room to the clues phase.
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/start$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'lobby') {
      sendJson(400, { error: 'Game already started' });
      return;
    }
    // Reset confirmations
    Object.keys(room.confirmations).forEach(key => {
      room.confirmations[key] = [];
    });
    room.awaiting = null;
    // Prepare roles for the first round
    assignRolesForRound(room);
    room.state = 'clues';
    sendJson(200, {
      message: 'Game started',
      soccerPlayer: room.soccerPlayer
        ? { name: room.soccerPlayer.name, club: room.soccerPlayer.club }
        : null,
      players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive })),
      state: room.state,
    });
    return;
  }

  // Get room details
  if (req.method === 'GET' && pathname.match(/^\/api\/room\/[^\/]+$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    // Remove full soccer player details to avoid accidentally
    // revealing the impostor; only send name and club.
    const soccerPlayer = room.soccerPlayer
      ? { name: room.soccerPlayer.name, club: room.soccerPlayer.club }
      : null;
    sendJson(200, {
      id: room.id,
      state: room.state,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        assignedPlayer: p.assignedPlayer
          ? { name: p.assignedPlayer.name, club: p.assignedPlayer.club }
          : null,
        alive: typeof p.alive === 'boolean' ? p.alive : true,
      })),
      soccerPlayer,
      clues: room.clues,
      votes: room.votes,
      creatorId: room.creatorId,
      awaiting: room.awaiting,
      confirmationsCount: {
        start: room.confirmations.start.length,
        votePhase: room.confirmations.votePhase.length,
        nextClue: room.confirmations.nextClue.length,
        nextRound: room.confirmations.nextRound.length,
        showResults: room.confirmations.showResults ? room.confirmations.showResults.length : 0,
      },
      requiredConfirmations: {
        start: requiredConfirmations(room, 'start'),
        votePhase: requiredConfirmations(room, 'votePhase'),
        nextClue: requiredConfirmations(room, 'nextClue'),
        nextRound: requiredConfirmations(room, 'nextRound'),
        showResults: requiredConfirmations(room, 'showResults'),
      },
      gameOver: room.gameOver,
      impostorWon: room.impostorWon,
      resultsData: room.resultsData || null,
    });
    return;
  }

  // Submit a clue
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/clue$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'clues') {
      sendJson(400, { error: 'Not in clues phase' });
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { playerId, clue } = data;
        if (!playerId || typeof clue !== 'string' || !clue.trim()) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        // Ensure player exists and is alive (eliminated players cannot send clues)
        const player = room.players.find(p => p.id === playerId);
        if (!player) {
          sendJson(404, { error: 'Player not found' });
          return;
        }
        if (!player.alive) {
          sendJson(400, { error: 'Eliminated players cannot send clues' });
          return;
        }
        room.clues.push({ playerId, clue: clue.trim() });
        sendJson(201, { message: 'Clue recorded' });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Advance to voting phase
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/vote-phase$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'clues') {
      sendJson(400, { error: 'Cannot move to voting from current state' });
      return;
    }
    room.state = 'voting';
    sendJson(200, { message: 'Now in voting phase' });
    return;
  }

  // Submit a vote
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/vote$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'voting') {
      sendJson(400, { error: 'Not in voting phase' });
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { voterId, voteForId } = data;
        if (!voterId || !voteForId) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        // Make sure both players exist and the voter hasn't voted yet
        const voter = room.players.find(p => p.id === voterId);
        const voteFor = room.players.find(p => p.id === voteForId);
        if (!voter || !voteFor) {
          sendJson(404, { error: 'Player not found' });
          return;
        }
        // Only alive players may vote
        if (!voter.alive) {
          sendJson(400, { error: 'Eliminated players cannot vote' });
          return;
        }
        // Cannot vote for an eliminated player
        if (!voteFor.alive) {
          sendJson(400, { error: 'Cannot vote for an eliminated player' });
          return;
        }
        if (room.votes.find(v => v.voterId === voterId)) {
          sendJson(400, { error: 'Voter has already voted' });
          return;
        }
        room.votes.push({ voterId, voteForId });
        sendJson(201, { message: 'Vote recorded' });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Join an existing room
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/join$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'lobby') {
      sendJson(400, { error: 'Cannot join after game has started' });
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { name } = data;
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        // Check if a player with this name already exists (case-insensitive)
        const existing = room.players.find(
          p => p.name.toLowerCase() === name.trim().toLowerCase(),
        );
        let player;
        if (existing) {
          // If exists, use the existing player (do not duplicate)
          player = existing;
        } else {
          // Check capacity: do not allow more players than expected
          if (room.players.length >= (room.expectedPlayers || room.players.length)) {
            sendJson(400, { error: 'No se pueden agregar más participantes a esta sala' });
            return;
          }
          // Create new player and add to room with alive=true
          player = {
            id: generateId(),
            name: name.trim(),
            role: null,
            assignedPlayer: null,
            alive: true,
          };
          room.players.push(player);
        }
        // Return the claimed or created player and the updated players list
        sendJson(existing ? 200 : 201, {
          player: player,
          players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            assignedPlayer: p.assignedPlayer
              ? { name: p.assignedPlayer.name, club: p.assignedPlayer.club }
              : null,
            alive: p.alive,
          })),
          state: room.state,
          creatorId: room.creatorId,
        });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Confirm communal actions.  Depending on the action type, this
  // endpoint records the player's confirmation and when enough
  // confirmations are gathered, automatically transitions the game
  // state.  Supported actions are:
  //   - start: begin the game from lobby
  //   - votePhase: move from clues to voting
  //   - nextClue: start another clues round after an incorrect vote
  //   - nextRound: begin a new game after the previous round ends
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/confirm$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { playerId, action } = data;
        if (!playerId || !action) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        if (!['start', 'votePhase', 'nextClue', 'nextRound', 'showResults'].includes(action)) {
          sendJson(400, { error: 'Unsupported action' });
          return;
        }
        const player = room.players.find(p => p.id === playerId);
        if (!player) {
          sendJson(404, { error: 'Player not found' });
          return;
        }
        // Validate that the action is allowed in the current state
        switch (action) {
          case 'start':
            if (room.state !== 'lobby') {
              sendJson(400, { error: 'Cannot start game from current state' });
              return;
            }
            break;
          case 'votePhase':
            if (room.state !== 'clues') {
              sendJson(400, { error: 'Cannot start voting from current state' });
              return;
            }
            break;
          case 'nextClue':
            if (room.state !== 'results' || room.awaiting !== 'nextClue') {
              sendJson(400, { error: 'Cannot start next clue at this time' });
              return;
            }
            break;
          case 'nextRound':
            if (room.state !== 'results' || room.awaiting !== 'nextRound') {
              sendJson(400, { error: 'Cannot start next round at this time' });
              return;
            }
            break;
          case 'showResults':
            if (room.state !== 'voting') {
              sendJson(400, { error: 'Cannot show results from current state' });
              return;
            }
            break;
        }
        // Check if player is allowed to confirm this action
        let required = requiredConfirmations(room, action);
        let relevantPlayers;
        if (action === 'votePhase' || action === 'nextClue') {
          // Only alive players participate
          if (!player.alive) {
            sendJson(400, { error: 'Eliminated players cannot perform this action' });
            return;
          }
        }
        if (action === 'showResults') {
          // Show results also requires player to be alive
          if (!player.alive) {
            sendJson(400, { error: 'Eliminated players cannot perform this action' });
            return;
          }
        }
        // Prevent duplicate confirmations
        if (room.confirmations[action].includes(playerId)) {
          // Already confirmed: respond with current counts
          const current = room.confirmations[action].length;
          sendJson(200, {
            message: 'Already confirmed',
            current,
            required,
          });
          return;
        }
        // Record confirmation
        room.confirmations[action].push(playerId);
        const currentCount = room.confirmations[action].length;
        const requiredCount = required;
        // Check if enough confirmations gathered
        let executed = false;
        let resultData;
        if (currentCount >= requiredCount) {
          executed = true;
          // Clear confirmations for this action and perform transition or computation
          room.confirmations[action] = [];
          switch (action) {
            case 'start':
              // Begin first round
              assignRolesForRound(room);
              room.state = 'clues';
              room.awaiting = null;
              break;
            case 'votePhase':
              startVotePhase(room);
              break;
            case 'nextClue':
              startNextClueRound(room);
              break;
            case 'nextRound':
              startNewGame(room);
              break;
            case 'showResults':
              // Compute results and transition to results state
              resultData = computeResults(room);
              room.state = 'results';
              room.gameOver = resultData.gameOver;
              room.impostorWon = resultData.impostorWon;
              room.awaiting = resultData.awaiting;
              // Store the resultData to send to clients upon polling
              room.resultsData = resultData;
              // Reset confirmations for all actions.  Clearing showResults
              // prevents stale confirmations interfering with subsequent games.
              room.confirmations.start = [];
              room.confirmations.votePhase = [];
              room.confirmations.nextClue = [];
              room.confirmations.nextRound = [];
              room.confirmations.showResults = [];
              break;
          }
        }
        sendJson(200, {
          message: executed ? 'Action executed' : 'Confirmation recorded',
          current: currentCount,
          required: requiredCount,
          executed,
          results: resultData || null,
        });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Force communal actions immediately.  Only the room creator can
  // invoke this endpoint to bypass the confirmation mechanism.
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/force$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { playerId, action } = data;
        if (!playerId || !action) {
          sendJson(400, { error: 'Invalid payload' });
          return;
        }
        if (playerId !== room.creatorId) {
          sendJson(403, { error: 'Only the creator can force actions' });
          return;
        }
        if (!['start', 'votePhase', 'nextClue', 'nextRound', 'showResults'].includes(action)) {
          sendJson(400, { error: 'Unsupported action' });
          return;
        }
        // Validate action allowed for current state
        switch (action) {
          case 'start':
            if (room.state !== 'lobby') {
              sendJson(400, { error: 'Cannot start game from current state' });
              return;
            }
            break;
          case 'votePhase':
            if (room.state !== 'clues') {
              sendJson(400, { error: 'Cannot start voting from current state' });
              return;
            }
            break;
          case 'nextClue':
            if (room.state !== 'results' || room.awaiting !== 'nextClue') {
              sendJson(400, { error: 'Cannot start next clue at this time' });
              return;
            }
            break;
          case 'nextRound':
            if (room.state !== 'results' || room.awaiting !== 'nextRound') {
              sendJson(400, { error: 'Cannot start next round at this time' });
              return;
            }
            break;
          case 'showResults':
            if (room.state !== 'voting') {
              sendJson(400, { error: 'Cannot show results from current state' });
              return;
            }
            break;
        }
        // Execute immediately and clear confirmations
        room.confirmations[action] = [];
        switch (action) {
          case 'start':
            assignRolesForRound(room);
            room.state = 'clues';
            room.awaiting = null;
            break;
          case 'votePhase':
            startVotePhase(room);
            break;
          case 'nextClue':
            startNextClueRound(room);
            break;
          case 'nextRound':
            startNewGame(room);
            break;
          case 'showResults':
            // Compute results and transition to results state
            const result = computeResults(room);
            room.state = 'results';
            room.gameOver = result.gameOver;
            room.impostorWon = result.impostorWon;
            room.awaiting = result.awaiting;
            room.resultsData = result;
            // Reset all confirmations
            room.confirmations.start = [];
            room.confirmations.votePhase = [];
            room.confirmations.nextClue = [];
            room.confirmations.nextRound = [];
            room.confirmations.showResults = [];
            break;
        }
        sendJson(200, { message: 'Action forced' });
      } catch (e) {
        sendJson(400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Advance to results phase and return results
  if (req.method === 'POST' && pathname.match(/^\/api\/room\/[^\/]+\/results$/)) {
    const roomId = pathname.split('/')[3];
    const room = rooms[roomId];
    if (!room) {
      sendJson(404, { error: 'Room not found' });
      return;
    }
    if (room.state !== 'voting') {
      sendJson(400, { error: 'Cannot show results from current state' });
      return;
    }
    // Copy votes to return but do not clear them yet; the clues and votes
    // remain available for the results page until the next action.
    const votesCopy = room.votes.slice();
    // Compute vote counts and determine the accused (alive) player with most votes
    const counts = {};
    room.votes.forEach(v => {
      counts[v.voteForId] = (counts[v.voteForId] || 0) + 1;
    });
    let maxVotes = 0;
    let accusedId = null;
    Object.entries(counts).forEach(([pid, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        accusedId = pid;
      }
    });
    const impostor = room.players.find(p => p.role === 'impostor');
    const impostorId = impostor ? impostor.id : null;
    const success = accusedId && accusedId === impostorId;
    let gameOver = false;
    let impostorWon = false;
    // Always transition to results state; awaiting will indicate next step
    room.state = 'results';
    if (success) {
      // Impostor discovered: players win.  No need to eliminate anyone.
      gameOver = true;
      impostorWon = false;
      room.awaiting = 'nextRound';
    } else {
      // Wrongly accused: eliminate accused player (alive=false)
      if (accusedId) {
        const accused = room.players.find(p => p.id === accusedId);
        if (accused) {
          accused.alive = false;
        }
      }
      // If after elimination only two players remain alive, impostor wins
      const aliveCount = room.players.filter(p => p.alive).length;
      if (aliveCount <= 2) {
        gameOver = true;
        impostorWon = true;
        room.awaiting = 'nextRound';
      } else {
        // Otherwise continue with another clue round; await next clue
        gameOver = false;
        impostorWon = false;
        room.awaiting = 'nextClue';
      }
    }
    room.gameOver = gameOver;
    room.impostorWon = impostorWon;
    // Set confirmations for upcoming action to empty
    Object.keys(room.confirmations).forEach(key => {
      room.confirmations[key] = [];
    });
    // Build response without revealing the impostor's identity
    sendJson(200, {
      message: success
        ? 'El impostor fue descubierto'
        : gameOver
        ? 'El impostor gana por quedar sólo con un jugador'
        : 'El impostor no fue descubierto, próxima ronda',
      success,
      gameOver,
      impostorWon,
      votes: votesCopy,
      remainingPlayers: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive })),
    });
    return;
  }

  // Unknown API route
  sendJson(404, { error: 'Not found' });
}

// Create HTTP server.  All API routes begin with `/api`.  Otherwise
// static content from the client folder is served.
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api')) {
      handleApi(req, res, url);
    } else {
      // Si es la raíz, devolvemos una respuesta directa para evitar error 404 en Render
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Servidor El Impostor activo!');
        return;
      }

      // Para otras rutas, servimos archivos estáticos normalmente
      const pathname = url.pathname;
      serveStatic(pathname, res);
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
