const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// Mock user database
const users = [
  { username: 'admin', password: 'admin123', role: 'admin' },
  { username: 'cashier', password: 'cashier123', role: 'cashier' },
  { username: 'display', password: 'display123', role: 'display' }
];

// Game state
let gameState = {
  isRunning: false,
  drawnBalls: [],
  availableBalls: Array.from({ length: 48 }, (_, i) => i + 1),
  players: [],
  gameHistory: [],
  transactionHistory: [],
  bonusBall: null,
  winner: null,
  timer: 0,
  gameId: "BG-" + Math.floor(10000 + Math.random() * 90000),
  startTime: new Date('2025-05-19T22:14:00+02:00') // 10:14 PM CAT
};

// Authentication middleware
function authenticate(username, password) {
  return users.find(u => u.username === username && u.password === password);
}

// Login endpoint
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = authenticate(username, password);
  if (user) {
    res.json({ role: user.role });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Start game endpoint
app.post('/start-game', (req, res) => {
  if (!gameState.isRunning) {
    gameState.isRunning = true;
    gameState.drawnBalls = [];
    gameState.availableBalls = Array.from({ length: 48 }, (_, i) => i + 1);
    gameState.bonusBall = null;
    gameState.winner = null;
    gameState.timer = 10;
    gameState.gameId = "BG-" + Math.floor(10000 + Math.random() * 90000); // Generate new game ID
    gameState.startTime = new Date('2025-05-19T22:14:00+02:00'); // 10:14 PM CAT
    io.emit('gameState', gameState);
    res.json({ success: true, message: 'Game started' });
  } else {
    res.status(400).json({ success: false, message: 'Game already running' });
  }
});

// Draw ball endpoint
app.post('/draw-ball', (req, res) => {
  if (gameState.isRunning && gameState.availableBalls.length > 0) {
    const index = Math.floor(Math.random() * gameState.availableBalls.length);
    const ball = gameState.availableBalls.splice(index, 1)[0];
    gameState.drawnBalls.push(ball);

    if (gameState.drawnBalls.length === 10 && !gameState.bonusBall && gameState.availableBalls.length > 0) {
      const bonusIndex = Math.floor(Math.random() * gameState.availableBalls.length);
      gameState.bonusBall = gameState.availableBalls.splice(bonusIndex, 1)[0];
      io.emit('bonusBall', gameState.bonusBall);
    }

    checkWinners();
    io.emit('gameState', gameState);
    res.json({ ball });
  } else {
    res.status(400).json({ error: 'No balls left or game not running' });
  }
});

// Stop game endpoint
app.post('/stop-game', (req, res) => {
  if (gameState.isRunning) {
    gameState.isRunning = false;
    if (gameState.drawnBalls.length > 0) {
      gameState.gameHistory.push({
        gameId: gameState.gameId,
        drawnBalls: [...gameState.drawnBalls],
        bonusBall: gameState.bonusBall,
        winner: gameState.winner,
        startTime: gameState.startTime
      });
    }
    io.emit('gameState', gameState);
    res.json({ success: true, message: 'Game stopped' });
  } else {
    res.status(400).json({ success: false, message: 'Game already stopped' });
  }
});

// Reset game endpoint
app.post('/reset-game', (req, res) => {
  gameState.isRunning = false;
  gameState.drawnBalls = [];
  gameState.availableBalls = Array.from({ length: 48 }, (_, i) => i + 1);
  gameState.bonusBall = null;
  gameState.winner = null;
  gameState.timer = 0;
  gameState.players = gameState.players.map(p => ({ ...p, tickets: [], luckyNumbers: null, slipNumber: null }));
  io.emit('gameState', gameState);
  res.json({ message: 'Game reset' });
});

// Sell ticket endpoint
app.post('/sell-ticket', (req, res) => {
  const { playerName, ticketPrice, luckyNumbers, slipNumber } = req.body;
  let player = gameState.players.find(p => p.name === playerName);

  if (!player) {
    player = { name: playerName, tickets: [], balance: 100, wins: 0, luckyNumbers: null, slipNumber: null };
    gameState.players.push(player);
  }

  if (player.balance >= ticketPrice) {
    player.balance -= ticketPrice;
    player.luckyNumbers = luckyNumbers;
    player.slipNumber = slipNumber;
    player.tickets.push(generateTicket());
    gameState.transactionHistory.push({
      playerName,
      amount: ticketPrice,
      time: new Date('2025-05-19T22:14:00+02:00').toISOString(),
      slipNumber
    });
    io.emit('gameState', gameState);
    res.json({ success: true, message: 'Ticket sold' });
  } else {
    res.json({ success: false, message: 'Insufficient balance' });
  }
});

// Ticket generation (5x5 grid with random numbers 1-48)
function generateTicket() {
  const ticket = Array(5).fill().map(() => Array(5).fill(0));
  const numbers = [...Array(48).keys()].sort(() => Math.random() - 0.5).slice(0, 25);
  let index = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      ticket[i][j] = numbers[index++] + 1;
    }
  }
  return ticket;
}

// Check for winners (handled by cashier verification)
function checkWinners() {
  // Winner checking is handled by cashier's verifyWin function
}

// Serve dashboard pages
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin.html'));
app.get('/cashier', (req, res) => res.sendFile(__dirname + '/public/cashier.html'));
app.get('/display', (req, res) => res.sendFile(__dirname + '/public/display.html'));

io.on('connection', (socket) => {
  socket.emit('gameState', gameState);
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});