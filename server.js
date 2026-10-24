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
const SERVER_SALT = process.env.SERVER_SALT || 'KENO_SMART_RTP_SALT_2026';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dash_keno_admin_master_2026';
const DASH_BINGO_URL = process.env.DASH_BINGO_URL || 'https://dashserver-c9w5.onrender.com';
const KENO_SHARED_SECRET = process.env.KENO_SHARED_SECRET || 'FAST_KENO_DASH_SECRET_KEY_2026';

// ---------------- GAME TIMING CONFIG ----------------
const BET_WINDOW = 60;   // 60s ውርርድ
const DRAW_WINDOW = 20;  // 20s እጣ
const TOTAL_CYCLE = 80;  // 80s ዑደት
const MIN_BET = 2;
const MAX_BET = 1000;
const MAX_PAYOUT = 30000;
const TARGET_RTP = 0.70; // 🎯 ቋሚ የ 70% RTP ኢላማ (30% House Edge)

// 🔥 የመጀመሪያው ማራኪ እና ትልቅ Paytable (ተጫዋቾች እንዲጓጉ ሳይቀነስ የተቀመጠ)
const ORIGINAL_ATTRACTIVE_PAYTABLE = {
  "1": { 1: 3.0 },
  "2": { 2: 10.0 },
  "3": { 2: 2.0, 3: 50.0 }, // 1/3 ለስነ-ልቦና ቅርበት ክፍያ የለውም፤ 3/3 ግን 50x ይከፍላል!
  "4": { 2: 1.5, 3: 8.0, 4: 80.0 },
  "5": { 2: 1.0, 3: 3.0, 4: 25.0, 5: 350.0 },
  "6": { 3: 2.0, 4: 10.0, 5: 60.0, 6: 1000.0 },
  "7": { 3: 1.5, 4: 4.0, 5: 20.0, 6: 100.0, 7: 2000.0 },
  "8": { 4: 3.0, 5: 10.0, 6: 50.0, 7: 300.0, 8: 5000.0 },
  "9": { 4: 2.0, 5: 5.0, 6: 25.0, 7: 150.0, 8: 1000.0, 9: 10000.0 },
  "10": { 0: 1.0, 5: 3.0, 6: 15.0, 7: 80.0, 8: 400.0, 9: 2500.0, 10: 10000.0 }
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

// ---------------- BASE 20-BALL GENERATOR ----------------
function generateCandidateBalls(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);

  for (let i = pool.length - 1; i > 0; i--) {
    const subHash = crypto.createHmac('sha256', SERVER_SALT).update(`${hash}_${i}`).digest('hex');
    const j = parseInt(subHash.substring(0, 8), 16) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 20);
}

// ---------------- 🧠 SMART RTP & NEAR-MISS ALGORITHM ----------------
// ይህ ፋንክሽን ትልቁን Multiplier ሳያሳንስ፣ ተጫዋቹ 1/3 ወይም 1/4 አግኝቶ እንዲጓጓ እያደረገ
// ጠቅላላ የቤቱን ክፍያ በትክክል በ 70% RTP ላይ ያቆማል
function calculateOptimizedDraw(roundId, activeBets) {
  // ውርርድ ከሌለ ሙሉ ራንደም ያወጣል
  if (!activeBets || activeBets.length === 0) {
    return generateCandidateBalls(`${roundId}_${SERVER_SALT}_NATURAL`);
  }

  let totalWagered = 0;
  for (const b of activeBets) totalWagered += Number(b.bet_amount || 0);

  let bestDraw = null;
  let bestScore = Infinity;

  // 100 የተለያዩ የቁጥር አማራጮችን (Candidate Draws) በሰከንድ ውስጥ ያወዳድራል
  for (let c = 0; c < 100; c++) {
    const candidateDraw = generateCandidateBalls(`${roundId}_${SERVER_SALT}_CAND_${c}`);
    let candidatePayout = 0;
    let nearMissCount = 0; // 1/3 ወይም 1/4 የማግኘት ብዛት

    for (const b of activeBets) {
      const picks = Array.isArray(b.picks) ? b.picks : JSON.parse(b.picks || '[]');
      const amount = Number(b.bet_amount);
      const hits = picks.filter(p => candidateDraw.includes(p)).length;
      const mult = (ORIGINAL_ATTRACTIVE_PAYTABLE[String(picks.length)] || {})[hits] || 0;
      
      candidatePayout += Math.min(MAX_PAYOUT, amount * mult);

      // የስነ-ልቦና ማነቃቂያ (ተጫዋቹ ቢያንስ 1 ቁጥር ሲያገኝ)
      if (hits === 1 && picks.length >= 3) {
        nearMissCount++;
      }
    }

    const currentRtp = totalWagered > 0 ? (candidatePayout / totalWagered) : 0;

    // 🎯 የሒሳብ ሚዛን (Loss Function)፦
    // 1. RTP ወደ 70% (0.70) በጣም የቀረበ እንዲሆን ያደርጋል
    // 2. ተጫዋቹ 1/3 ወይም 1/4 እንዲያገኝ (Near Miss) ቅድሚያ ይሰጣል
    const rtpError = Math.abs(currentRtp - TARGET_RTP);
    const score = rtpError - (nearMissCount * 0.02);

    if (score < bestScore) {
      bestScore = score;
      bestDraw = candidateDraw;
      // ፍፁም 70% ከተገኘ ወዲያውኑ ይወስደዋል
      if (rtpError < 0.05 && nearMissCount > 0) break;
    }
  }

  return bestDraw || generateCandidateBalls(`${roundId}_${SERVER_SALT}_FALLBACK`);
}

// ---------------- TELEGRAM AUTHENTICATION MIDDLEWARE ----------------
function authenticateTelegram(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

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

// 1. Paytable መረጃ (ማራኪ ማባዣዎች እንዳሉ ይመለሳሉ)
app.get('/api/keno/paytable', (req, res) => {
  res.json({ 
    success: true, 
    paytable: ORIGINAL_ATTRACTIVE_PAYTABLE, 
    maxPayout: MAX_PAYOUT,
    targetRTP: "70% Dynamic Guaranteed"
  });
});

// 2. የተጠቃሚ ባላንስና ዙር መረጃ
app.get('/api/user/init', authenticateTelegram, async (req, res) => {
  const tgUser = req.user;
  let userBalance = 0.00;

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
    const local = await pool.query('SELECT local_balance FROM keno_users WHERE telegram_id = $1', [tgUser.id]);
    if (local.rows.length > 0) userBalance = parseFloat(local.rows[0].local_balance);
  }

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
    isDrawing: round.isDrawing,
    remainingSec: round.remainingSec
  });
});

// 3. ውርርድ መመዝገብ (POST /api/bet/play)
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

  // የዚህን ዙር ነባር ውርርዶች አምጥቶ ስሌቱን ሚዛናዊ ያደርጋል
  const currentBetsQ = await pool.query('SELECT picks, bet_amount FROM keno_bets WHERE round_id = $1', [roundId]);
  const activeBets = [...currentBetsQ.rows, { picks, bet_amount: amount }];

  // 🎯 በ 70% RTP እና በ Near-Miss ስሌት 20 ቁጥሮችን ማመንጨት
  const drawnNumbers = calculateOptimizedDraw(roundId, activeBets);

  // የተገኘ ውጤት ማስላት
  const hits = picks.filter(p => drawnNumbers.includes(p)).length;
  const mult = (ORIGINAL_ATTRACTIVE_PAYTABLE[String(picks.length)] || {})[hits] || 0;
  const payout = Math.min(MAX_PAYOUT, Math.round(amount * mult * 100) / 100);

  let newBalance = 0;

  // ሂሳቡን ማስተናገድ
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

  // ውርርዱን በ Database ማስቀመጥ
  await pool.query(
    `INSERT INTO keno_bets (telegram_id, username, first_name, round_id, picks, bet_amount, hits, payout, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [req.user.id, req.user.username, req.user.first_name, roundId, picks, amount, hits, payout, payout > 0 ? 'WON' : 'LOST']
  );

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

// 4. አሸናፊዎች ቦርድ
app.get('/api/public/feed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         CASE WHEN username != '' THEN CONCAT(SUBSTRING(username, 1, 1), '***', SUBSTRING(username, LENGTH(username), 1))
              ELSE 'u***r' END as user,
         'Keno' as game,
         payout as win
       FROM keno_bets 
       WHERE payout >= 50 
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
    
    // የዚህን ዙር ውርርዶች አምጥቶ ትክክለኛውን እጣ ያሳያል
    const betsQ = await pool.query('SELECT picks, bet_amount FROM keno_bets WHERE round_id = $1', [round.roundId]);
    const realDrawn = calculateOptimizedDraw(round.roundId, betsQ.rows);
    
    // የደህንነት ጥበቃ፦ ውርርድ ገና ክፍት እያለ ቁጥሮቹን አድሚን ላይ ቆልፎ ያቆያል
    const maskedDrawn = round.isDrawing ? realDrawn : realDrawn.map(() => '🔒');

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
    const rtp = totalBets > 0 ? ((totalPayout / totalBets) * 100).toFixed(1) : '0.0';

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
        drawnNumbers: maskedDrawn
      },
      stats: {
        totalBets,
        totalPayout,
        ggr,
        rtp,
        targetRtp: "70.0%",
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
  console.log(`🎱 Fast Keno Master Server running with Smart 70% RTP Engine on port ${PORT}`);
  console.log(`🔗 Admin Controller at: http://localhost:${PORT}/admin`);
});
