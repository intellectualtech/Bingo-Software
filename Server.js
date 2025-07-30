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
  },
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = 'your_jwt_secret';
const TOTAL_BALLS = 48;
const MAX_DRAWS = 30;
const BONUS_BALL_THRESHOLD = 10;
const AUTO_DRAW_INTERVAL = 4167;

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'David',
  database: 'bingo',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000
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
  drawEndTime: null,
  cashiers: [],
  screens: [],
  locations: []
};
let ticketQueue = [];
let cashierSockets = [];
let displaySockets = [];

async function authenticate(username, password) {
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
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
  if (!rawData || typeof rawData !== 'string') return defaultValue;
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
  try {
    const safeData = JSON.stringify(data instanceof Object ? cleanGameState(data) : data);
    io.emit(event, JSON.parse(safeData));
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error emitting event ${event}:`, err);
  }
}

async function checkWinners() {
  try {
    if (!gameState.gameId) return;
    const [tickets] = await pool.execute('SELECT player_name, lucky_numbers, ticket_price, slip_number FROM tickets WHERE game_id = ?', [gameState.gameId]);
    for (const ticket of tickets) {
      const numbers = safeParseJSON(ticket.lucky_numbers);
      const matches = gameState.drawnBalls.filter(ball => numbers.includes(ball)).length;
      if (matches >= 5) {
        const prize = calculatePrize(matches, ticket.ticket_price || 5);
        gameState.winner = { player: ticket.player_name, prize: prize };
        await pool.execute('UPDATE games SET winner = ? WHERE game_id = ?', [JSON.stringify(gameState.winner), gameState.gameId]);
        await pool.execute('INSERT INTO game_history (game_id, slip_number, prize, drawn_balls) VALUES (?, ?, ?, ?)',
          [gameState.gameId, ticket.slip_number, prize, JSON.stringify(gameState.drawnBalls)]);
        await pool.execute(
          'INSERT INTO earnings (game_id, slip_number, player_name, amount, earned_at) VALUES (?, ?, ?, ?, NOW())',
          [gameState.gameId, ticket.slip_number, ticket.player_name, prize]
        );
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
  const multipliers = { 5: 10, 6: 50, 7: 100, 8: 500, 9: 1000, 10: 5000 };
  return ticketPrice * (multipliers[matches] || 10);
}

async function drawBall() {
  if (cashierSockets.length === 0 || displaySockets.length === 0) {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot draw ball: No cashier or display connected`);
    safeEmit('error', 'Cannot draw ball: System not fully connected');
    return;
  }
  if (!gameState.gameId || gameState.availableBalls.length === 0 || gameState.drawnBalls.length >= MAX_DRAWS) {
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
    await pool.execute(
      'UPDATE games SET available_balls = ?, drawn_balls = ?, last_update = NOW() WHERE game_id = ?',
      [JSON.stringify(gameState.availableBalls), JSON.stringify(gameState.drawnBalls), gameState.gameId]
    );
    safeEmit('ballDrawn', { number: ball });
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Ball drawn: ${ball}`);
    await checkWinners();
    if (gameState.drawnBalls.length === BONUS_BALL_THRESHOLD && !gameState.bonusBall && gameState.availableBalls.length > 0) {
      const bonusIndex = crypto.randomInt(0, gameState.availableBalls.length);
      gameState.bonusBall = gameState.availableBalls.splice(bonusIndex, 1)[0];
      await pool.execute(
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
    await pool.execute('UPDATE games SET is_running = TRUE, is_counting_down = FALSE, draw_start_time = ?, draw_end_time = ? WHERE game_id = ?', 
      [new Date(gameState.drawStartTime), new Date(gameState.drawEndTime), gameState.gameId]);
    gameState.autoDrawInterval = setInterval(async () => {
      if (!gameState.gameId || gameState.availableBalls.length === 0 || gameState.drawnBalls.length >= MAX_DRAWS || 
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
    safeEmit('gameStarted', { gameId: gameState.gameId });
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
      await pool.execute('UPDATE games SET is_running = FALSE WHERE game_id = ?', [gameState.gameId]);
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

async function initNewGame() {
  try {
    gameState.gameId = `BG-${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
    gameState.availableBalls = Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1);
    gameState.drawnBalls = [];
    gameState.bonusBall = null;
    gameState.winner = null;
    gameState.recentBalls = [];
    gameState.players = [];
    gameState.drawStartTime = null;
    gameState.drawEndTime = null;
    await pool.execute(
      'INSERT INTO games (game_id, available_balls, drawn_balls, is_running, is_counting_down, draw_start_time, draw_end_time) VALUES (?, ?, ?, FALSE, FALSE, NULL, NULL)',
      [gameState.gameId, JSON.stringify(gameState.availableBalls), JSON.stringify(gameState.drawnBalls)]
    );
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] New game initialized: ${gameState.gameId}`);
    safeEmit('gameState', gameState);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error initializing new game:`, err);
    safeEmit('error', 'Database error while initializing new game');
  }
}

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = await authenticate(username, password);
  if (user) {
    const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, role: user.role });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/sell-ticket', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'cashier') return res.status(403).json({ success: false, message: 'Unauthorized' });

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
      totalPrice += ticketPrice || (luckyNumbers.length * 5);
    }
    if (new Set(allNumbers).size !== allNumbers.length) {
      return res.status(400).json({ success: false, message: 'Duplicate numbers across sets not allowed' });
    }
    await pool.execute(
      'INSERT INTO tickets (game_id, player_name, ticket_price, lucky_numbers, slip_number) VALUES (?, ?, ?, ?, ?)',
      [gameState.gameId, playerName, totalPrice, JSON.stringify(ticketSets.map(set => set.luckyNumbers)), slipNumber]
    );
    gameState.players.push({ name: playerName, tickets: ticketSets.map(set => set.luckyNumbers), balance: totalPrice, slipNumber, wins: 0 });
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Ticket sold successfully', ticketId: slipNumber, totalPrice });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error saving ticket:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/play-ticket', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'cashier') return res.status(403).json({ success: false, message: 'Unauthorized' });

  if (!cashierSockets.length || !displaySockets.length) {
    console.warn(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Cannot play ticket: No cashier or display connected`);
    ticketQueue.push(req.body);
    return res.json({ success: true, message: 'Ticket queued for play', queued: true });
  }
  try {
    let newGameId = gameState.gameId;
    if (!newGameId || gameState.isRunning || gameState.isCountingDown) {
      newGameId = `BG-${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
      await pool.execute(
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
    }
    io.to('display').emit('playTicket', { gameId: gameState.gameId });
    safeEmit('gameState', gameState);
    setTimeout(async () => {
      gameState.isCountingDown = false;
      await pool.execute('UPDATE games SET is_counting_down = FALSE WHERE game_id = ?', [gameState.gameId]);
      safeEmit('gameState', gameState);
      await startAutoDraw();
    }, 30000);
    res.json({ success: true, message: 'Ticket play initiated', gameId: gameState.gameId });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error playing ticket:`, err);
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
    const [tickets] = await pool.execute('SELECT * FROM tickets WHERE slip_number = ?', [slipNumber]);
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
      await pool.execute(
        'INSERT INTO game_history (game_id, drawn_balls, bonus_ball, winner, draw_end_time) VALUES (?, ?, ?, ?, ?)',
        [gameState.gameId, JSON.stringify(gameState.drawnBalls), gameState.bonusBall, JSON.stringify(gameState.winner), new Date(gameState.drawEndTime)]
      );
      await pool.execute(
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
    res.json({ success: true, message: 'Game reset' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error resetting game:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/cashiers', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [cashiers] = await pool.execute('SELECT * FROM cashiers');
    res.json({ success: true, cashiers });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching cashiers:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/cashiers', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const { name, locationId, displayId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const newCashier = { id: gameState.cashiers.length + 1, name, locationId, displayId, status: 'active', activityLog: [] };
    gameState.cashiers.push(newCashier);
    await pool.execute(
      'INSERT INTO cashiers (name, location_id, display_id, status, activity_log) VALUES (?, ?, ?, ?, ?)',
      [name, locationId || null, displayId || null, 'active', JSON.stringify([])]
    );
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Cashier added', cashier: newCashier });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error adding cashier:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.put('/api/cashiers/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const id = parseInt(req.params.id);
  const { locationId, displayId, status } = req.body;
  try {
    const cashierIndex = gameState.cashiers.findIndex(c => c.id === id);
    if (cashierIndex === -1) return res.status(404).json({ error: 'Cashier not found' });
    gameState.cashiers[cashierIndex] = {
      ...gameState.cashiers[cashierIndex],
      locationId,
      displayId,
      status: status || 'active',
      activityLog: [...gameState.cashiers[cashierIndex].activityLog, `Updated at ${new Date().toISOString()}: locationId=${locationId}, displayId=${displayId}, status=${status}`]
    };
    await pool.execute(
      'UPDATE cashiers SET location_id = ?, display_id = ?, status = ?, activity_log = ? WHERE id = ?',
      [locationId || null, displayId || null, status || 'active', JSON.stringify(gameState.cashiers[cashierIndex].activityLog), id]
    );
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Cashier updated', cashier: gameState.cashiers[cashierIndex] });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error updating cashier:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/api/cashiers/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const id = parseInt(req.params.id);
  try {
    gameState.cashiers = gameState.cashiers.filter(c => c.id !== id);
    await pool.execute('DELETE FROM cashiers WHERE id = ?', [id]);
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Cashier deleted' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error deleting cashier:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/screens', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [screens] = await pool.execute('SELECT * FROM screens');
    res.json({ success: true, screens });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching screens:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/screens', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const { name, locationId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const newScreen = { id: gameState.screens.length + 1, name, locationId, status: 'active' };
    gameState.screens.push(newScreen);
    await pool.execute(
      'INSERT INTO screens (name, location_id, status) VALUES (?, ?, ?)',
      [name, locationId || null, 'active']
    );
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Screen added', screen: newScreen });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error adding screen:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/api/screens/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const id = parseInt(req.params.id);
  try {
    gameState.screens = gameState.screens.filter(s => s.id !== id);
    await pool.execute('DELETE FROM screens WHERE id = ?', [id]);
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Screen deleted' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error deleting screen:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/locations', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [locations] = await pool.execute('SELECT * FROM locations');
    res.json({ success: true, locations });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching locations:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/locations', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const { name, address, maxWin } = req.body;
  if (!name || !address || !maxWin) return res.status(400).json({ error: 'Name, address, and maxWin are required' });
  try {
    const newLocation = { id: gameState.locations.length + 1, name, address, maxWin };
    gameState.locations.push(newLocation);
    await pool.execute(
      'INSERT INTO locations (name, address, max_win) VALUES (?, ?, ?)',
      [name, address, maxWin]
    );
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Location added', location: newLocation });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error adding location:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/api/locations/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const id = parseInt(req.params.id);
  try {
    const [cashiers] = await pool.execute('SELECT * FROM cashiers WHERE location_id = ?', [id]);
    const [screens] = await pool.execute('SELECT * FROM screens WHERE location_id = ?', [id]);
    if (cashiers.length > 0 || screens.length > 0) {
      return res.status(400).json({ error: 'Cannot delete location with associated cashiers or screens' });
    }
    gameState.locations = gameState.locations.filter(l => l.id !== id);
    await pool.execute('DELETE FROM locations WHERE id = ?', [id]);
    safeEmit('gameState', gameState);
    res.json({ success: true, message: 'Location deleted' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error deleting location:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/earn', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'cashier') return res.status(403).json({ success: false, message: 'Unauthorized' });

  const { gameId, slipNumber, playerName, amount } = req.body;
  if (!gameId || !slipNumber || !playerName || amount == null) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  try {
    await pool.execute(
      'INSERT INTO earnings (game_id, slip_number, player_name, amount, earned_at, collected) VALUES (?, ?, ?, ?, NOW(), FALSE)',
      [gameId, slipNumber, playerName, amount]
    );
    const [rows] = await pool.execute('SELECT COALESCE(SUM(amount), 0) as totalEarnings FROM earnings WHERE collected = FALSE');
    safeEmit('balanceUpdate', { totalEarnings: rows[0].totalEarnings });
    res.json({ success: true, message: 'Earnings recorded successfully' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error recording earnings:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/get-total-earnings', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || (decoded.role !== 'cashier' && decoded.role !== 'admin')) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const [rows] = await pool.execute('SELECT COALESCE(SUM(amount), 0) as totalEarnings FROM earnings WHERE collected = FALSE');
    res.json({ success: true, totalEarnings: rows[0].totalEarnings });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching total earnings:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/earn-total', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ success: false, message: 'Invalid token' });
  try {
    const [rows] = await pool.execute('SELECT COALESCE(SUM(amount), 0) as totalEarnings FROM earnings WHERE collected = FALSE');
    res.json({ success: true, totalEarnings: rows[0].totalEarnings });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching total earnings:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/collect-earnings', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [rows] = await pool.execute('SELECT COALESCE(SUM(amount), 0) as totalEarnings FROM earnings WHERE collected = FALSE');
    const collectedAmount = rows[0].totalEarnings;
    
    await pool.execute(
      'UPDATE earnings SET collected = TRUE, collected_at = NOW() WHERE collected = FALSE'
    );
    
    await pool.execute(
      'INSERT INTO earnings_collections (amount, collected_at, collected_by) VALUES (?, NOW(), ?)',
      [collectedAmount, decoded.username]
    );

    safeEmit('balanceUpdate', { totalEarnings: 0 });
    res.json({ 
      success: true, 
      message: 'Earnings collected successfully', 
      collectedAmount 
    });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error collecting earnings:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/earnings-history', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [earnings] = await pool.execute('SELECT * FROM earnings ORDER BY earned_at DESC');
    const [collections] = await pool.execute('SELECT * FROM earnings_collections ORDER BY collected_at DESC');
    res.json({ 
      success: true, 
      earnings,
      collections 
    });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching earnings history:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/tickets', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'cashier') return res.status(403).json({ success: false, message: 'Unauthorized' });

  const { gameId } = req.query;
  if (!gameId) return res.status(400).json({ success: false, message: 'Missing gameId' });
  try {
    const [tickets] = await pool.execute('SELECT * FROM tickets WHERE game_id = ?', [gameId]);
    res.json({ success: true, tickets });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching tickets:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- JACKPOTS API ---
app.get('/api/jackpots', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [jackpots] = await pool.execute('SELECT * FROM jackpots');
    res.json({ success: true, jackpots });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching jackpots:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/jackpots', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const { locationId, bronze, silver, gold, max } = req.body;
  if (!locationId || bronze == null || silver == null || gold == null || max == null) {
    return res.status(400).json({ error: 'Missing jackpot fields' });
  }
  try {
    const [existing] = await pool.execute('SELECT id FROM jackpots WHERE location_id = ?', [locationId]);
    if (existing.length > 0) {
      await pool.execute(
        'UPDATE jackpots SET bronze = ?, silver = ?, gold = ?, max = ? WHERE location_id = ?',
        [bronze, silver, gold, max, locationId]
      );
      res.json({ success: true, id: existing[0].id });
    } else {
      const [result] = await pool.execute(
        'INSERT INTO jackpots (location_id, bronze, silver, gold, max) VALUES (?, ?, ?, ?, ?)',
        [locationId, bronze, silver, gold, max]
      );
      res.json({ success: true, id: result.insertId });
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error updating jackpots:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- REPORTS API ---
app.post('/api/reports', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  const { type, locationId } = req.body;
  try {
    let totalRevenue = 0;
    if (type === 'income') {
      let query = 'SELECT COALESCE(SUM(amount), 0) as totalRevenue FROM earnings WHERE collected = FALSE';
      let params = [];
      if (locationId) {
        query += ' AND location_id = ?';
        params.push(locationId);
      }
      const [rows] = await pool.execute(query, params);
      totalRevenue = rows[0].totalRevenue;
    }
    const report = {
      id: Date.now(),
      type,
      date: new Date(),
      totalRevenue
    };
    await pool.execute(
      'INSERT INTO reports (type, total_revenue, created_at) VALUES (?, ?, NOW())',
      [type, totalRevenue]
    );
    res.json({ success: true, id: report.id, totalRevenue });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error generating report:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- ADMIN DASHBOARD QUERIES ---
app.get('/api/admin/dashboard', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [dashboard] = await pool.execute(`
      SELECT 
        g.game_id,
        g.is_running,
        g.is_counting_down,
        g.draw_start_time,
        g.draw_end_time,
        g.available_balls,
        g.drawn_balls,
        g.bonus_ball,
        g.winner,
        l.name AS location_name,
        (SELECT COUNT(*) FROM tickets t WHERE t.game_id = g.game_id) AS active_players,
        (SELECT SUM(e.amount) FROM earnings e WHERE e.collected = FALSE) AS total_earnings,
        (SELECT SUM(e.amount) FROM earnings e WHERE DATE(e.earned_at) = CURDATE()) AS today_earnings,
        (SELECT COUNT(*) FROM cashiers c WHERE c.status = 'active') AS total_cashiers,
        (SELECT COUNT(*) FROM screens s WHERE s.status = 'active') AS total_displays,
        (SELECT COUNT(*) FROM locations l) AS total_locations,
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'event', 'Ticket Sold',
            'details', CONCAT('Player: ', e.player_name, ', Amount: ', FORMAT(e.amount, 2), ', Slip: ', e.slip_number),
            'time', TIME(e.earned_at)
          )
        ) FROM earnings e ORDER BY e.earned_at DESC LIMIT 5) AS recent_activities
      FROM games g
      LEFT JOIN locations l ON g.location_id = l.id
      WHERE g.is_running = TRUE OR g.is_counting_down = TRUE
      LIMIT 1
    `);
    res.json({ success: true, dashboard: dashboard[0] || {} });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching dashboard data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/locations', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [locations] = await pool.execute(`
      SELECT 
        l.id,
        l.name,
        l.address,
        l.max_win AS max_amount,
        j.bronze,
        j.silver,
        j.gold,
        l.created_at,
        CASE WHEN l.created_at IS NOT NULL THEN 'active' ELSE 'inactive' END AS status
      FROM locations l
      LEFT JOIN jackpots j ON l.id = j.location_id
    `);
    res.json({ success: true, locations });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching locations data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [users] = await pool.execute(`
      SELECT 
        u.id,
        u.username,
        u.role,
        u.status,
        l.name AS location_name
      FROM users u
      LEFT JOIN locations l ON u.location_id = l.id
      WHERE u.role IN ('admin', 'cashier', 'display')
    `);
    res.json({ success: true, users });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching users data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/cashiers', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [cashiers] = await pool.execute(`
      SELECT 
        c.id,
        c.name,
        c.username,
        c.password,
        c.status,
        l.name AS location_name,
        c.activity_log
      FROM cashiers c
      LEFT JOIN locations l ON c.location_id = l.id
    `);
    res.json({ success: true, cashiers });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching cashiers data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/screens', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [screens] = await pool.execute(`
      SELECT 
        s.id,
        s.name,
        s.status,
        l.name AS location_name,
        c.name AS cashier_name
      FROM screens s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN cashiers c ON s.display_id = c.id
    `);
    res.json({ success: true, screens });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching screens data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/jackpots', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [jackpots] = await pool.execute(`
      SELECT 
        j.id,
        j.bronze,
        j.silver,
        j.gold,
        j.max AS max_amount,
        l.name AS location_name,
        CASE WHEN j.id IS NOT NULL THEN 'active' ELSE 'inactive' END AS status
      FROM jackpots j
      LEFT JOIN locations l ON j.location_id = l.id
    `);
    res.json({ success: true, jackpots });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching jackpots data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/financials', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [financials] = await pool.execute(`
      SELECT 
        l.name AS location_name,
        c.id AS cashier_id,
        c.name AS cashier_name,
        SUM(e.amount) AS total_earned,
        CASE WHEN COUNT(CASE WHEN e.collected = FALSE THEN 1 END) = 0 THEN TRUE ELSE FALSE END AS all_collected
      FROM earnings e
      JOIN cashiers c ON e.location_id = c.location_id
      JOIN locations l ON c.location_id = l.id
      WHERE e.collected = FALSE
      GROUP BY l.id, c.id
    `);
    res.json({ success: true, financials });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching financials data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/game-history', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [gameHistory] = await pool.execute(`
      SELECT 
        gh.id,
        gh.game_id,
        gh.slip_number,
        gh.prize,
        gh.drawn_balls,
        gh.bonus_ball,
        gh.winner,
        gh.completed_at AS end_time,
        l.name AS location_name
      FROM game_history gh
      LEFT JOIN locations l ON gh.location_id = l.id
    `);
    res.json({ success: true, gameHistory });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching game history:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.get('/api/admin/error-logs', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const [errorLogs] = await pool.execute(`
      SELECT 
        el.id,
        el.message,
        el.stack,
        el.created_at AS timestamp,
        l.name AS location_name,
        c.name AS cashier_name,
        CASE 
          WHEN el.message LIKE '%timeout%' THEN 'high'
          WHEN el.message LIKE '%failed%' THEN 'high'
          ELSE 'normal'
        END AS severity
      FROM error_logs el
      LEFT JOIN locations l ON el.location_id = l.id
      LEFT JOIN cashiers c ON el.cashier_id = c.id
      ORDER BY el.created_at DESC
    `);
    res.json({ success: true, errorLogs });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching error logs:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/admin/income-report', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  const { startDate, endDate, locationId, cashierId, ticketNumber } = req.body;
  try {
    const params = [];
    let query = `
      SELECT 
        e.slip_number,
        e.player_name,
        c.name AS cashier_name,
        l.name AS location_name,
        e.amount,
        e.earned_at
      FROM earnings e
      JOIN cashiers c ON e.location_id = c.location_id
      JOIN locations l ON c.location_id = l.id
      WHERE 1=1
    `;
    if (startDate) {
      query += ' AND e.earned_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND e.earned_at <= ?';
      params.push(endDate);
    }
    if (locationId) {
      query += ' AND e.location_id = ?';
      params.push(locationId);
    }
    if (cashierId) {
      query += ' AND c.id = ?';
      params.push(cashierId);
    }
    if (ticketNumber) {
      query += ' AND e.slip_number LIKE ?';
      params.push(`%${ticketNumber}%`);
    }
    const [report] = await pool.execute(query, params);
    res.json({ success: true, report });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error generating income report:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/admin/win-tickets-report', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  const { startDate, endDate, locationId, cashierId, ticketNumber } = req.body;
  try {
    const params = [];
    let query = `
      SELECT 
        e.slip_number,
        e.player_name,
        c.name AS cashier_name,
        l.name AS location_name,
        e.amount,
        e.earned_at,
        e.collected,
        e.collected_at,
        SUM(CASE WHEN e2.collected = FALSE THEN e2.amount ELSE 0 END) AS current_balance
      FROM earnings e
      JOIN cashiers c ON e.location_id = c.location_id
      JOIN locations l ON c.location_id = l.id
      LEFT JOIN earnings e2 ON e2.location_id = c.location_id
      WHERE 1=1
    `;
    if (startDate) {
      query += ' AND e.earned_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND e.earned_at <= ?';
      params.push(endDate);
    }
    if (locationId) {
      query += ' AND e.location_id = ?';
      params.push(locationId);
    }
    if (cashierId) {
      query += ' AND c.id = ?';
      params.push(cashierId);
    }
    if (ticketNumber) {
      query += ' AND e.slip_number LIKE ?';
      params.push(`%${ticketNumber}%`);
    }
    query += ' GROUP BY e.id';
    const [report] = await pool.execute(query, params);
    res.json({ success: true, report });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error generating win tickets report:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- ADMIN ALL DATA API ---
app.get('/api/admin/all-data', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });

  try {
    const allData = {};

    const [dashboard] = await pool.execute(`
      SELECT 
        g.game_id,
        g.is_running,
        g.is_counting_down,
        g.draw_start_time,
        g.draw_end_time,
        g.available_balls,
        g.drawn_balls,
        g.bonus_ball,
        g.winner,
        l.name AS location_name,
        (SELECT COUNT(*) FROM tickets t WHERE t.game_id = g.game_id) AS active_players,
        (SELECT SUM(e.amount) FROM earnings e WHERE e.collected = FALSE) AS total_earnings,
        (SELECT SUM(e.amount) FROM earnings e WHERE DATE(e.earned_at) = CURDATE()) AS today_earnings,
        (SELECT COUNT(*) FROM cashiers c WHERE c.status = 'active') AS total_cashiers,
        (SELECT COUNT(*) FROM screens s WHERE s.status = 'active') AS total_displays,
        (SELECT COUNT(*) FROM locations l) AS total_locations,
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'event', 'Ticket Sold',
            'details', CONCAT('Player: ', e.player_name, ', Amount: ', FORMAT(e.amount, 2), ', Slip: ', e.slip_number),
            'time', TIME(e.earned_at)
          )
        ) FROM earnings e ORDER BY e.earned_at DESC LIMIT 5) AS recent_activities
      FROM games g
      LEFT JOIN locations l ON g.location_id = l.id
      WHERE g.is_running = TRUE OR g.is_counting_down = TRUE
      LIMIT 1
    `);
    allData.dashboard = dashboard[0] || {};

    const [locations] = await pool.execute(`
      SELECT 
        l.id,
        l.name,
        l.address,
        l.max_win AS max_amount,
        j.bronze,
        j.silver,
        j.gold,
        l.created_at,
        CASE WHEN l.created_at IS NOT NULL THEN 'active' ELSE 'inactive' END AS status
      FROM locations l
      LEFT JOIN jackpots j ON l.id = j.location_id
    `);
    allData.locations = locations;

    const [users] = await pool.execute(`
      SELECT 
        u.id,
        u.username,
        u.role,
        u.status,
        l.name AS location_name
      FROM users u
      LEFT JOIN locations l ON u.location_id = l.id
      WHERE u.role IN ('admin', 'cashier', 'display')
    `);
    allData.users = users;

    const [cashiers] = await pool.execute(`
      SELECT 
        c.id,
        c.name,
        c.username,
        c.password,
        c.status,
        l.name AS location_name,
        c.activity_log
      FROM cashiers c
      LEFT JOIN locations l ON c.location_id = l.id
    `);
    allData.cashiers = cashiers;

    const [screens] = await pool.execute(`
      SELECT 
        s.id,
        s.name,
        s.status,
        l.name AS location_name,
        c.name AS cashier_name
      FROM screens s
      LEFT JOIN locations l ON s.location_id = l.id
      LEFT JOIN cashiers c ON s.display_id = c.id
    `);
    allData.screens = screens;

    const [jackpots] = await pool.execute(`
      SELECT 
        j.id,
        j.bronze,
        j.silver,
        j.gold,
        j.max AS max_amount,
        l.name AS location_name,
        CASE WHEN j.id IS NOT NULL THEN 'active' ELSE 'inactive' END AS status
      FROM jackpots j
      LEFT JOIN locations l ON j.location_id = l.id
    `);
    allData.jackpots = jackpots;

    const [financials] = await pool.execute(`
      SELECT 
        l.name AS location_name,
        c.id AS cashier_id,
        c.name AS cashier_name,
        SUM(e.amount) AS total_earned,
        CASE WHEN COUNT(CASE WHEN e.collected = FALSE THEN 1 END) = 0 THEN TRUE ELSE FALSE END AS all_collected
      FROM earnings e
      JOIN cashiers c ON e.location_id = c.location_id
      JOIN locations l ON c.location_id = l.id
      WHERE e.collected = FALSE
      GROUP BY l.id, c.id
    `);
    allData.financials = financials;

    const [gameHistory] = await pool.execute(`
      SELECT 
        gh.id,
        gh.game_id,
        gh.slip_number,
        gh.prize,
        gh.drawn_balls,
        gh.bonus_ball,
        gh.winner,
        gh.completed_at AS end_time,
        l.name AS location_name
      FROM game_history gh
      LEFT JOIN locations l ON gh.location_id = l.id
    `);
    allData.gameHistory = gameHistory;

    const [errorLogs] = await pool.execute(`
      SELECT 
        el.id,
        el.message,
        el.stack,
        el.created_at AS timestamp,
        l.name AS location_name,
        c.name AS cashier_name,
        CASE 
          WHEN el.message LIKE '%timeout%' THEN 'high'
          WHEN el.message LIKE '%failed%' THEN 'high'
          ELSE 'normal'
        END AS severity
      FROM error_logs el
      LEFT JOIN locations l ON el.location_id = l.id
      LEFT JOIN cashiers c ON el.cashier_id = c.id
      ORDER BY el.created_at DESC
    `);
    allData.errorLogs = errorLogs;

    io.to('admin').emit('allData', allData);
    res.json({ success: true, data: allData });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching all data:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- ERROR LOGS API ---
let errorLogs = [];
app.get('/api/error-logs', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const [logs] = await pool.execute('SELECT * FROM error_logs ORDER BY created_at DESC');
    res.json({ success: true, errors: logs });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching error logs:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.post('/api/error-logs/clear', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded || decoded.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  try {
    await pool.execute('TRUNCATE TABLE error_logs');
    errorLogs = [];
    io.to('admin').emit('errorLogs', errorLogs);
    res.json({ success: true, message: 'Error logs cleared' });
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error clearing error logs:`, err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// --- SOCKET.IO EVENTS FOR ADMIN MONITORING ---
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
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [CASHIER] Connected: ${socket.id} | Total cashiers: ${cashierSockets.length}`);
      } else if (socket.role === 'display') {
        if (!displaySockets.some(s => s.id === socket.id)) {
          displaySockets.push(socket);
          socket.join('display');
        }
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [DISPLAY] Connected: ${socket.id} | Total displays: ${displaySockets.length}`);
        socket.emit('cashierStatus', { isCashierConnected: cashierSockets.length > 0 });
      } else if (socket.role === 'admin') {
        socket.join('admin');
        console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [ADMIN] Connected: ${socket.id}`);
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

  socket.on('requestCashierStatus', () => {
    if (socket.role === 'admin') {
      socket.emit('cashiersUpdated', gameState.cashiers);
    }
  });

  socket.on('requestFinancials', async () => {
    if (socket.role === 'admin') {
      try {
        const [financials] = await pool.execute(`
          SELECT 
            l.name AS location_name,
            c.id AS cashier_id,
            c.name AS cashier_name,
            SUM(e.amount) AS total_earned,
            CASE WHEN COUNT(CASE WHEN e.collected =            FALSE THEN 1 END) = 0 THEN TRUE ELSE FALSE END AS all_collected
          FROM earnings e
          JOIN cashiers c ON e.location_id = c.location_id
          JOIN locations l ON c.location_id = l.id
          WHERE e.collected = FALSE
          GROUP BY l.id, c.id
        `);
        socket.emit('financials', financials);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching financials:`, err);
        socket.emit('error', 'Database error fetching financials');
      }
    }
  });

  socket.on('requestErrorLogs', async () => {
    if (socket.role === 'admin') {
      try {
        const [logs] = await pool.execute(`
          SELECT 
            el.id,
            el.message,
            el.stack,
            el.created_at AS timestamp,
            l.name AS location_name,
            c.name AS cashier_name,
            CASE 
              WHEN el.message LIKE '%timeout%' THEN 'high'
              WHEN el.message LIKE '%failed%' THEN 'high'
              ELSE 'normal'
            END AS severity
          FROM error_logs el
          LEFT JOIN locations l ON el.location_id = l.id
          LEFT JOIN cashiers c ON el.cashier_id = c.id
          ORDER BY el.created_at DESC
        `);
        socket.emit('errorLogs', logs);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error fetching error logs:`, err);
        socket.emit('error', 'Database error fetching error logs');
      }
    }
  });

  socket.on('startAutoDraw', async () => {
    if (socket.role === 'admin' && !gameState.isRunning && !gameState.isCountingDown) {
      await startAutoDraw();
    } else {
      socket.emit('error', 'Cannot start auto draw: Unauthorized or game already in progress');
    }
  });

  socket.on('stopAutoDraw', async () => {
    if (socket.role === 'admin' && gameState.isRunning) {
      await stopAutoDraw();
    } else {
      socket.emit('error', 'Cannot stop auto draw: Unauthorized or no game running');
    }
  });

  socket.on('drawBall', async () => {
    if (socket.role === 'admin' && !gameState.isRunning) {
      await drawBall();
    } else {
      socket.emit('error', 'Cannot draw ball: Unauthorized or game is running');
    }
  });

  socket.on('resetGame', async () => {
    if (socket.role === 'admin') {
      try {
        await pool.execute(
          'INSERT INTO game_history (game_id, drawn_balls, bonus_ball, winner, draw_end_time) VALUES (?, ?, ?, ?, ?)',
          [gameState.gameId, JSON.stringify(gameState.drawnBalls), gameState.bonusBall, JSON.stringify(gameState.winner), new Date(gameState.drawEndTime)]
        );
        await initNewGame();
        safeEmit('gameReset');
        socket.emit('gameState', gameState);
      } catch (err) {
        console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error resetting game:`, err);
        socket.emit('error', 'Database error resetting game');
      }
    } else {
      socket.emit('error', 'Unauthorized to reset game');
    }
  });

  socket.on('disconnect', () => {
    console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Client disconnected: ${socket.id}`);
    if (socket.role === 'cashier') {
      cashierSockets = cashierSockets.filter(s => s.id !== socket.id);
      socket.leave('cashier');
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [CASHIER] Disconnected: ${socket.id} | Total cashiers: ${cashierSockets.length}`);
    } else if (socket.role === 'display') {
      displaySockets = displaySockets.filter(s => s.id !== socket.id);
      socket.leave('display');
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [DISPLAY] Disconnected: ${socket.id} | Total displays: ${displaySockets.length}`);
    } else if (socket.role === 'admin') {
      socket.leave('admin');
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] [ADMIN] Disconnected: ${socket.id}`);
    }
    broadcastConnectionStatus();
  });
});

async function playTicketHandler(socket, ticketData) {
  try {
    if (!gameState.gameId || gameState.isRunning || gameState.isCountingDown) {
      const newGameId = `BG-${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
      await pool.execute(
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
    }
    io.to('display').emit('playTicket', { gameId: gameState.gameId });
    safeEmit('gameState', gameState);
    setTimeout(async () => {
      gameState.isCountingDown = false;
      await pool.execute('UPDATE games SET is_counting_down = FALSE WHERE game_id = ?', [gameState.gameId]);
      safeEmit('gameState', gameState);
      await startAutoDraw();
    }, 30000);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error handling queued ticket:`, err);
    socket.emit('error', 'Database error processing queued ticket');
  }
}

function broadcastConnectionStatus() {
  io.to('display').emit('cashierStatus', { isCashierConnected: cashierSockets.length > 0 });
  io.to('admin').emit('connectionStatus', {
    cashiers: cashierSockets.length,
    displays: displaySockets.length
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Server running on port ${PORT}`);
  try {
    const [games] = await pool.execute('SELECT * FROM games ORDER BY last_update DESC LIMIT 1');
    if (games.length > 0) {
      gameState.gameId = games[0].game_id;
      gameState.availableBalls = safeParseJSON(games[0].available_balls, Array.from({ length: TOTAL_BALLS }, (_, i) => i + 1));
      gameState.drawnBalls = safeParseJSON(games[0].drawn_balls, []);
      gameState.bonusBall = games[0].bonus_ball || null;
      gameState.winner = safeParseJSON(games[0].winner, null);
      gameState.isRunning = games[0].is_running;
      gameState.isCountingDown = games[0].is_counting_down;
      gameState.drawStartTime = games[0].draw_start_time ? new Date(games[0].draw_start_time).getTime() : null;
      gameState.drawEndTime = games[0].draw_end_time ? new Date(games[0].draw_end_time).getTime() : null;
      const [history] = await pool.execute('SELECT * FROM game_history WHERE game_id = ?', [gameState.gameId]);
      gameState.gameHistory = history.map(h => ({
        gameId: h.game_id,
        drawnBalls: safeParseJSON(h.drawn_balls, []),
        bonusBall: h.bonus_ball,
        winner: safeParseJSON(h.winner, null),
        drawEndTime: h.draw_end_time ? new Date(h.draw_end_time).getTime() : null
      }));
      const [players] = await pool.execute('SELECT * FROM tickets WHERE game_id = ?', [gameState.gameId]);
      gameState.players = players.map(p => ({
        name: p.player_name,
        tickets: safeParseJSON(p.lucky_numbers, []),
        balance: p.ticket_price,
        slipNumber: p.slip_number,
        wins: 0
      }));
      console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Loaded game state: ${gameState.gameId}`);
    } else {
      await initNewGame();
    }
    safeEmit('gameState', gameState);
  } catch (err) {
    console.error(`[${new Date().toLocaleString('en-US', { timeZone: 'Africa/Windhoek' })}] Error initializing server:`, err);
    safeEmit('error', 'Server initialization error');
  }
});