require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ================= DATABASE CONNECTION ================= //
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('Keno DB Pool Notice:', err.message));

// ================= SECRETS & CONFIG ================= //
const BOT_TOKEN = process.env.BOT_TOKEN || 'DEFAULT_TEST_BOT_TOKEN';
const SERVER_SALT = process.env.SERVER_SALT || 'KENO_DETERMINISTIC_SALT_2026';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dash_keno_admin_master_2026';
const DASH_BINGO_URL = process.env.DASH_BINGO_URL || 'https://dashserver-c9w5.onrender.com';
const KENO_SHARED_SECRET = process.env.KENO_SHARED_SECRET || 'FAST_KENO_DASH_SECRET_KEY_2026';

// ---------------- OFFICIAL ETHIOPIAN KENO CONFIG ----------------
const BET_WINDOW = 60;   // 60s የውርርድ ጊዜ
const DRAW_WINDOW = 20;  // 20s የ 20 ኳሶች እጣ ማውጣት ጊዜ
const TOTAL_CYCLE = 80;  // 80s ዑደት
const MIN_BET = 1;
const MAX_BET = 1000;
const MAX_PAYOUT = 30000;

// Official Paytable
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

// ---------------- 24/7 GLOBAL CLOCK ENGINE ----------------
function getGlobalRound() {
  const nowSec = Math.floor(Date.now() / 1000);
  const roundId = 64105 + Math.floor(nowSec / TOTAL_CYCLE);
  const cycleSec = nowSec % TOTAL_CYCLE;
  const isDrawing = cycleSec >= BET_WINDOW;
  const remainingSec = isDrawing ? (TOTAL_CYCLE - cycleSec) : (BET_WINDOW - cycleSec);
  return { roundId, cycleSec, isDrawing, remainingSec };
}

// ---------------- PROVABLY FAIR 20 NUMBERS GENERATOR ----------------
// ለአንድ ዙር ለሁሉም ተጫዋቾች 100% ተመሳሳይና ፍትሃዊ 20 ቁጥሮች ያመነጫል
function generateDrawnNumbers(roundId) {
  const seed = `${roundId}_${SERVER_SALT}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const poolNumbers = Array.from({ length: 80 }, (_, i) => i + 1);

  for (let i = poolNumbers.length - 1; i > 0; i--) {
    const subHash = crypto.createHash('sha256').update(`${hash}_${i}`).digest('hex');
    const j = parseInt(subHash.substring(0, 8), 16) % (i + 1);
    [poolNumbers[i], poolNumbers[j]] = [poolNumbers[j], poolNumbers[i]];
  }

  return poolNumbers.slice(0, 20);
}

// ---------------- TELEGRAM AUTHENTICATION MIDDLEWARE ----------------
function authenticateTelegram(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  // ሎካል ላይ ወይም ያለ ቴሌግራም ሲሞክሩ የሚሰራ Demo ተጠቃሚ
  if (!initData) {
    req.user = { id: 12345678, username: 'demo_player', first_name: 'Demo' };
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
      return res.status(401).json({ success: false, message: 'Invalid Telegram Session' });
    }

    const userData = JSON.parse(urlParams.get('user') || '{}');
    req.user = {
      id: userData.id || 12345678,
      username: userData.username || '',
      first_name: userData.first_name || 'Player'
    };
    next();
  } catch (e) {
    req.user = { id: 12345678, username: 'demo_player', first_name: 'Demo' };
    next();
  }
}

// ---------------- ADMIN AUTH MIDDLEWARE ----------------
function checkAdminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (key !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'ያልተፈቀደ የአድሚን መዳረሻ!' });
  }
  next();
}

// ================= USER GAME APIS ================= //

// 1. Paytable መረጃ
app.get('/api/keno/paytable', (req, res) => {
  res.json({ success: true, paytable: PAYTABLE, maxPayout: MAX_PAYOUT });
});

// 2. ተጠቃሚ ወደ ኬኖ ሲገባ ባላንስና ዙር ማምጫ (GET /api/user/init)
app.get('/api/user/init', authenticateTelegram, async (req, res) => {
  const tgUser = req.user;
  let userBalance = 0.00;

  // የ Dash Bingo ዋሌትን በ Bridge በኩል እንጠይቃለን
  try {
    const bridgeResp = await fetch(`${DASH_BINGO_URL}/api/internal/keno-balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: KENO_SHARED_SECRET, telegramId: tgUser.id })
    });
    const bData = await bridgeResp.json();
    if (bData.success) {
      userBalance = parseFloat(bData.balance || 0);
    }
  } catch (err) {
    console.warn('Dash Bingo bridge offline, checking local DB cache...');
    const local = await pool.query('SELECT local_balance FROM keno_users WHERE telegram_id = $1', [tgUser.id]);
    if (local.rows.length > 0) userBalance = parseFloat(local.rows[0].local_balance);
  }

  // የተጠቃሚውን መረጃ Cache እናደርጋለን
  await pool.query(
    `INSERT INTO keno_users (telegram_id, first_name, username, local_balance, last_active)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (telegram_id) DO UPDATE 
     SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, last_active = NOW()`,
    [tgUser.id, tgUser.first_name, tgUser.username, userBalance]
  );

  const round = getGlobalRound();

  res.json({
    success: true,
    balance: userBalance,
    roundId: round.roundId,
    cycleSec: round.cycleSec,
    isDrawing: round.isDrawing
  });
});

// 3. ውርርድ መመዝገብና ማስተናገድ (POST /api/bet/play)
app.post('/api/bet/play', authenticateTelegram, async (req, res) => {
  const { betAmount, clientData } = req.body;
  const picks = clientData?.picks;
  const amount = Number(betAmount);

  if (!amount || amount < MIN_BET || amount > MAX_BET) {
    return res.status(400).json({ success: false, message: `ውርርድ ከ ${MIN_BET} እስከ ${MAX_BET} ETB መሆን አለበት` });
  }

  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
    return res.status(400).json({ success: false, message: 'እባክዎ ከ 1 እስከ 10 ቁጥሮች ይምረጡ' });
  }

  const unique = new Set(picks);
  if (unique.size !== picks.length || picks.some(n => n < 1 || n > 80)) {
    return res.status(400).json({ success: false, message: 'የተሳሳቱ ቁጥሮች ተመርጠዋል' });
  }

  const { roundId, cycleSec } = getGlobalRound();

  if (cycleSec >= BET_WINDOW) {
    return res.status(400).json({ success: false, message: 'ይህ ዙር እጣ እያወጣ ነው፤ እባክዎ ቀጣዩን ዙር ይጠብቁ' });
  }

  // የወጡትን 20 ቁጥሮች ማዘጋጀት
  const drawnNumbers = generateDrawnNumbers(roundId);

  // Hits እና ክፍያ ማስላት
  const hits = picks.filter(p => drawnNumbers.includes(p)).length;
  const mult = (PAYTABLE[String(picks.length)] || {})[hits] || 0;
  const payout = Math.min(MAX_PAYOUT, Math.round(amount * mult * 100) / 100);

  let newBalance = 0;

  // ሂሳቡን በቀጥታ ከ Dash Bingo ዋሌት እንቆርጣለን / እንጨምራለን
  try {
    const settleResp = await fetch(`${DASH_BINGO_URL}/api/internal/keno-settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: KENO_SHARED_SECRET,
        telegramId: req.user.id,
        betAmount: amount,
        payout: payout,
        roundId: roundId,
        picks: picks,
        hits: hits
      })
    });

    const sData = await settleResp.json();
    if (!sData.success) {
      return res.status(400).json({ success: false, message: sData.message || 'በቂ ሒሳብ የለዎትም!' });
    }
    newBalance = sData.newBalance;
  } catch (err) {
    return res.status(500).json({ success: false, message: 'የዋሌት ማረጋገጫ ሲስተም ለጊዜው አልመለሰም' });
  }

  // ውርርዱን በ Keno Database ውስጥ መመዝገብ
  await pool.query(
    `INSERT INTO keno_bets (telegram_id, username, first_name, round_id, picks, bet_amount, hits, payout, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [req.user.id, req.user.username, req.user.first_name, roundId, picks, amount, hits, payout, payout > 0 ? 'WON' : 'LOST']
  );

  // የተጠቃሚውን ስታትስቲክስ ማደስ
  await pool.query(
    `UPDATE keno_users 
     SET total_bet_amount = total_bet_amount + $1,
         total_won_amount = total_won_amount + $2,
         tickets_played = tickets_played + 1,
         local_balance = $3,
         last_active = NOW()
     WHERE telegram_id = $4`,
    [amount, payout, newBalance, req.user.id]
  );

  // የዙሩን ጠቅላላ ገቢ ማደስ
  await pool.query(
    `INSERT INTO keno_rounds (round_id, drawn_numbers, total_bets, total_payout, house_profit, tickets_count)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (round_id) DO UPDATE 
     SET total_bets = keno_rounds.total_bets + $3,
         total_payout = keno_rounds.total_payout + $4,
         house_profit = keno_rounds.house_profit + ($3 - $4),
         tickets_count = keno_rounds.tickets_count + 1`,
    [roundId, drawnNumbers, amount, payout, (amount - payout)]
  );

  res.json({
    success: true,
    roundId: roundId,
    newBalance: newBalance,
    payout: payout,
    hits: hits,
    visualOutcome: {
      drawnNumbers: drawnNumbers
    }
  });
});

// 4. አሸናፊዎች ቦርድ (GET /api/public/feed)
app.get('/api/public/feed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         CASE WHEN username != '' THEN CONCAT(SUBSTRING(username, 1, 1), '***', SUBSTRING(username, LENGTH(username), 1))
              ELSE 'u***r' END as user,
         'Keno' as game,
         payout as win
       FROM keno_bets 
       WHERE payout >= 100 
       ORDER BY created_at DESC LIMIT 10`
    );
    res.json({ success: true, wins: rows });
  } catch (e) {
    res.json({ success: true, wins: [] });
  }
});

// ================= 📊 ADMIN CONTROLLER APIS ================= //

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/overview', checkAdminAuth, async (req, res) => {
  try {
    const round = getGlobalRound();
    const drawnNumbers = generateDrawnNumbers(round.roundId);

    const statsQ = await pool.query(`
      SELECT 
        COALESCE(SUM(bet_amount), 0) as total_bets,
        COALESCE(SUM(payout), 0) as total_payout,
        COUNT(*) as total_tickets
      FROM keno_bets
    `);

    const totalBets = parseFloat(statsQ.rows[0].total_bets);
    const totalPayout = parseFloat(statsQ.rows[0].total_payout);
    const ggr = totalBets - totalPayout;
    const rtp = totalBets > 0 ? ((totalPayout / totalBets) * 100).toFixed(1) : '0';

    const recentBetsQ = await pool.query(`
      SELECT id, telegram_id, username, first_name, round_id, picks, bet_amount, hits, payout, status, created_at 
      FROM keno_bets 
      ORDER BY id DESC LIMIT 25
    `);

    const min = Math.floor(round.remainingSec / 60);
    const sec = round.remainingSec % 60;
    const timeFormatted = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    res.json({
      success: true,
      currentRound: {
        roundId: round.roundId,
        cycleSec: round.cycleSec,
        isDrawing: round.isDrawing,
        remainingSec: round.remainingSec,
        timeFormatted,
        drawnNumbers
      },
      stats: {
        totalBets,
        totalPayout,
        ggr,
        rtp,
        totalTickets: parseInt(statsQ.rows[0].total_tickets)
      },
      recentBets: recentBetsQ.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================= START SERVER ================= //
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🎱 Fast Keno Master Server running 24/7 on port ${PORT}`);
  console.log(`🔗 Admin Controller at: http://localhost:${PORT}/admin`);
});
