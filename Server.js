const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://yourdomain.com'],
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = 'your_jwt_secret'; // Replace with a secure secret key
const TOTAL_BALLS = 48;
const MAX_DRAWS = 30;
const BONUS_BALL_THRESHOLD = 10;
const AUTO_DRAW_INTERVAL = 10000;

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'David',
  database: 'bingo',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

let gameState = {
  gameId: null,
  availableBalls: Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1),
  drawnBalls: [],
  bonusBall: null,
  bonusAmounts: { bronze: 705.66, silver: 792.56, gold: 1250.00 },
  gameHistory: [],
  players: [],
  autoDrawInterval: null,
  winner: null,
  isRunning: false,
  isCountingDown: false,
  recentBalls: [],
  lastUpdate: Date.now(),
  drawStartTime: null,
  drawEndTime: null
};
let ticketQueue = [];
let cashierSockets = [];
let displaySockets = [];

async function authenticate(username, password) {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Authentication error:`, err);
    return null;
  }
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Token verification error:`, err);
    return null;
  }
}

function safeParseJSON(rawData, defaultValue = []) {
  if (typeof rawData !== 'string' || !rawData.trim()) return defaultValue;
  try {
    const parsed = JSON.parse(rawData);
    return Array.isArray(parsed) ? parsed : defaultValue;
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Invalid JSON data: ${rawData}, error: ${err.message}`);
    return defaultValue;
  }
}

function cleanGameState(state) {
  const cleanState = { ...state };
  delete cleanState.cashierSockets;
  delete cleanState.displaySockets;
  delete cleanState.autoDrawInterval;
  return cleanState;
}

function safeEmit(event, data) {
  const safeData = JSON.stringify(data instanceof Object ? cleanGameState(data) : data);
  io.emit(event, JSON.parse(safeData));
}

async function checkWinners() {
  try {
    const [tickets] = await pool.query('SELECT player_name, lucky_numbers, ticket_price, slip_number FROM tickets WHERE game_id = ?', [gameState.gameId]);
    for (const ticket of tickets) {
      const numbers = safeParseJSON(ticket.lucky_numbers);
      const matches = gameState.drawnBalls.filter(ball => numbers.includes(ball)).length;
      if (matches >= 5) {
        gameState.winner = { player: ticket.player_name, prize: calculatePrize(matches, ticket.ticket_price || 5) };
        await pool.query('UPDATE games SET winner = ? WHERE game_id = ?', [JSON.stringify(gameState.winner), gameState.gameId]);
        await pool.query('INSERT INTO game_history (game_id, slip_number, prize, drawn_balls) VALUES (?, ?, ?, ?)',
          [gameState.gameId, ticket.slip_number, gameState.winner.prize, JSON.stringify(gameState.drawnBalls)]);
        safeEmit('winner', gameState.winner);
        await stopAutoDraw();
        break;
      }
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error checking winners:`, err);
    safeEmit('error', 'Database error while checking winners');
  }
}

function calculatePrize(matches, ticketPrice) {
  const multipliers = {
    5: 10,
    6: 50,
    7: 100,
    8: 500,
    9: 1000,
    10: 5000
  };
  return ticketPrice * (multipliers[matches] || 10);
}

async function drawBall() {
  if (cashierSockets.length === 0 || displaySockets.length === 0) {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot draw ball: No cashier or display connected`);
    safeEmit('error', 'Cannot draw ball: System not fully connected');
    return;
  }
  if (gameState.availableBalls.length === 0 || gameState.drawnBalls.length >= MAX_DRAWS) {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] No balls available or max draws reached`);
    safeEmit('error', 'No balls available or maximum draws reached');
    await stopAutoDraw();
    return;
  }
  try {
    const index = crypto.randomInt(0, gameState.availableBalls.length);
    const ball = gameState.availableBalls.splice(index, 1)[0];
    gameState.drawnBalls.push(ball);
    gameState.recentBalls.unshift(ball);
    if (gameState.recentBalls.length > 10) gameState.recentBalls.pop();
    gameState.lastUpdate = Date.now();
    await pool.query(
      'UPDATE games SET available_balls = ?, drawn_balls = ?, last_update = NOW() WHERE game_id = ?',
      [JSON.stringify(gameState.availableBalls), JSON.stringify(gameState.drawnBalls), gameState.gameId]
    );
    safeEmit('ballDrawn', { number: ball });
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Ball drawn: ${ball}`);
    await checkWinners();
    if (gameState.drawnBalls.length === BONUS_BALL_THRESHOLD && !gameState.bonusBall && gameState.availableBalls.length > 0) {
      const bonusIndex = crypto.randomInt(0, gameState.availableBalls.length);
      gameState.bonusBall = gameState.availableBalls.splice(bonusIndex, 1)[0];
      await pool.query(
        'UPDATE games SET bonus_ball = ?, available_balls = ? WHERE game_id = ?',
        [gameState.bonusBall, JSON.stringify(gameState.availableBalls), gameState.gameId]
      );
      safeEmit('bonusBall', gameState.bonusBall);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Bonus ball drawn: ${gameState.bonusBall}`);
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error drawing ball:`, err);
    safeEmit('error', 'Database error during ball draw');
  }
}

async function startAutoDraw() {
  if (!gameState.autoDrawInterval && cashierSockets.length > 0 && displaySockets.length > 0 && !gameState.isCountingDown) {
    gameState.isRunning = true;
    gameState.drawStartTime = Date.now();
    gameState.drawEndTime = gameState.drawStartTime + 300000;
    await pool.query('UPDATE games SET is_running = TRUE, is_counting_down = FALSE, draw_start_time = ?, draw_end_time = ? WHERE game_id = ?', 
      [new Date(gameState.drawStartTime), new Date(gameState.drawEndTime), gameState.gameId]);
    gameState.autoDrawInterval = setInterval(async () => {
      if (gameState.availableBalls.length === 0 || gameState.drawnBalls.length >= MAX_DRAWS || 
          gameState.winner || cashierSockets.length === 0 || displaySockets.length === 0 || 
          Date.now() >= gameState.drawEndTime) {
        await stopAutoDraw();
        safeEmit('gameState', gameState);
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Auto draw stopped:`, {
          noBalls: gameState.availableBalls.length === 0,
          maxDraws: gameState.drawnBalls.length >= MAX_DRAWS,
          hasWinner: !!gameState.winner,
          noCashier: cashierSockets.length === 0,
          noDisplay: displaySockets.length === 0,
          timeUp: Date.now() >= gameState.drawEndTime
        });
        return;
      }
      await drawBall();
    }, AUTO_DRAW_INTERVAL);
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Auto draw started for game: ${gameState.gameId}`);
    safeEmit('gameState', gameState);
  } else if (gameState.isCountingDown) {
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Waiting for countdown to finish before starting auto draw`);
    safeEmit('gameState', gameState);
  } else {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot start auto draw: No cashier or display connected or already running`);
    safeEmit('error', 'Cannot start auto draw: System not fully connected or game already running');
  }
}

async function stopAutoDraw() {
  if (gameState.autoDrawInterval) {
    clearInterval(gameState.autoDrawInterval);
    gameState.autoDrawInterval = null;
    gameState.isRunning = false;
    try {
      await pool.query('UPDATE games SET is_running = FALSE WHERE game_id = ?', [gameState.gameId]);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Auto draw stopped for game: ${gameState.gameId}`);
      safeEmit('autoDrawPaused');
      safeEmit('gameState', gameState);

      await initNewGame();
    } catch (err) {
      console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error stopping auto draw:`, err);
      safeEmit('error', 'Database error while stopping auto draw');
    }
  }
}

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await authenticate(username, password);
  if (user) {
    const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, role: user.role });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/sell-ticket', async (req, res) => {
  const { playerName, ticketSets, slipNumber } = req.body;
  if (!playerName || !ticketSets || !slipNumber || !Array.isArray(ticketSets)) {
    return res.status(400).json({ success: false, message: 'Missing required fields or invalid ticketSets format' });
  }
  if (!gameState.gameId) {
    return res.status(400).json({ success: false, message: 'No active game. Please start a game first.' });
  }
  try {
    let totalPrice = 0;
    const allNumbers = [];
    for (const set of ticketSets) {
      const { luckyNumbers, ticketPrice } = set;
      if (!Array.isArray(luckyNumbers) || luckyNumbers.length < 6 || luckyNumbers.length > 10 ||
          !luckyNumbers.every(n => Number.isInteger(n) && n >= 1 && n <= TOTAL_BALLS)) {
        return res.status(400).json({ success: false, message: 'Invalid lucky numbers in set' });
      }
      if (new Set(luckyNumbers).size !== luckyNumbers.length) {
        return res.status(400).json({ success: false, message: 'Duplicate numbers not allowed within a set' });
      }
      allNumbers.push(...luckyNumbers);
      totalPrice += ticketPrice || (luckyNumbers.length === 6 ? 5 : luckyNumbers.length === 7 ? 6 : 
                                   luckyNumbers.length === 8 ? 8 : luckyNumbers.length === 9 ? 9 : 10);
    }
    if (new Set(allNumbers).size !== allNumbers.length) {
      return res.status(400).json({ success: false, message: 'Duplicate numbers across sets not allowed' });
    }
    await pool.query(
      'INSERT INTO tickets (game_id, player_name, ticket_price, lucky_numbers, slip_number) VALUES (?, ?, ?, ?, ?)',
      [gameState.gameId, playerName, totalPrice, JSON.stringify(ticketSets.map(set => set.luckyNumbers)), slipNumber]
    );
    gameState.players.push({
      name: playerName,
      tickets: ticketSets.map(set => set.luckyNumbers),
      balance: totalPrice,
      slipNumber,
      wins: 0
    });
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Ticket sold successfully', ticketId: slipNumber, totalPrice });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error saving ticket:`, err);
    if (err.code === 'ER_DATA_TOO_LONG') {
      console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Data too long for 'game_id' column. Please run: ALTER TABLE tickets MODIFY COLUMN game_id VARCHAR(7);`);
    }
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/play-ticket', async (req, res) => {
  if (!cashierSockets.length || !displaySockets.length) {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot play ticket: No cashier or display connected`);
    ticketQueue.push(req.body);
    return res.json({ success: true, message: 'Ticket queued for play', queued: true });
  }
  try {
    const [games] = await pool.query('SELECT game_id, is_running, is_counting_down FROM games WHERE is_running = FALSE AND is_counting_down = FALSE ORDER BY last_update DESC LIMIT 1');
    let newGameId = gameState.gameId;
    if (games.length === 0 || !newGameId) {
      newGameId = generateInitialGameId();
      await pool.query(
        'INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time) VALUES (?, ?, ?, FALSE, TRUE, NULL, NULL)',
        [newGameId, JSON.stringify(Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)), JSON.stringify([])]
      );
      gameState.gameId = newGameId;
      gameState.availableBalls = Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1);
      gameState.drawnBalls = [];
      gameState.bonusBall = null;
      gameState.winner = null;
      gameState.isRunning = false;
      gameState.isCountingDown = true;
      gameState.recentBalls = [];
      gameState.players = [];
      gameState.drawStartTime = null;
      gameState.drawEndTime = null;
      safeEmit('gameState', gameState);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] New game created: ${newGameId}`);
    } else if (games[0].is_running || games[0].is_counting_down) {
      console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot play ticket: Game already in progress or counting down`);
      return res.json({ success: false, message: 'Game already in progress' });
    } else {
      gameState.gameId = games[0].game_id;
      gameState.isCountingDown = true;
      await pool.query('UPDATE games SET is_counting_down = TRUE WHERE game_id = ?', [gameState.gameId]);
      safeEmit('gameState', gameState);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Using existing game: ${gameState.gameId}`);
    }
    io.to('display').emit('playTicket', { gameId: gameState.gameId });
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Play ticket initiated, countdown started for game: ${newGameId || gameState.gameId}`);
    res.json({ success: true, message: 'Ticket play initiated', gameId: gameState.gameId });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error playing ticket:`, err);
    if (err.code === 'ER_DATA_TOO_LONG') {
      console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Game ID too long. Consider increasing 'game_id' column size to VARCHAR(7) or TEXT.`);
    }
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/check-slip', async (req, res) => {
  const { slipNumber } = req.query;
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ success: false, message: 'Invalid token' });
  try {
    const [tickets] = await pool.query('SELECT * FROM tickets WHERE slip_number = ?', [slipNumber]);
    if (tickets.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, ticket: tickets[0] });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error checking slip:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/reset-game', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    if (gameState.gameId) {
      await pool.query(
        'INSERT INTO game_history (game_id, drawn_balls, bonus_ball, winner, draw_end_time) VALUES (?, ?, ?, ?, ?)',
        [gameState.gameId, JSON.stringify(gameState.drawnBalls), gameState.bonusBall, JSON.stringify(gameState.winner), new Date(gameState.drawEndTime)]
      );
      await pool.query(
        'UPDATE games SET available_balls = ?, drawn_balls = ?, bonus_ball = NULL, winner = NULL, is_running = FALSE, is_counting_down = FALSE, draw_start_time = NULL, draw_end_time = NULL, last_update = NOW() WHERE game_id = ?',
        [JSON.stringify(Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)), JSON.stringify([]), gameState.gameId]
      );
    }
    gameState.gameHistory.push({
      gameId: gameState.gameId,
      drawnBalls: [...gameState.drawnBalls],
      bonusBall: gameState.bonusBall,
      winner: gameState.winner,
      drawEndTime: gameState.drawEndTime
    });
    gameState.gameId = generateInitialGameId();
    gameState.availableBalls = Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1);
    gameState.drawnBalls = [];
    gameState.bonusBall = null;
    gameState.winner = null;
    gameState.isRunning = false;
    gameState.isCountingDown = false;
    gameState.recentBalls = [];
    gameState.players = [];
    gameState.drawStartTime = null;
    gameState.drawEndTime = null;
    ticketQueue = [];
    await stopAutoDraw();
    safeEmit('gameReset');
    safeEmit('gameState', gameState);
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Game reset for game: ${gameState.gameId}`);
    res.json({ success: true, message: 'Game reset' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error resetting game:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/port', (req, res) => {
  res.json({ port: server.address()?.port || 3000 });
});

app.get('/cashier', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cashier.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

function generateInitialGameId() {
  const random = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `BG-${random}`;
}

async function initNewGame() {
  try {
    gameState.gameId = generateInitialGameId();
    await pool.query(
      'INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time) VALUES (?, ?, ?, FALSE, FALSE, NULL, NULL)',
      [gameState.gameId, JSON.stringify(Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)), JSON.stringify([])]
    );
    gameState.availableBalls = Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1);
    gameState.drawnBalls = [];
    gameState.bonusBall = null;
    gameState.winner = null;
    gameState.isRunning = false;
    gameState.isCountingDown = false;
    gameState.recentBalls = [];
    gameState.players = [];
    gameState.drawStartTime = null;
    gameState.drawEndTime = null;
    safeEmit('gameState', gameState);
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] New game initialized with gameId: ${gameState.gameId}`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error initializing new game:`, err);
    safeEmit('error', 'Database error initializing new game');
  }
}

io.on('connection', (socket) => {
  console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Client connected: ${socket.id}`);

  socket.on('authenticate', async (token) => {
    const decoded = verifyToken(token);
    if (decoded) {
      socket.role = decoded.role;
      socket.id = `${decoded.role}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      socket.emit('authenticated', { role: decoded.role });
      safeEmit('gameState', gameState);

      if (socket.role === 'cashier') {
        if (!cashierSockets.some(s => s.id === socket.id)) {
          cashierSockets.push(socket);
          socket.join('cashier');
        }
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cashier connected, total: ${cashierSockets.length}`);
      } else if (socket.role === 'display') {
        if (!displaySockets.some(s => s.id === socket.id)) {
          displaySockets.push(socket);
          socket.join('display');
        }
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Display connected, total: ${displaySockets.length}`);
        socket.emit('cashierStatus', { isCashierConnected: cashierSockets.length > 0 });
      }

      broadcastConnectionStatus();

      if (cashierSockets.length > 0 && displaySockets.length > 0 && ticketQueue.length > 0) {
        const ticket = ticketQueue.shift();
        await playTicketHandler(socket, ticket);
      }
    } else {
      socket.emit('authError', 'Invalid token');
      socket.disconnect();
    }
  });

  socket.on('requestGameState', () => {
    safeEmit('gameState', gameState);
    if (socket.role === 'display') {
      socket.emit('cashierStatus', { isCashierConnected: cashierSockets.length > 0 });
    }
  });

  socket.on('ping', (timestamp) => {
    socket.emit('pong', Date.now() - timestamp);
  });

  socket.on('drawBall', async () => {
    if (socket.role === 'cashier' && cashierSockets.length > 0 && displaySockets.length > 0) {
      await drawBall();
    } else {
      socket.emit('error', 'Cannot draw ball: No cashier or display connected or unauthorized');
    }
  });

  socket.on('gameStarted', async (data) => {
    if (socket.role === 'display' && cashierSockets.length > 0 && displaySockets.length > 0) {
      try {
        if (!gameState.gameId) {
          gameState.gameId = data.gameId || generateInitialGameId();
          await pool.query(
            'INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time) VALUES (?, ?, ?, TRUE, FALSE, ?, ?)',
            [gameState.gameId, JSON.stringify(gameState.availableBalls), JSON.stringify(gameState.drawnBalls), 
             new Date(gameState.drawStartTime), new Date(gameState.drawEndTime)]
          );
        } else {
          await pool.query('UPDATE games SET is_running = TRUE, is_counting_down = FALSE, draw_start_time = ?, draw_end_time = ? WHERE game_id = ?', 
            [new Date(gameState.drawStartTime), new Date(gameState.drawEndTime), gameState.gameId]);
        }
        gameState.isRunning = true;
        gameState.isCountingDown = false;
        gameState.drawStartTime = Date.now();
        gameState.drawEndTime = gameState.drawStartTime + 300000;
        await startAutoDraw();
        safeEmit('gameStarted', { gameId: gameState.gameId });
        safeEmit('gameState', gameState);
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Game started, gameId: ${gameState.gameId}`);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error starting game:`, err);
        socket.emit('error', 'Database error starting game');
      }
    } else {
      socket.emit('error', 'Cannot start game: No cashier connected or unauthorized');
    }
  });

  socket.on('pauseAutoDraw', async () => {
    if (socket.role === 'cashier') {
      await stopAutoDraw();
    } else {
      socket.emit('error', 'Unauthorized to pause auto draw');
    }
  });

  socket.on('resumeAutoDraw', async () => {
    if (socket.role === 'cashier' && !gameState.autoDrawInterval && cashierSockets.length > 0 && displaySockets.length > 0) {
      await startAutoDraw();
      io.to('display').emit('autoDrawResumed');
    } else {
      socket.emit('error', 'Cannot resume auto draw: No cashier or display connected or already running');
    }
  });

  socket.on('updateGameSettings', async (settings) => {
    if (socket.role === 'cashier') {
      try {
        gameState.availableBalls = Array.from({ length: settings.totalBalls || TOTAL_BALLS }, (_, i) => i + 1);
        if (gameState.gameId) {
          await pool.query('UPDATE games SET available_balls = ? WHERE game_id = ?', 
            [JSON.stringify(gameState.availableBalls), gameState.gameId]);
        }
        safeEmit('gameState', gameState);
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Game settings updated:`, settings);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error updating game settings:`, err);
        safeEmit('error', 'Database error updating game settings');
      }
    }
  });

  socket.on('addPlayer', async (player) => {
    if (socket.role === 'cashier') {
      try {
        const slipNumber = `ML-${Math.random().toString(36).substr(2, 9).toUpperCase()}-${Date.now()}`;
        await pool.query(
          'INSERT INTO tickets (game_id, player_name, ticket_price, lucky_numbers, slip_number) VALUES (?, ?, ?, ?, ?)',
          [gameState.gameId, player.name, player.balance || 0, JSON.stringify(player.ticket), slipNumber]
        );
        gameState.players.push({ name: player.name, tickets: [player.ticket], balance: player.balance || 0, slipNumber, wins: 0 });
        safeEmit('gameState', gameState);
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Player added: ${player.name}, slip: ${slipNumber}`);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error adding player:`, err);
        safeEmit('error', 'Database error adding player');
      }
    }
  });

  socket.on('playTicket', async (data) => {
    if (socket.role === 'cashier' && cashierSockets.length > 0 && displaySockets.length > 0) {
      await playTicketHandler(socket, data);
    } else {
      socket.emit('error', 'Cannot process play ticket: No cashier or display connected');
    }
  });

  socket.on('reset-game', async () => {
    if (socket.role === 'cashier' || socket.role === 'admin') {
      await resetGame();
    } else {
      socket.emit('error', 'Unauthorized to reset game');
    }
  });

  socket.on('disconnect', () => {
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Client disconnected: ${socket.id}`);
    if (socket.role === 'cashier') {
      cashierSockets = cashierSockets.filter(s => s.id !== socket.id);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cashier disconnected, total: ${cashierSockets.length}`);
    } else if (socket.role === 'display') {
      displaySockets = displaySockets.filter(s => s.id !== socket.id);
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Display disconnected, total: ${displaySockets.length}`);
    }
    broadcastConnectionStatus();
    if (cashierSockets.length === 0 || displaySockets.length === 0) {
      stopAutoDraw();
    }
  });

  startHeartbeat(socket);
});

function broadcastConnectionStatus() {
  const cashierCount = cashierSockets.length;
  const displayCount = displaySockets.length;
  safeEmit('cashierConnected', { cashierCount });
  safeEmit('displayConnected', { displayCount });
  io.to('display').emit('cashierStatus', { isCashierConnected: cashierCount > 0 });
  console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Broadcasted connection status: Cashiers: ${cashierCount}, Displays: ${displayCount}`);
}

function startHeartbeat(socket) {
  const interval = setInterval(() => {
    if (socket.connected) {
      socket.emit('ping', Date.now());
    }
  }, 30000);
  socket.on('pong', (latency) => {
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Heartbeat from ${socket.id}, latency: ${latency}ms`);
    if (latency > 5000) {
      safeEmit('error', 'High latency detected, checking connection...');
    }
  });
  socket.on('disconnect', () => clearInterval(interval));
}

async function playTicketHandler(socket, data) {
  try {
    if (gameState.gameId !== data.gameId) {
      console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Mismatched gameId: ${data.gameId}, current: ${gameState.gameId}`);
      socket.emit('error', 'Invalid game ID');
      return;
    }
    gameState.isCountingDown = true;
    await pool.query('UPDATE games SET is_counting_down = TRUE WHERE game_id = ?', [gameState.gameId]);
    io.to('display').emit('playTicket', { gameId: gameState.gameId });
    safeEmit('gameState', gameState);
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Play ticket event emitted for game: ${gameState.gameId}`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error emitting playTicket:`, err);
    socket.emit('error', 'Error processing play ticket');
  }
}

async function initGameState() {
  try {
    if (gameState.autoDrawInterval) {
      clearInterval(gameState.autoDrawInterval);
      gameState.autoDrawInterval = null;
    }
    let newGameId;
    let attempt = 0;
    const maxAttempts = 5;
    do {
      newGameId = generateInitialGameId();
      try {
        await pool.query(
          'INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time) VALUES (?, ?, ?, FALSE, FALSE, NULL, NULL)',
          [newGameId, JSON.stringify(Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)), JSON.stringify([])]
        );
        break;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY' || attempt >= maxAttempts - 1) throw err;
        console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Duplicate game ID ${newGameId}, retrying... (Attempt ${attempt + 1}/${maxAttempts})`);
        attempt++;
      }
    } while (attempt < maxAttempts);
    gameState.gameId = newGameId;
    gameState.availableBalls = Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1);
    gameState.drawnBalls = [];
    gameState.bonusBall = null;
    gameState.winner = null;
    gameState.isRunning = false;
    gameState.isCountingDown = false;
    gameState.recentBalls = [];
    gameState.players = [];
    gameState.drawStartTime = null;
    gameState.drawEndTime = null;
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] New game initialized with gameId: ${gameState.gameId}`);
    safeEmit('gameState', gameState);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error initializing game state:`, err);
    gameState = {
      gameId: generateInitialGameId(),
      availableBalls: Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1),
      drawnBalls: [],
      bonusBall: null,
      bonusAmounts: { bronze: 705.66, silver: 792.56, gold: 1250.00 },
      gameHistory: [],
      players: [],
      autoDrawInterval: null,
      winner: null,
      isRunning: false,
      isCountingDown: false,
      recentBalls: [],
      lastUpdate: Date.now(),
      drawStartTime: null,
      drawEndTime: null
    };
    safeEmit('gameState', gameState);
  }
}

async function resetGame() {
  try {
    if (gameState.gameId) {
      await pool.query(
        'INSERT INTO game_history (game_id, drawn_balls, bonus_ball, winner, draw_end_time) VALUES (?, ?, ?, ?, ?)',
        [gameState.gameId, JSON.stringify(gameState.drawnBalls), gameState.bonusBall, JSON.stringify(gameState.winner), new Date(gameState.drawEndTime)]
      );
      await pool.query(
        'UPDATE games SET available_balls = ?, drawn_balls = ?, bonus_ball = NULL, winner = NULL, is_running = FALSE, is_counting_down = FALSE, draw_start_time = NULL, draw_end_time = NULL, last_update = NOW() WHERE game_id = ?',
        [JSON.stringify(Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1)), JSON.stringify([]), gameState.gameId]
      );
    }
    gameState.gameHistory.push({
      gameId: gameState.gameId,
      drawnBalls: [...gameState.drawnBalls],
      bonusBall: gameState.bonusBall,
      winner: gameState.winner,
      drawEndTime: gameState.drawEndTime
    });
    await initNewGame();
    safeEmit('gameReset');
    safeEmit('gameState', gameState);
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Game reset and new game initialized with gameId: ${gameState.gameId}`);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error resetting game:`, err);
    safeEmit('error', 'Database error during game reset');
  }
}

function startServer(port, maxAttempts = 5) {
  server.listen(port, () => {
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Server running on http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxAttempts > 0) {
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Port ${port} is in use, trying port ${port + 1}...`);
      setTimeout(() => startServer(port + 1, maxAttempts - 1), 1000);
    } else {
      console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Server error:`, err);
      safeEmit('error', 'Unable to start server: All ports in use');
    }
  });
}

initGameState().then(() => startServer(3000));