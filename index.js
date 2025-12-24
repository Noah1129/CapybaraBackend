require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Simple password hashing (for a game - not production banking!)
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

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
        // Create tables if they don't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                password_hash VARCHAR(64),
                display_name VARCHAR(50),
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
                last_seen TIMESTAMP DEFAULT NOW(),
                UNIQUE(username)
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

        // Add missing columns for migration (safe - doesn't error if exists)
        try {
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash VARCHAR(64);`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);`);

            // Inventory columns for cloud save
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owned_items JSONB DEFAULT '[]';`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owned_skins JSONB DEFAULT '["none"]';`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owned_pets JSONB DEFAULT '[]';`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_weapon VARCHAR(50);`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_armor VARCHAR(50);`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_pet VARCHAR(50);`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS pity_counter INTEGER DEFAULT 0;`);
            await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS achievements JSONB DEFAULT '[]';`);

            // Friends table
            await pool.query(`
                CREATE TABLE IF NOT EXISTS friends (
                    user_id VARCHAR(50) REFERENCES players(id),
                    friend_id VARCHAR(50) REFERENCES players(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    PRIMARY KEY (user_id, friend_id)
                );
            `);

            // Friend requests table
            await pool.query(`
                CREATE TABLE IF NOT EXISTS friend_requests (
                    id SERIAL PRIMARY KEY,
                    from_id VARCHAR(50) REFERENCES players(id),
                    to_id VARCHAR(50) REFERENCES players(id),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(from_id, to_id)
                );
            `);

            console.log('✅ Database migration complete');
        } catch (migrationErr) {
            console.log('⚠️ Migration skipped:', migrationErr.message);
        }

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

// Register new player
app.post('/api/player/register', async (req, res) => {
    const { username, password, displayName } = req.body;

    if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    try {
        // Check if username taken
        const existing = await pool.query('SELECT id FROM players WHERE username = $1', [username.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username already taken' });
        }

        // Create new player
        const playerId = uuidv4();
        const passwordHash = hashPassword(password);
        const result = await pool.query(
            'INSERT INTO players (id, username, password_hash, display_name) VALUES ($1, $2, $3, $4) RETURNING *',
            [playerId, username.toLowerCase(), passwordHash, displayName || username]
        );

        // Don't send password hash to client
        const player = { ...result.rows[0] };
        delete player.password_hash;

        res.json({ player, isNew: true });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login player
app.post('/api/player/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        const passwordHash = hashPassword(password);
        const result = await pool.query(
            'SELECT * FROM players WHERE username = $1 AND password_hash = $2',
            [username.toLowerCase(), passwordHash]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // Update last seen
        await pool.query('UPDATE players SET last_seen = NOW() WHERE id = $1', [result.rows[0].id]);

        // Don't send password hash to client
        const player = { ...result.rows[0] };
        delete player.password_hash;

        res.json({ player, isNew: false });
    } catch (err) {
        console.error('Login error:', err);
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

// ================= CLOUD SAVE - INVENTORY =================

// Get player inventory
app.get('/api/player/:id/inventory', async (req, res) => {
    const { id } = req.params;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        const result = await pool.query(
            `SELECT owned_items, owned_skins, owned_pets, equipped_weapon, equipped_armor, 
             equipped_skin, equipped_pet, pity_counter, achievements
             FROM players WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const player = result.rows[0];
        res.json({
            ownedItems: player.owned_items || [],
            ownedSkins: player.owned_skins || ['none'],
            ownedPets: player.owned_pets || [],
            equipped: {
                weapon: player.equipped_weapon || null,
                armor: player.equipped_armor || null,
                skin: player.equipped_skin || 'none',
                pet: player.equipped_pet || null
            },
            pityCounter: player.pity_counter || 0,
            achievements: player.achievements || []
        });
    } catch (err) {
        console.error('Inventory fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Save player inventory
app.put('/api/player/:id/inventory', async (req, res) => {
    const { id } = req.params;
    const { ownedItems, ownedSkins, ownedPets, equipped, pityCounter, achievements } = req.body;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        await pool.query(
            `UPDATE players SET 
                owned_items = $1,
                owned_skins = $2,
                owned_pets = $3,
                equipped_weapon = $4,
                equipped_armor = $5,
                equipped_skin = $6,
                equipped_pet = $7,
                pity_counter = $8,
                achievements = $9,
                last_seen = NOW()
             WHERE id = $10`,
            [
                JSON.stringify(ownedItems || []),
                JSON.stringify(ownedSkins || ['none']),
                JSON.stringify(ownedPets || []),
                equipped?.weapon || null,
                equipped?.armor || null,
                equipped?.skin || 'none',
                equipped?.pet || null,
                pityCounter || 0,
                JSON.stringify(achievements || []),
                id
            ]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Inventory save error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================= MATCH HISTORY =================

// Get player's match history
app.get('/api/player/:id/matches', async (req, res) => {
    const { id } = req.params;
    const { limit = 10 } = req.query;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        const result = await pool.query(
            `SELECT m.*, 
                    p1.username as player1_name, 
                    p2.username as player2_name
             FROM pvp_matches m
             LEFT JOIN players p1 ON m.player1_id = p1.id
             LEFT JOIN players p2 ON m.player2_id = p2.id
             WHERE m.player1_id = $1 OR m.player2_id = $1
             ORDER BY m.created_at DESC
             LIMIT $2`,
            [id, parseInt(limit)]
        );

        res.json(result.rows.map(match => ({
            id: match.id,
            opponent: match.player1_id === id ? match.player2_name : match.player1_name,
            won: match.winner_id === id,
            trophyChange: match.player1_id === id ? match.player1_trophies_change : match.player2_trophies_change,
            date: match.created_at
        })));
    } catch (err) {
        console.error('Match history error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================= FRIENDS SYSTEM =================

// Get friends list
app.get('/api/player/:id/friends', async (req, res) => {
    const { id } = req.params;

    if (!dbConnected) {
        return res.json({ friends: [], pending: [], requests: [] });
    }

    try {
        // Get confirmed friends
        const friendsResult = await pool.query(
            `SELECT p.id, p.username, p.display_name, p.trophies, p.equipped_skin, p.last_seen
             FROM friends f
             JOIN players p ON f.friend_id = p.id
             WHERE f.user_id = $1`,
            [id]
        );

        // Get pending requests I've sent
        const pendingResult = await pool.query(
            `SELECT fr.id as request_id, p.id, p.username, p.display_name, fr.created_at
             FROM friend_requests fr
             JOIN players p ON fr.to_id = p.id
             WHERE fr.from_id = $1 AND fr.status = 'pending'`,
            [id]
        );

        // Get requests others sent me
        const requestsResult = await pool.query(
            `SELECT fr.id as request_id, p.id, p.username, p.display_name, p.trophies, fr.created_at
             FROM friend_requests fr
             JOIN players p ON fr.from_id = p.id
             WHERE fr.to_id = $1 AND fr.status = 'pending'`,
            [id]
        );

        res.json({
            friends: friendsResult.rows,
            pending: pendingResult.rows,
            requests: requestsResult.rows
        });
    } catch (err) {
        console.error('Friends fetch error:', err);
        res.json({ friends: [], pending: [], requests: [] });
    }
});

// Send friend request
app.post('/api/player/:id/friends/request', async (req, res) => {
    const { id } = req.params;
    const { friendUsername } = req.body;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        // Find friend by username
        const friendResult = await pool.query(
            'SELECT id FROM players WHERE username = $1',
            [friendUsername]
        );

        if (friendResult.rows.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const friendId = friendResult.rows[0].id;

        if (friendId === id) {
            return res.status(400).json({ error: 'Cannot add yourself' });
        }

        // Check if already friends
        const existingFriend = await pool.query(
            'SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2',
            [id, friendId]
        );
        if (existingFriend.rows.length > 0) {
            return res.status(400).json({ error: 'Already friends!' });
        }

        // Check if request already exists
        const existingRequest = await pool.query(
            'SELECT 1 FROM friend_requests WHERE from_id = $1 AND to_id = $2 AND status = \'pending\'',
            [id, friendId]
        );
        if (existingRequest.rows.length > 0) {
            return res.status(400).json({ error: 'Request already sent' });
        }

        // Create friend request
        await pool.query(
            'INSERT INTO friend_requests (from_id, to_id, status) VALUES ($1, $2, \'pending\') ON CONFLICT (from_id, to_id) DO UPDATE SET status = \'pending\'',
            [id, friendId]
        );

        res.json({ success: true, message: 'Friend request sent!' });
    } catch (err) {
        console.error('Send request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Accept friend request
app.post('/api/player/:id/friends/accept/:requestId', async (req, res) => {
    const { id, requestId } = req.params;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        // Get the request
        const requestResult = await pool.query(
            'SELECT from_id, to_id FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = \'pending\'',
            [requestId, id]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const { from_id, to_id } = requestResult.rows[0];

        // Add friendship both ways
        await pool.query(
            'INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING',
            [from_id, to_id]
        );

        // Mark request as accepted
        await pool.query(
            'UPDATE friend_requests SET status = \'accepted\' WHERE id = $1',
            [requestId]
        );

        res.json({ success: true, message: 'Friend added!' });
    } catch (err) {
        console.error('Accept request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Decline friend request
app.post('/api/player/:id/friends/decline/:requestId', async (req, res) => {
    const { id, requestId } = req.params;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        await pool.query(
            'UPDATE friend_requests SET status = \'declined\' WHERE id = $1 AND to_id = $2',
            [requestId, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Decline request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove friend  
app.delete('/api/player/:id/friends/:friendId', async (req, res) => {
    const { id, friendId } = req.params;

    if (!dbConnected) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        // Remove both directions
        await pool.query(
            'DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
            [id, friendId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Remove friend error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================= SOCKET.IO - TURN-BASED PVP =================
const waitingPlayers = [];
const activeMatches = new Map();

// Battle state structure per match
const createBattleState = (player1, player2) => ({
    turn: 1,
    players: {
        [player1.playerId]: {
            ...player1,
            hp: 100,
            maxHp: 100,
            action: null,
            specialCooldown: 0
        },
        [player2.playerId]: {
            ...player2,
            hp: 100,
            maxHp: 100,
            action: null,
            specialCooldown: 0
        }
    },
    playerIds: [player1.playerId, player2.playerId],
    status: 'waiting_actions' // 'waiting_actions', 'resolving', 'finished'
});

// Resolve turn when both players have submitted actions
const resolveTurn = (matchId, match) => {
    const battle = match.battleState;
    const [p1Id, p2Id] = battle.playerIds;
    const p1 = battle.players[p1Id];
    const p2 = battle.players[p2Id];

    // Calculate damage
    let p1Damage = 0;
    let p2Damage = 0;

    // Player 1 action
    if (p1.action === 'attack') {
        p1Damage = 15 + Math.floor(Math.random() * 11); // 15-25
    } else if (p1.action === 'special' && p1.specialCooldown === 0) {
        p1Damage = 30;
        p1.specialCooldown = 2;
    }

    // Player 2 action
    if (p2.action === 'attack') {
        p2Damage = 15 + Math.floor(Math.random() * 11);
    } else if (p2.action === 'special' && p2.specialCooldown === 0) {
        p2Damage = 30;
        p2.specialCooldown = 2;
    }

    // Apply defense reduction
    if (p2.action === 'defend') p1Damage = Math.floor(p1Damage * 0.5);
    if (p1.action === 'defend') p2Damage = Math.floor(p2Damage * 0.5);

    // Apply damage
    p1.hp = Math.max(0, p1.hp - p2Damage);
    p2.hp = Math.max(0, p2.hp - p1Damage);

    // Reduce cooldowns
    if (p1.specialCooldown > 0 && p1.action !== 'special') p1.specialCooldown--;
    if (p2.specialCooldown > 0 && p2.action !== 'special') p2.specialCooldown--;

    // Prepare turn result
    const turnResult = {
        turn: battle.turn,
        actions: {
            [p1Id]: p1.action,
            [p2Id]: p2.action
        },
        damage: {
            [p1Id]: p2Damage, // Damage taken by p1
            [p2Id]: p1Damage  // Damage taken by p2
        },
        hp: {
            [p1Id]: p1.hp,
            [p2Id]: p2.hp
        },
        specialCooldown: {
            [p1Id]: p1.specialCooldown,
            [p2Id]: p2.specialCooldown
        }
    };

    // Check for winner
    let winner = null;
    if (p1.hp <= 0 && p2.hp <= 0) {
        winner = p1.hp > p2.hp ? p1Id : p2Id; // Whoever has more HP wins tie
    } else if (p1.hp <= 0) {
        winner = p2Id;
    } else if (p2.hp <= 0) {
        winner = p1Id;
    }

    // Send turn result to both players
    match.players.forEach(p => {
        io.to(p.socketId).emit('pvp:turn_result', {
            ...turnResult,
            yourId: p.playerId,
            opponentId: p.playerId === p1Id ? p2Id : p1Id
        });
    });

    if (winner) {
        battle.status = 'finished';
        const winnerTrophyGain = 20;
        const loserTrophyLoss = 10;

        match.players.forEach(p => {
            const isWinner = p.playerId === winner;
            io.to(p.socketId).emit('pvp:battle_end', {
                winner: winner,
                won: isWinner,
                trophyChange: isWinner ? winnerTrophyGain : -loserTrophyLoss
            });
        });

        console.log(`🏆 Match ${matchId} ended. Winner: ${winner}`);
        activeMatches.delete(matchId);
    } else {
        // Reset actions for next turn
        p1.action = null;
        p2.action = null;
        battle.turn++;
        battle.status = 'waiting_actions';
    }
};

io.on('connection', (socket) => {
    console.log('🔌 Player connected:', socket.id);

    // Join matchmaking queue
    socket.on('pvp:queue', (playerData) => {
        console.log('📋 Player queued:', playerData.username);

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
        tryMatchPlayers();
    });

    // Leave queue
    socket.on('pvp:leave', () => {
        const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
        if (index > -1) waitingPlayers.splice(index, 1);
    });

    // Submit turn action
    socket.on('pvp:submit_action', (data) => {
        const { matchId, action } = data;
        const match = activeMatches.get(matchId);
        if (!match || match.battleState.status !== 'waiting_actions') return;

        // Find which player this is
        const player = match.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const battlePlayer = match.battleState.players[player.playerId];
        if (!battlePlayer || battlePlayer.action) return; // Already submitted

        // Validate action
        if (!['attack', 'defend', 'special'].includes(action)) return;
        if (action === 'special' && battlePlayer.specialCooldown > 0) {
            socket.emit('pvp:action_error', { error: 'Special is on cooldown!' });
            return;
        }

        battlePlayer.action = action;
        console.log(`⚔️ ${player.username} chose: ${action}`);

        // Notify opponent that we're ready
        const opponent = match.players.find(p => p.socketId !== socket.id);
        if (opponent) {
            io.to(opponent.socketId).emit('pvp:opponent_ready');
        }

        // Check if both players have submitted
        const allSubmitted = match.battleState.playerIds.every(
            id => match.battleState.players[id].action !== null
        );

        if (allSubmitted) {
            match.battleState.status = 'resolving';
            resolveTurn(matchId, match);
        }
    });

    // ==================== GLOBAL CHAT ====================
    socket.on('chat:send', (data) => {
        const { username, message } = data;
        if (!username || !message || message.length > 200) return;

        // Broadcast to all connected users
        io.emit('chat:message', {
            id: Date.now(),
            username,
            message: message.trim().slice(0, 200),
            timestamp: new Date().toISOString()
        });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Player disconnected:', socket.id);

        const index = waitingPlayers.findIndex(p => p.socketId === socket.id);
        if (index > -1) waitingPlayers.splice(index, 1);

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

    const player1 = waitingPlayers.shift();
    const player2 = waitingPlayers.shift();

    const matchId = uuidv4();

    const match = {
        id: matchId,
        players: [player1, player2],
        battleState: createBattleState(player1, player2),
        startedAt: Date.now()
    };

    activeMatches.set(matchId, match);

    // Notify both players with battle info
    io.to(player1.socketId).emit('pvp:match_found', {
        matchId,
        yourId: player1.playerId,
        opponent: {
            id: player2.playerId,
            username: player2.username,
            trophies: player2.trophies
        },
        startHp: 100
    });

    io.to(player2.socketId).emit('pvp:match_found', {
        matchId,
        yourId: player2.playerId,
        opponent: {
            id: player1.playerId,
            username: player1.username,
            trophies: player1.trophies
        },
        startHp: 100
    });

    console.log(`⚔️ Turn-based match started: ${player1.username} vs ${player2.username}`);
}

// ================= GUILD SYSTEM =================

// In-memory guild storage (also persisted to DB if available)
const guilds = new Map();
const guildInvites = new Map(); // playerId -> array of guild invites
const guildBossDamage = new Map(); // guildId -> { playerId: damage }

// Guild boss config
const GUILD_BOSS = {
    maxHp: 10000000, // 10 million
    dailyAttacks: 3,
    coinsPerDamage: 1000, // 1 coin per 1000 damage
};

// Initialize guild tables in DB
const initGuildTables = async () => {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS guilds (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(50) NOT NULL UNIQUE,
                leader_id VARCHAR(50) REFERENCES players(id),
                level INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT NOW(),
                boss_hp INTEGER DEFAULT 10000000,
                boss_last_reset DATE DEFAULT CURRENT_DATE
            );
            
            CREATE TABLE IF NOT EXISTS guild_members (
                guild_id VARCHAR(50) REFERENCES guilds(id) ON DELETE CASCADE,
                player_id VARCHAR(50) REFERENCES players(id) ON DELETE CASCADE,
                role VARCHAR(20) DEFAULT 'member',
                guild_coins INTEGER DEFAULT 0,
                joined_at TIMESTAMP DEFAULT NOW(),
                daily_attacks INTEGER DEFAULT 3,
                last_attack_date DATE DEFAULT CURRENT_DATE,
                PRIMARY KEY (guild_id, player_id)
            );
            
            CREATE TABLE IF NOT EXISTS guild_boss_damage (
                guild_id VARCHAR(50) REFERENCES guilds(id) ON DELETE CASCADE,
                player_id VARCHAR(50) REFERENCES players(id) ON DELETE CASCADE,
                damage INTEGER DEFAULT 0,
                damage_date DATE DEFAULT CURRENT_DATE,
                PRIMARY KEY (guild_id, player_id, damage_date)
            );
            
            CREATE TABLE IF NOT EXISTS guild_invites (
                id SERIAL PRIMARY KEY,
                guild_id VARCHAR(50) REFERENCES guilds(id) ON DELETE CASCADE,
                from_player_id VARCHAR(50) REFERENCES players(id),
                to_player_id VARCHAR(50) REFERENCES players(id),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Guild tables initialized');
    } catch (err) {
        console.log('⚠️ Guild tables error:', err.message);
    }
};

// Create guild
app.post('/api/guilds/create', async (req, res) => {
    const { playerId, guildName } = req.body;

    if (!playerId || !guildName || guildName.length < 3) {
        return res.status(400).json({ error: 'Guild name must be at least 3 characters' });
    }

    try {
        // Check if player already in a guild
        if (pool) {
            const existing = await pool.query(
                'SELECT guild_id FROM guild_members WHERE player_id = $1',
                [playerId]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'You are already in a guild' });
            }

            // Check if guild name taken
            const nameTaken = await pool.query(
                'SELECT id FROM guilds WHERE LOWER(name) = LOWER($1)',
                [guildName]
            );
            if (nameTaken.rows.length > 0) {
                return res.status(400).json({ error: 'Guild name already taken' });
            }

            // Create guild
            const guildId = uuidv4();
            await pool.query(
                'INSERT INTO guilds (id, name, leader_id) VALUES ($1, $2, $3)',
                [guildId, guildName, playerId]
            );

            // Add leader as member
            await pool.query(
                'INSERT INTO guild_members (guild_id, player_id, role) VALUES ($1, $2, $3)',
                [guildId, playerId, 'leader']
            );

            res.json({
                success: true,
                guild: { id: guildId, name: guildName, level: 1 }
            });
        } else {
            // In-memory fallback
            const guildId = uuidv4();
            guilds.set(guildId, {
                id: guildId,
                name: guildName,
                leaderId: playerId,
                level: 1,
                members: [{ playerId, role: 'leader', guildCoins: 0 }],
                bossHp: GUILD_BOSS.maxHp,
            });
            res.json({ success: true, guild: { id: guildId, name: guildName, level: 1 } });
        }
    } catch (err) {
        console.error('Create guild error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// List all guilds
app.get('/api/guilds', async (req, res) => {
    try {
        if (pool) {
            const result = await pool.query(`
                SELECT g.*, 
                    (SELECT COUNT(*) FROM guild_members WHERE guild_id = g.id) as member_count,
                    p.username as leader_name
                FROM guilds g
                LEFT JOIN players p ON g.leader_id = p.id
                ORDER BY g.level DESC, g.created_at DESC
                LIMIT 50
            `);
            res.json({ guilds: result.rows });
        } else {
            const guildList = Array.from(guilds.values()).map(g => ({
                ...g,
                member_count: g.members.length
            }));
            res.json({ guilds: guildList });
        }
    } catch (err) {
        console.error('List guilds error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get guild details
app.get('/api/guilds/:guildId', async (req, res) => {
    const { guildId } = req.params;

    try {
        if (pool) {
            const guildResult = await pool.query('SELECT * FROM guilds WHERE id = $1', [guildId]);
            if (guildResult.rows.length === 0) {
                return res.status(404).json({ error: 'Guild not found' });
            }

            const membersResult = await pool.query(`
                SELECT gm.*, p.username, p.trophies
                FROM guild_members gm
                JOIN players p ON gm.player_id = p.id
                WHERE gm.guild_id = $1
                ORDER BY gm.role = 'leader' DESC, gm.joined_at ASC
            `, [guildId]);

            // Get today's boss damage
            const damageResult = await pool.query(`
                SELECT player_id, damage FROM guild_boss_damage
                WHERE guild_id = $1 AND damage_date = CURRENT_DATE
                ORDER BY damage DESC
            `, [guildId]);

            res.json({
                guild: guildResult.rows[0],
                members: membersResult.rows,
                bossDamage: damageResult.rows
            });
        } else {
            const guild = guilds.get(guildId);
            if (!guild) {
                return res.status(404).json({ error: 'Guild not found' });
            }
            res.json({ guild, members: guild.members, bossDamage: [] });
        }
    } catch (err) {
        console.error('Get guild error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get player's guild
app.get('/api/guilds/player/:playerId', async (req, res) => {
    const { playerId } = req.params;

    try {
        if (pool) {
            const result = await pool.query(`
                SELECT g.*, gm.role, gm.guild_coins, gm.daily_attacks
                FROM guild_members gm
                JOIN guilds g ON gm.guild_id = g.id
                WHERE gm.player_id = $1
            `, [playerId]);

            if (result.rows.length === 0) {
                return res.json({ guild: null });
            }

            // Get member count
            const memberCount = await pool.query(
                'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
                [result.rows[0].id]
            );

            res.json({
                guild: {
                    ...result.rows[0],
                    member_count: parseInt(memberCount.rows[0].count)
                }
            });
        } else {
            for (const guild of guilds.values()) {
                const member = guild.members.find(m => m.playerId === playerId);
                if (member) {
                    return res.json({ guild: { ...guild, role: member.role } });
                }
            }
            res.json({ guild: null });
        }
    } catch (err) {
        console.error('Get player guild error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Join guild
app.post('/api/guilds/:guildId/join', async (req, res) => {
    const { guildId } = req.params;
    const { playerId } = req.body;

    try {
        if (pool) {
            // Check if already in a guild
            const existing = await pool.query(
                'SELECT guild_id FROM guild_members WHERE player_id = $1',
                [playerId]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'Already in a guild' });
            }

            // Check guild exists
            const guild = await pool.query('SELECT * FROM guilds WHERE id = $1', [guildId]);
            if (guild.rows.length === 0) {
                return res.status(404).json({ error: 'Guild not found' });
            }

            // Join
            await pool.query(
                'INSERT INTO guild_members (guild_id, player_id, role) VALUES ($1, $2, $3)',
                [guildId, playerId, 'member']
            );

            res.json({ success: true });
        } else {
            const guild = guilds.get(guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });
            guild.members.push({ playerId, role: 'member', guildCoins: 0 });
            res.json({ success: true });
        }
    } catch (err) {
        console.error('Join guild error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Leave guild
app.post('/api/guilds/:guildId/leave', async (req, res) => {
    const { guildId } = req.params;
    const { playerId } = req.body;

    try {
        if (pool) {
            // Check if leader
            const guild = await pool.query('SELECT leader_id FROM guilds WHERE id = $1', [guildId]);
            if (guild.rows[0]?.leader_id === playerId) {
                return res.status(400).json({ error: 'Leader cannot leave. Transfer leadership first.' });
            }

            await pool.query(
                'DELETE FROM guild_members WHERE guild_id = $1 AND player_id = $2',
                [guildId, playerId]
            );
            res.json({ success: true });
        } else {
            const guild = guilds.get(guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });
            guild.members = guild.members.filter(m => m.playerId !== playerId);
            res.json({ success: true });
        }
    } catch (err) {
        console.error('Leave guild error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send invite
app.post('/api/guilds/:guildId/invite', async (req, res) => {
    const { guildId } = req.params;
    const { fromPlayerId, toUsername } = req.body;

    try {
        if (pool) {
            // Find target player
            const target = await pool.query(
                'SELECT id FROM players WHERE LOWER(username) = LOWER($1)',
                [toUsername]
            );
            if (target.rows.length === 0) {
                return res.status(404).json({ error: 'Player not found' });
            }
            const toPlayerId = target.rows[0].id;

            // Check if already in guild
            const existing = await pool.query(
                'SELECT guild_id FROM guild_members WHERE player_id = $1',
                [toPlayerId]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'Player is already in a guild' });
            }

            // Create invite
            await pool.query(
                'INSERT INTO guild_invites (guild_id, from_player_id, to_player_id) VALUES ($1, $2, $3)',
                [guildId, fromPlayerId, toPlayerId]
            );

            res.json({ success: true });
        } else {
            res.json({ success: true, message: 'Invite sent (in-memory mode)' });
        }
    } catch (err) {
        console.error('Invite error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get pending invites for player
app.get('/api/guilds/invites/:playerId', async (req, res) => {
    const { playerId } = req.params;

    try {
        if (pool) {
            const result = await pool.query(`
                SELECT gi.*, g.name as guild_name, p.username as from_username
                FROM guild_invites gi
                JOIN guilds g ON gi.guild_id = g.id
                JOIN players p ON gi.from_player_id = p.id
                WHERE gi.to_player_id = $1 AND gi.status = 'pending'
            `, [playerId]);
            res.json({ invites: result.rows });
        } else {
            res.json({ invites: guildInvites.get(playerId) || [] });
        }
    } catch (err) {
        console.error('Get invites error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Accept invite
app.post('/api/guilds/invites/:inviteId/accept', async (req, res) => {
    const { inviteId } = req.params;
    const { playerId } = req.body;

    try {
        if (pool) {
            // Get invite
            const invite = await pool.query(
                'SELECT * FROM guild_invites WHERE id = $1 AND to_player_id = $2 AND status = $3',
                [inviteId, playerId, 'pending']
            );
            if (invite.rows.length === 0) {
                return res.status(404).json({ error: 'Invite not found' });
            }

            const guildId = invite.rows[0].guild_id;

            // Join guild
            await pool.query(
                'INSERT INTO guild_members (guild_id, player_id, role) VALUES ($1, $2, $3)',
                [guildId, playerId, 'member']
            );

            // Mark invite as accepted
            await pool.query(
                'UPDATE guild_invites SET status = $1 WHERE id = $2',
                ['accepted', inviteId]
            );

            res.json({ success: true, guildId });
        } else {
            res.json({ success: true });
        }
    } catch (err) {
        console.error('Accept invite error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Attack guild boss
app.post('/api/guilds/:guildId/boss/attack', async (req, res) => {
    const { guildId } = req.params;
    const { playerId } = req.body;

    // Random damage between 50k-150k
    const damage = Math.floor(50000 + Math.random() * 100000);
    const coinsEarned = Math.floor(damage / GUILD_BOSS.coinsPerDamage);

    try {
        if (pool) {
            // Check attacks remaining
            const member = await pool.query(`
                SELECT daily_attacks, last_attack_date 
                FROM guild_members 
                WHERE guild_id = $1 AND player_id = $2
            `, [guildId, playerId]);

            if (member.rows.length === 0) {
                return res.status(400).json({ error: 'Not a guild member' });
            }

            let attacksLeft = member.rows[0].daily_attacks;
            const lastDate = member.rows[0].last_attack_date;
            const today = new Date().toISOString().split('T')[0];

            // Reset if new day
            if (lastDate !== today) {
                attacksLeft = GUILD_BOSS.dailyAttacks;
            }

            if (attacksLeft <= 0) {
                return res.status(400).json({ error: 'No attacks remaining today' });
            }

            // Record damage
            await pool.query(`
                INSERT INTO guild_boss_damage (guild_id, player_id, damage, damage_date)
                VALUES ($1, $2, $3, CURRENT_DATE)
                ON CONFLICT (guild_id, player_id, damage_date)
                DO UPDATE SET damage = guild_boss_damage.damage + $3
            `, [guildId, playerId, damage]);

            // Update attacks and coins
            await pool.query(`
                UPDATE guild_members 
                SET daily_attacks = $1, last_attack_date = CURRENT_DATE, guild_coins = guild_coins + $2
                WHERE guild_id = $3 AND player_id = $4
            `, [attacksLeft - 1, coinsEarned, guildId, playerId]);

            // Update guild boss HP
            await pool.query(`
                UPDATE guilds SET boss_hp = GREATEST(0, boss_hp - $1) WHERE id = $2
            `, [damage, guildId]);

            res.json({
                success: true,
                damage,
                coinsEarned,
                attacksLeft: attacksLeft - 1
            });
        } else {
            const guild = guilds.get(guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });
            guild.bossHp = Math.max(0, guild.bossHp - damage);
            res.json({ success: true, damage, coinsEarned, attacksLeft: 2 });
        }
    } catch (err) {
        console.error('Boss attack error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get boss status
app.get('/api/guilds/:guildId/boss', async (req, res) => {
    const { guildId } = req.params;

    try {
        if (pool) {
            const guild = await pool.query('SELECT boss_hp FROM guilds WHERE id = $1', [guildId]);
            const damage = await pool.query(`
                SELECT gbd.player_id, gbd.damage, p.username
                FROM guild_boss_damage gbd
                JOIN players p ON gbd.player_id = p.id
                WHERE gbd.guild_id = $1 AND gbd.damage_date = CURRENT_DATE
                ORDER BY gbd.damage DESC
                LIMIT 10
            `, [guildId]);

            res.json({
                bossHp: guild.rows[0]?.boss_hp || GUILD_BOSS.maxHp,
                maxHp: GUILD_BOSS.maxHp,
                leaderboard: damage.rows
            });
        } else {
            const guild = guilds.get(guildId);
            res.json({
                bossHp: guild?.bossHp || GUILD_BOSS.maxHp,
                maxHp: GUILD_BOSS.maxHp,
                leaderboard: []
            });
        }
    } catch (err) {
        console.error('Get boss status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Initialize guild tables on startup
initGuildTables();


// ================= START SERVER =================
const PORT = process.env.PORT || 3001;

initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🎮 Capybara Adventure Backend Ready!`);
    });
});
