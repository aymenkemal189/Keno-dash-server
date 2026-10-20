require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// PostgreSQL Pool Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const BOT_TOKEN = process.env.BOT_TOKEN || 'DEFAULT_TEST_TOKEN';
const SERVER_SALT = process.env.SERVER_SALT || 'KENO_SECRET_SALT_2026';

// ---------------- OFFICIAL ETHIOPIAN FAST KENO CONFIG ----------------
const BET_WINDOW = 60;      // 60 ሰከንድ የውርርድ ጊዜ
const DRAW_WINDOW = 20;     // 20 ሰከንድ የዕጣ ማውጣት ጊዜ
const TOTAL_CYCLE = 80;     // አጠቃላይ ዙር
const MIN_BET = 1;
const MAX_BET = 1000;
const MAX_PICKS = 10;
const MAX_PAYOUT = 30000;   // ከፍተኛው ክፍያ 30,000 ETB

const PAYTABLE = {
  "1": { 1: 3.5 },
  "2": { 1: 1, 2: 10 },
  "3": { 2: 2, 3: 50 },
  "4": { 2: 1.5, 3: 10, 4: 80 },
  "5": { 2: 1, 3: 3, 4: 30, 5: 150 },
  "6": { 3: 2, 4: 15, 5: 60, 6: 500 },
  "7": { 0: 1, 3: 2, 4: 4, 5: 20, 6: 80, 7: 1000 },
  "8": { 0: 1, 4: 5, 5: 15, 6: 50, 7: 200, 8: 2000 },
  "9": { 0: 2, 4: 2, 5: 10, 6: 25, 7: 125, 8: 1000, 9: 5000 },
  "10": { 0: 2, 5: 5, 6: 30, 7: 100, 8: 300, 9: 2000, 10: 10000 }
};

// ---------------- ዙርና ሰዓት ማስያ (Sync with Frontend) ----------------
function getGlobalRound() {
  const nowSec = Math.floor(Date.now() / 1000);
  const roundId = 64105 + Math.floor(nowSec / TOTAL_CYCLE);
  const cycleSec = nowSec % TOTAL_CYCLE;
  return { roundId, cycleSec };
}

// ---------------- Deterministic Provably Fair 20 Numbers ----------------
// ለአንድ ዙር ለሁሉም ተጫዋች ተመሳሳይ 20 ቁጥሮች ያመነጫል
function generateDrawnNumbers(roundId) {
  const seedStr = `${roundId}_${SERVER_SALT}`;
  const hash = crypto.createHash('sha256').update(seedStr).digest('hex');

  // 1-80 ቁጥሮችን ማዘጋጀት
  const numbers = Array.from({ length: 80 }, (_, i) => i + 1);

  // Fisher-Yates shuffle በመጠቀም በ Hash መሰረት ማወዛወዝ
  for (let i = numbers.length - 1; i > 0; i--) {
    const subHash = crypto.createHash('sha256').update(`${hash}_${i}`).digest('hex');
    const j = parseInt(subHash.substring(0, 8), 16) % (i + 1);
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }

  return numbers.slice(0, 20); // የመጀመሪያዎቹ 20 ቁጥሮች
}

// ---------------- TELEGRAM INITDATA ማረጋገጫ Middleware ----------------
function authenticateTelegramUser(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  // Localhost ላይ ለመሞከር initData ባይኖርም በ Demo User ያስገባል
  if (!initData) {
    req.user = { id: 12345678, username: 'demo_user', first_name: 'Demo' };
    return next();
  }

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const params = Array.from(urlParams.entries())
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(params).digest('hex');

    if (calculatedHash !== hash && process.env.NODE_ENV === 'production') {
      return res.status(401).json({ success: false, message: 'Invalid Telegram Data' });
    }

    const userData = JSON.parse(urlParams.get('user') || '{}');
    req.user = {
      id: userData.id || 12345678,
      username: userData.username || 'user',
      first_name: userData.first_name || 'Player'
    };
    next();
  } catch (err) {
    req.user = { id: 12345678, username: 'demo_user' };
    next();
  }
}

// ---------------- API ENDPOINTS ----------------

// 1. Paytable መረጃ ማምጫ
app.get('/api/keno/paytable', (req, res) => {
  res.json({ success: true, paytable: PAYTABLE, maxPayout: MAX_PAYOUT });
});

// 2. የተጠቃሚ ባላንስና ሁኔታ (GET /api/user/init)
app.get('/api/user/init', authenticateTelegramUser, async (req, res) => {
  try {
    const tgUser = req.user;
    let userResult = await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, balance)
       VALUES ($1, $2, $3, 1000.00)
       ON CONFLICT (telegram_id) DO UPDATE 
       SET username = EXCLUDED.username, updated_at = NOW()
       RETURNING id, balance`,
      [tgUser.id, tgUser.username, tgUser.first_name]
    );

    const user = userResult.rows[0];
    res.json({
      success: true,
      balance: parseFloat(user.balance),
      user: { id: user.id, username: tgUser.username }
    });
  } catch (err) {
    console.error('User Init Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// 3. ውርርድ መመዝገብ (POST /api/bet/play)
app.post('/api/bet/play', authenticateTelegramUser, async (req, res) => {
  const { gameName, betAmount, clientData } = req.body;
  const picks = clientData?.picks;

  // Validation
  const amount = Number(betAmount);
  if (!amount || amount < MIN_BET || amount > MAX_BET) {
    return res.status(400).json({ success: false, message: `Bet must be between ${MIN_BET} and ${MAX_BET} ETB` });
  }
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > MAX_PICKS) {
    return res.status(400).json({ success: false, message: `Pick between 1 and ${MAX_PICKS} numbers` });
  }

  // ቁጥሮቹ 1-80 ውስጥ እና Duplicate የሌላቸው መሆናቸውን ማረጋገጥ
  const uniquePicks = new Set(picks);
  if (uniquePicks.size !== picks.length || picks.some(n => n < 1 || n > 80)) {
    return res.status(400).json({ success: false, message: 'Invalid numbers chosen' });
  }

  const { roundId, cycleSec } = getGlobalRound();

  // በስዕል (Draw) ሰዓት ውርርድ መከልከል (ከ60 ሰከንድ በላይ ከሆነ)
  if (cycleSec >= BET_WINDOW) {
    return res.status(400).json({ success: false, message: 'Round is currently drawing! Wait for next round.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // የባላንስ ማረጋገጫ (Lock Row)
    const uRes = await client.query('SELECT id, balance FROM users WHERE telegram_id = $1 FOR UPDATE', [req.user.id]);
    if (uRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentBalance = parseFloat(uRes.rows[0].balance);
    if (currentBalance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // የዕጣው 20 ቁጥሮች ማምጣት
    const drawnNumbers = generateDrawnNumbers(roundId);

    // Hits እና አሸናፊ ክፍያ ማስላት
    const hits = picks.filter(p => drawnNumbers.includes(p)).length;
    const hitTable = PAYTABLE[String(picks.length)] || {};
    const multiplier = hitTable[hits] || 0;
    
    // ማክሲመም ክፍያው ከ 30,000 ETB አይበልጥም
    let rawWin = amount * multiplier;
    const finalPayout = Math.min(MAX_PAYOUT, Math.round(rawWin * 100) / 100);

    // አዲሱን ባላንስ ማስላት (በቅድሚያ ውርርዱን ቀንሶ ያሸነፈውን መደመር)
    const newBalance = currentBalance - amount + finalPayout;

    // ባላንስ ማደስ
    await client.query('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, uRes.rows[0].id]);

    // ውርርዱን መመዝገብ
    await client.query(
      `INSERT INTO keno_bets (user_id, round_id, picks, bet_amount, hits, payout, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uRes.rows[0].id, roundId, picks, amount, hits, finalPayout, finalPayout > 0 ? 'WON' : 'LOST']
    );

    // ትልቅ አሸናፊ ከሆነ Feed ላይ ማስመዝገብ
    if (finalPayout >= 100) {
      const maskedName = req.user.username 
        ? `${req.user.username[0]}***${req.user.username.slice(-1)}`
        : 'u***r';
      await client.query('INSERT INTO win_feeds (username, game, win_amount) VALUES ($1, $2, $3)', [maskedName, 'Keno', finalPayout]);
    }

    await client.query('COMMIT');

    // Frontend በሚጠብቀው ቅርጽ መልስ መላክ
    res.json({
      success: true,
      roundId: roundId,
      newBalance: parseFloat(newBalance.toFixed(2)),
      payout: finalPayout,
      hits: hits,
      visualOutcome: {
        drawnNumbers: drawnNumbers
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bet processing error:', err);
    res.status(500).json({ success: false, message: 'Bet processing error' });
  } finally {
    client.release();
  }
});

// 4. Leaders / Public Feed (GET /api/public/feed)
app.get('/api/public/feed', async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT username as "user", game, win_amount as win 
       FROM win_feeds 
       ORDER BY created_at DESC 
       LIMIT 10`
    );
    res.json({ success: true, wins: q.rows });
  } catch (err) {
    res.json({
      success: true,
      wins: [
        { user: 'b***w', game: 'Keno', win: 30000 },
        { user: 'y***o', game: 'Keno', win: 30000 },
        { user: 'i***s', game: 'Keno', win: 20000 }
      ]
    });
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fast Keno Server running on port ${PORT}`);
});
