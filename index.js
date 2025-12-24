require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Database (PostgreSQL) - Optional
const { Pool } = require('pg');
let pool = null;
let dbConnected = false;

// Check if DATABASE_URL exists
console.log('🔍 DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('🔍 DATABASE_URL value:', process.env.DATABASE_URL ? 'SET (hidden)' : 'NOT SET');

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    console.log('⚠️ No DATABASE_URL - running in memory-only mode');
}

const app = express();
const server = http.createServer(app);

// CORS for frontend
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());

// ================= DATABASE SETUP =================
const initDB = async () => {
    if (!pool) {
        console.log('⚠️ Skipping DB init - no database connection');
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                gold INTEGER DEFAULT 100,
                gems INTEGER DEFAULT 100,
                trophies INTEGER DEFAULT 0,
                high_score INTEGER DEFAULT 0,
                total_enemies_killed INTEGER DEFAULT 0,
                total_bosses_killed INTEGER DEFAULT 0,
                adventures_completed INTEGER DEFAULT 0,
                max_day_reached INTEGER DEFAULT 0,
                max_combo INTEGER DEFAULT 0,
                equipped_skin VARCHAR(50) DEFAULT 'none',
                last_seen TIMESTAMP DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS leaderboard (
                id SERIAL PRIMARY KEY,
                player_id VARCHAR(50) REFERENCES players(id),
                score INTEGER NOT NULL,
                day_reached INTEGER DEFAULT 0,
                mode VARCHAR(50) DEFAULT 'normal',
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS pvp_matches (
                id SERIAL PRIMARY KEY,
                player1_id VARCHAR(50) REFERENCES players(id),
                player2_id VARCHAR(50),
                winner_id VARCHAR(50),
                player1_trophies_change INTEGER DEFAULT 0,
                player2_trophies_change INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE INDEX IF NOT EXISTS idx_leaderboard_score ON leaderboard(score DESC);
            CREATE INDEX IF NOT EXISTS idx_players_trophies ON players(trophies DESC);
        `);
        dbConnected = true;
        console.log('✅ Database initialized');
    } catch (err) {
        console.error('❌ Database init error:', err.message);
        console.log('⚠️ Server will run without database features');
    }
};

// ================= API ROUTES =================

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', game: 'Capybara Adventure', version: '1.0.0' });
});

// Register/Login player (simple - generates ID if new)
app.post('/api/player/auth', async (req, res) => {
    const { username } = req.body;

    if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    try {
        // Check if player exists
        let result = await pool.query('SELECT * FROM players WHERE username = $1', [username]);

        if (result.rows.length > 0) {
            // Existing player
            await pool.query('UPDATE players SET last_seen = NOW() WHERE id = $1', [result.rows[0].id]);
            return res.json({ player: result.rows[0], isNew: false });
        }

        // New player
        const playerId = uuidv4();
        result = await pool.query(
            'INSERT INTO players (id, username) VALUES ($1, $2) RETURNING *',
            [playerId, username]
        );

        res.json({ player: result.rows[0], isNew: true });
    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get player profile
app.get('/api/player/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM players WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Update player stats
app.put('/api/player/:id/stats', async (req, res) => {
    const { gold, gems, trophies, high_score, total_enemies_killed, total_bosses_killed,
        adventures_completed, max_day_reached, max_combo, equipped_skin } = req.body;

    try {
        const result = await pool.query(`
            UPDATE players SET 
                gold = COALESCE($2, gold),
                gems = COALESCE($3, gems),
                trophies = COALESCE($4, trophies),
                high_score = GREATEST(high_score, COALESCE($5, 0)),
                total_enemies_killed = total_enemies_killed + COALESCE($6, 0),
                total_bosses_killed = total_bosses_killed + COALESCE($7, 0),
                adventures_completed = adventures_completed + COALESCE($8, 0),
                max_day_reached = GREATEST(max_day_reached, COALESCE($9, 0)),
                max_combo = GREATEST(max_combo, COALESCE($10, 0)),
                equipped_skin = COALESCE($11, equipped_skin),
                last_seen = NOW()
            WHERE id = $1
            RETURNING *
        `, [req.params.id, gold, gems, trophies, high_score, total_enemies_killed,
            total_bosses_killed, adventures_completed, max_day_reached, max_combo, equipped_skin]);

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Submit score to leaderboard
app.post('/api/leaderboard', async (req, res) => {
    const { player_id, score, day_reached, mode } = req.body;

    try {
        await pool.query(
            'INSERT INTO leaderboard (player_id, score, day_reached, mode) VALUES ($1, $2, $3, $4)',
            [player_id, score, day_reached, mode || 'normal']
        );

        // Update player high score
        await pool.query(
            'UPDATE players SET high_score = GREATEST(high_score, $2) WHERE id = $1',
            [player_id, score]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
    const { limit = 20, mode = 'all' } = req.query;

    try {
        let query = `
            SELECT l.*, p.username, p.equipped_skin 
            FROM leaderboard l 
            JOIN players p ON l.player_id = p.id 
        `;

        if (mode !== 'all') {
            query += ` WHERE l.mode = '${mode}' `;
        }

        query += ` ORDER BY l.score DESC LIMIT $1`;

        const result = await pool.query(query, [parseInt(limit)]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get PvP leaderboard (by trophies)
app.get('/api/pvp/leaderboard', async (req, res) => {
    const { limit = 20 } = req.query;

    try {
        const result = await pool.query(
            'SELECT id, username, trophies, equipped_skin FROM players ORDER BY trophies DESC LIMIT $1',
            [parseInt(limit)]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ================= SOCKET.IO - REAL-TIME PVP =================
const waitingPlayers = [];
const activeMatches = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Player connected:', socket.id);

    // Join matchmaking queue
    socket.on('pvp:queue', (playerData) => {
        console.log('📋 Player queued:', playerData.username);

        // Remove from queue if already there
        const existingIndex = waitingPlayers.findIndex(p => p.playerId === playerData.playerId);
        if (existingIndex > -1) waitingPlayers.splice(existingIndex, 1);

        waitingPlayers.push({
            socketId: socket.id,
            playerId: playerData.playerId,
            username: playerData.username,
            stats: playerData.stats,
            trophies: playerData.trophies || 0
        });

        socket.emit('pvp:queued', { position: waitingPlayers.length });

        // Try to match
        tryMatchPlayers();
    });

    // Leave queue
    socket.on('pvp:leave', () => {
        const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
        if (index > -1) waitingPlayers.splice(index, 1);
    });

    // Combat action
    socket.on('pvp:action', (data) => {
        const match = activeMatches.get(data.matchId);
        if (!match) return;

        const opponent = match.players.find(p => p.socketId !== socket.id);
        if (opponent) {
            io.to(opponent.socketId).emit('pvp:opponent_action', data);
        }
    });

    // Combat result
    socket.on('pvp:result', async (data) => {
        const match = activeMatches.get(data.matchId);
        if (!match) return;

        // Calculate trophy changes
        const winnerTrophyGain = 15 + Math.floor(Math.random() * 10);
        const loserTrophyLoss = Math.min(10, Math.floor(data.loserTrophies * 0.1));

        // Notify both players
        match.players.forEach(p => {
            const isWinner = p.playerId === data.winnerId;
            io.to(p.socketId).emit('pvp:match_end', {
                won: isWinner,
                trophyChange: isWinner ? winnerTrophyGain : -loserTrophyLoss
            });
        });

        // Save match to DB
        try {
            await pool.query(
                'INSERT INTO pvp_matches (player1_id, player2_id, winner_id, player1_trophies_change, player2_trophies_change) VALUES ($1, $2, $3, $4, $5)',
                [match.players[0].playerId, match.players[1].playerId, data.winnerId, winnerTrophyGain, -loserTrophyLoss]
            );
        } catch (err) {
            console.error('Match save error:', err);
        }

        activeMatches.delete(data.matchId);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Player disconnected:', socket.id);

        // Remove from queue
        const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
        if (index > -1) waitingPlayers.splice(index, 1);

        // Handle mid-match disconnect
        activeMatches.forEach((match, matchId) => {
            if (match.players.some(p => p.socketId === socket.id)) {
                const opponent = match.players.find(p => p.socketId !== socket.id);
                if (opponent) {
                    io.to(opponent.socketId).emit('pvp:opponent_disconnect');
                }
                activeMatches.delete(matchId);
            }
        });
    });
});

// Matchmaking logic
function tryMatchPlayers() {
    if (waitingPlayers.length < 2) return;

    // Simple matchmaking - match first two in queue
    // In production, you'd match by trophy range
    const player1 = waitingPlayers.shift();
    const player2 = waitingPlayers.shift();

    const matchId = uuidv4();

    activeMatches.set(matchId, {
        id: matchId,
        players: [player1, player2],
        startedAt: Date.now()
    });

    // Notify both players
    io.to(player1.socketId).emit('pvp:match_found', {
        matchId,
        opponent: {
            username: player2.username,
            stats: player2.stats,
            trophies: player2.trophies
        }
    });

    io.to(player2.socketId).emit('pvp:match_found', {
        matchId,
        opponent: {
            username: player1.username,
            stats: player1.stats,
            trophies: player1.trophies
        }
    });

    console.log(`⚔️ Match started: ${player1.username} vs ${player2.username}`);
}

// ================= START SERVER =================
const PORT = process.env.PORT || 3001;

initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🎮 Capybara Adventure Backend Ready!`);
    });
});
