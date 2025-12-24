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

// ================= START SERVER =================
const PORT = process.env.PORT || 3001;

initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🎮 Capybara Adventure Backend Ready!`);
    });
});
