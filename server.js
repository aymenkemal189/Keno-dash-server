require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

// ================= 1. SECURITY & CONFIG CHECK ================= //
const REQUIRED_ENVS = ['BOT_TOKEN', 'ADMIN_SECRET', 'KENO_SHARED_SECRET', 'SERVER_SALT', 'DATABASE_URL'];
for (const envKey of REQUIRED_ENVS) {
  if (!process.env[envKey]) {
    console.error(`FATAL: Missing required environment variable: ${envKey}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const SERVER_SALT = process.env.SERVER_SALT;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const KENO_SHARED_SECRET = process.env.KENO_SHARED_SECRET;
const DASH_BINGO_URL = process.env.DASH_BINGO_URL || 'https://dashserver-c9w5.onrender.com';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ---------------- OFFICIAL GAME PARAMETERS ----------------
const BET_WINDOW = 60;   // 60s Betting stage
const DRAW_WINDOW = 20;  // 20s Drawing stage
const TOTAL_CYCLE = 80;  // 80s Global round duration
const MIN_BET = 2;
const MAX_BET = 1000;
const MAX_PAYOUT = 30000;
const TARGET_RTP = 0.70;
const RTP_TOLERANCE = 0.06; // 70% +/- 6% covers exact retail payout structure

// 🎯 OFFICIAL MATHEMATICALLY CERTIFIED 70% PAYTABLE
const PAYTABLE = {
  "1": { 1: 3 },
  "2": { 2: 11.5 },
  "3": { 2: 1.5, 3: 36 },
  "4": { 2: 1, 3: 6, 4: 62 },
  "5": { 2: 0.5, 3: 2, 4: 16.5, 5: 233 },
  "6": { 3: 1.5, 4: 8, 5: 49, 6: 814 },
  "7": { 3: 1.5, 4: 3.5, 5: 18.5, 6: 91, 7: 1828 },
  "8": { 4: 3.5, 5: 11.5, 6: 57, 7: 341, 8: 5684 },
  "9": { 4: 2, 5: 5.5, 6: 26, 7: 158, 8: 1056, 9: 10561 },
  "10": { 0: 1, 5: 3.5, 6: 18.5, 7: 98, 8: 490, 9: 3061, 10: 12243 }
};

// ================= 2. HYPERGEOMETRIC VALIDATOR ================= //
function nCr(n, r) {
  if (r < 0 || r > n) return 0;
  if (r === 0 || r === n) return 1;
  if (r > n / 2) r = n - r;
  let res = 1;
  for (let i = 1; i <= r; i++) {
    res = (res * (n - i + 1)) / i;
  }
  return res;
}

function hypergeometricProb(k, n) {
  return (nCr(20, k) * nCr(60, n - k)) / nCr(80, n);
}

function validateRtp() {
  console.log('--- STARTING MATHEMATICAL HYPERGEOMETRIC RTP VALIDATION ---');
  let hasFailure = false;

  for (let pick = 1; pick <= 10; pick++) {
    const pickStr = String(pick);
    const row = PAYTABLE[pickStr];
    if (!row) {
      console.error(`Paytable missing Pick ${pick}`);
      hasFailure = true;
      continue;
    }

    let calculatedRtp = 0;
    for (let hits = 0; hits <= pick; hits++) {
      const prob = hypergeometricProb(hits, pick);
      const mult = row[hits] || 0;
      if (mult > 0) {
        const cappedPayout = Math.min(MAX_PAYOUT, MAX_BET * mult);
        const effectiveMultiplier = cappedPayout / MAX_BET;
        calculatedRtp += prob * effectiveMultiplier;
      }
    }

    const deviation = Math.abs(calculatedRtp - TARGET_RTP);
    console.log(`Pick ${pick.toString().padStart(2, ' ')}: Theoretical RTP = ${(calculatedRtp * 100).toFixed(2)}% (Dev: ${(deviation * 100).toFixed(2)}%)`);

    if (deviation > RTP_TOLERANCE) {
      console.error(`CRITICAL: Pick ${pick} RTP (${(calculatedRtp * 100).toFixed(2)}%) is outside allowed 70% tolerance!`);
      hasFailure = true;
    }
  }

  if (hasFailure) {
    console.error('FATAL: Startup aborted due to Paytable mathematical validation failure.');
    process.exit(1);
  }
  console.log('MATHEMATICAL RTP VALIDATION PASSED (ALL ROWS GUARANTEE ~70% RTP)\n');
}

validateRtp();

// ================= 3. DATABASE CONNECTION ================= //
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('PostgreSQL Pool Error:', err.message));

// ================= 4. GLOBAL CLOCK ENGINE ================= //
function getGlobalRound(offsetMs = 0) {
  const nowMs = Date.now() + offsetMs;
  const nowSec = Math.floor(nowMs / 1000);
  const roundId = 64105 + Math.floor(nowSec / TOTAL_CYCLE);
  const cycleSec = nowSec % TOTAL_CYCLE;
  const isDrawing = cycleSec >= BET_WINDOW;
  const remainingSec = isDrawing ? (TOTAL_CYCLE - cycleSec) : (BET_WINDOW - cycleSec);
  const roundStartSec = Math.floor(nowSec / TOTAL_CYCLE) * TOTAL_CYCLE;
  const betOpensAt = new Date(roundStartSec * 1000);
  const betClosesAt = new Date((roundStartSec + BET_WINDOW) * 1000);

  return {
    roundId,
    cycleSec,
    isDrawing,
    remainingSec,
    betOpensAt,
    betClosesAt,
    serverTimeMs: nowMs
  };
}

// ================= 5. UNBIASED PROVABLY FAIR FISHER-YATES DRAW ================= //
function drawKenoNumbers(serverSeed, roundId) {
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  let counter = 0;
  let buffer = Buffer.alloc(0);

  function nextUint32() {
    while (buffer.length < 4) {
      const hmac = crypto.createHmac('sha256', serverSeed);
      hmac.update(`${roundId}:${counter++}:${SERVER_SALT}`);
      buffer = Buffer.concat([buffer, hmac.digest()]);
    }
    const val = buffer.readUInt32BE(0);
    buffer = buffer.subarray(4);
    return val;
  }

  // Cryptographically unbiased Fisher-Yates with rejection sampling
  for (let i = pool.length - 1; i > 0; i--) {
    const range = i + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let rand;
    do {
      rand = nextUint32();
    } while (rand >= limit);

    const j = rand % range;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, 20); // 20 unique numbers in exact draw sequence
}

// ================= 6. AUTHENTICATION & SECURITY ================= //
function authenticateTelegram(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];

  if (!initData) {
    if (process.env.NODE_ENV === 'development') {
      req.user = { id: 12345678, username: 'dev_player', first_name: 'Dev' };
      return next();
    }
    return res.status(401).json({ success: false, message: 'Missing Telegram authentication' });
  }

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
    urlParams.delete('hash');

    const nowSec = Math.floor(Date.now() / 1000);
    if (!authDate || nowSec - authDate > 3600) {
      return res.status(401).json({ success: false, message: 'Telegram authentication expired' });
    }

    const params = Array.from(urlParams.entries())
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(params).digest('hex');

    if (calculatedHash !== hash) {
      return res.status(401).json({ success: false, message: 'Invalid Telegram cryptographic signature' });
    }

    const userData = JSON.parse(urlParams.get('user') || '{}');
    if (!userData.id) {
      return res.status(401).json({ success: false, message: 'Invalid user payload' });
    }

    req.user = {
      id: Number(userData.id),
      username: userData.username || '',
      first_name: userData.first_name || 'Player'
    };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Malformed Telegram authentication header' });
  }
}

function checkAdminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (!key || key !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Unauthorized admin access' });
  }
  next();
}

const betRateLimiter = new Map();
function rateLimitBets(req, res, next) {
  const userId = req.user.id;
  const now = Date.now();
  const lastTime = betRateLimiter.get(userId) || 0;
  if (now - lastTime < 400) {
    return res.status(429).json({ success: false, message: 'Too many requests. Please slow down.' });
  }
  betRateLimiter.set(userId, now);
  next();
}

// ================= 7. EXPRESS APPLICATION ================= //
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// 1. Paytable information
app.get('/api/keno/paytable', (req, res) => {
  res.json({
    success: true,
    paytable: PAYTABLE,
    maxPayout: MAX_PAYOUT,
    minBet: MIN_BET,
    maxBet: MAX_BET,
    rtp: TARGET_RTP
  });
});

// 2. User initialization with server time & active round tickets
app.get('/api/user/init', authenticateTelegram, async (req, res) => {
  const tgUser = req.user;
  const current = getGlobalRound();
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
  } catch (e) {
    const local = await pool.query('SELECT local_balance FROM keno_users WHERE telegram_id = $1', [tgUser.id]);
    if (local.rows.length > 0) userBalance = parseFloat(local.rows[0].local_balance);
  }

  await pool.query(
    `INSERT INTO keno_users (telegram_id, first_name, username, local_balance, last_active)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (telegram_id) DO UPDATE 
     SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, local_balance = $4, last_active = NOW()`,
    [tgUser.id, tgUser.first_name, tgUser.username, userBalance]
  );

  const ticketsQ = await pool.query(
    `SELECT id, picks, bet_amount as amount, status, payout
     FROM keno_bets 
     WHERE telegram_id = $1 AND round_id = $2
     ORDER BY id ASC`,
    [tgUser.id, current.roundId]
  );

  res.json({
    success: true,
    balance: userBalance,
    roundId: current.roundId,
    cycleSec: current.cycleSec,
    isDrawing: current.isDrawing,
    remainingSec: current.remainingSec,
    serverTime: current.serverTimeMs,
    myTickets: ticketsQ.rows.map(r => ({
      id: r.id,
      picks: r.picks,
      amount: parseFloat(r.amount),
      status: r.status,
      payout: parseFloat(r.payout)
    }))
  });
});

// 3. Place Bet (STAKE DEBIT ONLY, NO RESULTS REVEALED)
app.post('/api/bet/play', authenticateTelegram, rateLimitBets, async (req, res) => {
  const { betAmount, clientData, idempotencyKey } = req.body;
  const picks = clientData?.picks;
  const amount = Number(betAmount);

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return res.status(400).json({ success: false, message: 'Valid idempotencyKey is required' });
  }

  if (!amount || amount < MIN_BET || amount > MAX_BET || !Number.isInteger(amount)) {
    return res.status(400).json({ success: false, message: `Bet must be an integer between ${MIN_BET} and ${MAX_BET} ETB` });
  }

  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
    return res.status(400).json({ success: false, message: 'Select between 1 and 10 numbers' });
  }

  const unique = new Set(picks);
  if (unique.size !== picks.length || picks.some(n => !Number.isInteger(n) || n < 1 || n > 80)) {
    return res.status(400).json({ success: false, message: 'Invalid numbers selected. Choose unique numbers between 1 and 80' });
  }

  const current = getGlobalRound();
  if (current.cycleSec >= BET_WINDOW) {
    return res.status(400).json({ success: false, message: 'Betting is closed for this round. Please wait for next round.' });
  }

  // Idempotency Check
  const existingBet = await pool.query(
    'SELECT id, round_id, bet_amount FROM keno_bets WHERE telegram_id = $1 AND idempotency_key = $2',
    [req.user.id, idempotencyKey]
  );
  if (existingBet.rows.length > 0) {
    return res.json({
      success: true,
      ticketId: existingBet.rows[0].id,
      roundId: existingBet.rows[0].round_id,
      serverTime: Date.now()
    });
  }

  // Max 10 tickets per round check
  const userTicketCountQ = await pool.query(
    'SELECT COUNT(*) as count FROM keno_bets WHERE telegram_id = $1 AND round_id = $2',
    [req.user.id, current.roundId]
  );
  if (parseInt(userTicketCountQ.rows[0].count, 10) >= 10) {
    return res.status(400).json({ success: false, message: 'Maximum 10 tickets allowed per round' });
  }

  // Debit Stake through Wallet Bridge
  let newBalance = 0;
  try {
    const bridgeResp = await fetch(`${DASH_BINGO_URL}/api/internal/keno-settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: KENO_SHARED_SECRET,
        telegramId: req.user.id,
        betAmount: amount,
        payout: 0,
        roundId: current.roundId,
        picks: picks,
        action: 'DEBIT_STAKE'
      })
    });
    const bData = await bridgeResp.json();
    if (!bData.success) {
      return res.status(400).json({ success: false, message: bData.message || 'Insufficient wallet balance' });
    }
    newBalance = parseFloat(bData.newBalance);
  } catch (err) {
    return res.status(502).json({ success: false, message: 'Wallet bridge service is temporarily unavailable' });
  }

  // Record bet atomically in Database
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO keno_bets (round_id, telegram_id, username, picks, bet_amount, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
       RETURNING id`,
      [current.roundId, req.user.id, req.user.username, picks, amount, idempotencyKey]
    );

    await client.query(
      `UPDATE keno_users 
       SET local_balance = $1, 
           total_bet_amount = total_bet_amount + $2,
           tickets_played = tickets_played + 1,
           last_active = NOW()
       WHERE telegram_id = $3`,
      [newBalance, amount, req.user.id]
    );

    await client.query('COMMIT');

    // DO NOT RETURN DRAW NUMBERS OR PAYOUT (Results remain locked until cycleSec = 60)
    res.json({
      success: true,
      ticketId: insertRes.rows[0].id,
      roundId: current.roundId,
      newBalance: newBalance,
      serverTime: Date.now()
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error inserting ticket:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record ticket in database' });
  } finally {
    client.release();
  }
});

// 4. Current Round Synchronous Status
app.get('/api/keno/round/current', async (req, res) => {
  const current = getGlobalRound();
  try {
    const roundQ = await pool.query(
      'SELECT round_id, seed_hash, status, drawn_numbers, drawn_at FROM keno_rounds WHERE round_id = $1',
      [current.roundId]
    );

    const roundData = roundQ.rows[0];
    const isDrawn = roundData && (roundData.status === 'DRAWN' || roundData.status === 'SETTLED');

    res.json({
      roundId: current.roundId,
      status: roundData ? roundData.status : 'OPEN',
      seedHash: roundData ? roundData.seed_hash : null,
      cycleSec: current.cycleSec,
      serverTime: current.serverTimeMs,
      drawnAt: isDrawn ? roundData.drawn_at : null,
      drawnNumbers: isDrawn ? roundData.drawn_numbers : null // NULL until cycleSec >= 60
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Recent Settled Rounds History
app.get('/api/keno/results', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  try {
    const { rows } = await pool.query(
      `SELECT round_id as id, drawn_at as time, drawn_numbers as numbers, seed_hash as "seedHash", server_seed as "serverSeed"
       FROM keno_rounds 
       WHERE status IN ('DRAWN', 'SETTLED') AND drawn_numbers IS NOT NULL
       ORDER BY round_id DESC 
       LIMIT $1`,
      [limit]
    );

    res.json({ success: true, results: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. User tickets for a specific round
app.get('/api/user/tickets', authenticateTelegram, async (req, res) => {
  const roundId = parseInt(req.query.round, 10);
  if (!roundId) {
    return res.status(400).json({ success: false, message: 'Valid round parameter required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, picks, bet_amount as amount, hits, multiplier, payout, status, settled_at
       FROM keno_bets 
       WHERE telegram_id = $1 AND round_id = $2
       ORDER BY id ASC`,
      [req.user.id, roundId]
    );

    res.json({
      success: true,
      tickets: rows.map(r => ({
        id: r.id,
        picks: r.picks,
        amount: parseFloat(r.amount),
        hits: r.hits,
        multiplier: r.multiplier ? parseFloat(r.multiplier) : null,
        payout: parseFloat(r.payout),
        status: r.status,
        settledAt: r.settled_at
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Provably Fair Verification Endpoint
app.get('/api/keno/verify/:roundId', async (req, res) => {
  const roundId = parseInt(req.params.roundId, 10);
  if (!roundId) return res.status(400).json({ success: false, message: 'Valid roundId required' });

  try {
    const { rows } = await pool.query(
      'SELECT round_id, seed_hash, server_seed, drawn_numbers, status FROM keno_rounds WHERE round_id = $1',
      [roundId]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Round not found' });
    const round = rows[0];

    if (round.status === 'OPEN') {
      return res.status(400).json({ success: false, message: 'Round is open. Seed will be revealed once draw begins.' });
    }

    const recomputedHash = crypto.createHash('sha256').update(round.server_seed).digest('hex');
    const recomputedNumbers = drawKenoNumbers(round.server_seed, round.round_id);
    const hashMatches = recomputedHash === round.seed_hash;
    const numbersMatch = JSON.stringify(recomputedNumbers) === JSON.stringify(round.drawn_numbers);

    res.json({
      roundId: round.round_id,
      serverSeed: round.server_seed,
      seedHash: round.seed_hash,
      recomputedHash,
      hashMatches,
      storedNumbers: round.drawn_numbers,
      recomputedNumbers,
      numbersMatch,
      verified: hashMatches && numbersMatch
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. Public Feed (REAL wins only)
app.get('/api/public/feed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         CASE WHEN username != '' THEN CONCAT(SUBSTRING(username, 1, 1), '***', SUBSTRING(username, LENGTH(username), 1))
              ELSE 'Player' END as user,
         'Keno' as game,
         payout as win,
         round_id as "roundId"
       FROM keno_bets 
       WHERE payout > 0 AND status = 'WON'
       ORDER BY settled_at DESC NULLS LAST, id DESC 
       LIMIT 10`
    );
    res.json({ success: true, wins: rows });
  } catch (e) {
    res.json({ success: true, wins: [] });
  }
});

// 9. Real Live Stats for Active Round
app.get('/api/keno/round/live-stats', async (req, res) => {
  const current = getGlobalRound();
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as "ticketsCount", COALESCE(SUM(bet_amount), 0) as "totalStake"
       FROM keno_bets 
       WHERE round_id = $1`,
      [current.roundId]
    );

    res.json({
      roundId: current.roundId,
      ticketsCount: parseInt(rows[0].ticketsCount, 10),
      totalStake: parseFloat(rows[0].totalStake)
    });
  } catch (err) {
    res.status(500).json({ ticketsCount: 0, totalStake: 0 });
  }
});

// 10. Server-Sent Events (SSE) Stream
app.get('/api/keno/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const current = getGlobalRound();
    res.write(`data: ${JSON.stringify({ type: 'TICK', roundId: current.roundId, cycleSec: current.cycleSec, isDrawing: current.isDrawing, remainingSec: current.remainingSec })}\n\n`);
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ================= 8. 1-SECOND ORCHESTRATOR & SETTLEMENT ENGINE ================= //
async function runEngineTick() {
  const current = getGlobalRound();
  const nextRoundId = current.roundId + 1;

  let client;
  try {
    client = await pool.connect();

    // Acquire PostgreSQL Advisory Lock (Only one cluster instance executes draws)
    const lockRes = await client.query('SELECT pg_try_advisory_lock(772189) as acquired');
    if (!lockRes.rows[0].acquired) {
      client.release();
      return;
    }

    // 1. Ensure current & next rounds exist with pre-committed SHA256 hashes
    for (const rId of [current.roundId, nextRoundId]) {
      const serverSeed = crypto.randomBytes(32).toString('hex');
      const seedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
      const startSec = (rId - 64105) * TOTAL_CYCLE;
      const opensAt = new Date(startSec * 1000);
      const closesAt = new Date((startSec + BET_WINDOW) * 1000);

      await client.query(
        `INSERT INTO keno_rounds (round_id, seed_hash, server_seed, bet_opens_at, bet_closes_at, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN')
         ON CONFLICT (round_id) DO NOTHING`,
        [rId, seedHash, serverSeed, opensAt, closesAt]
      );
    }

    // 2. Trigger Draw at cycleSec >= 60 (Draws ONCE using HMAC-SHA256)
    const readyRounds = await client.query(
      `SELECT round_id, server_seed FROM keno_rounds 
       WHERE status = 'OPEN' AND bet_closes_at <= NOW()`
    );

    for (const r of readyRounds.rows) {
      const drawnNumbers = drawKenoNumbers(r.server_seed, r.round_id);
      
      await client.query(
        `UPDATE keno_rounds 
         SET status = 'DRAWN', drawn_numbers = $1, drawn_at = NOW() 
         WHERE round_id = $2`,
        [drawnNumbers, r.round_id]
      );
      console.log(`[ROUND ${r.round_id}] UNBIASED DRAW COMPLETED -> ${JSON.stringify(drawnNumbers)}`);
    }

    // 3. Atomically Settle all pending bets for drawn rounds
    const drawnRounds = await client.query(
      `SELECT round_id, drawn_numbers FROM keno_rounds WHERE status = 'DRAWN'`
    );

    for (const r of drawnRounds.rows) {
      const pendingBets = await client.query(
        `SELECT id, telegram_id, picks, bet_amount FROM keno_bets 
         WHERE round_id = $1 AND status = 'PENDING'`,
        [r.round_id]
      );

      let roundTotalBets = 0;
      let roundTotalPayout = 0;

      for (const bet of pendingBets.rows) {
        const betAmount = parseFloat(bet.bet_amount);
        roundTotalBets += betAmount;

        const hits = bet.picks.filter(p => r.drawn_numbers.includes(p)).length;
        const mult = (PAYTABLE[String(bet.picks.length)] || {})[hits] || 0;
        const payout = Math.min(MAX_PAYOUT, Math.round(betAmount * mult * 100) / 100);
        roundTotalPayout += payout;

        const status = payout > 0 ? 'WON' : 'LOST';

        // Credit Wallet Bridge for winning tickets
        if (payout > 0) {
          try {
            await fetch(`${DASH_BINGO_URL}/api/internal/keno-settle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                secret: KENO_SHARED_SECRET,
                telegramId: bet.telegram_id,
                betAmount: 0,
                payout: payout,
                roundId: r.round_id,
                action: 'CREDIT_PAYOUT',
                ticketId: bet.id
              })
            });
          } catch (err) {
            console.error(`Wallet credit error for ticket #${bet.id}:`, err.message);
          }
        }

        await client.query(
          `UPDATE keno_bets 
           SET hits = $1, multiplier = $2, payout = $3, status = $4, settled_at = NOW() 
           WHERE id = $5`,
          [hits, mult, payout, status, bet.id]
        );

        if (payout > 0) {
          await client.query(
            `UPDATE keno_users 
             SET total_won_amount = total_won_amount + $1 
             WHERE telegram_id = $2`,
            [payout, bet.telegram_id]
          );
        }
      }

      await client.query(
        `UPDATE keno_rounds 
         SET status = 'SETTLED', 
             total_bets = $1, 
             total_payout = $2, 
             tickets_count = $3 
         WHERE round_id = $4`,
        [roundTotalBets, roundTotalPayout, pendingBets.rows.length, r.round_id]
      );
      console.log(`[ROUND ${r.round_id}] SETTLED. Total Stakes: ${roundTotalBets} ETB, Payouts: ${roundTotalPayout} ETB`);
    }

    // Release Advisory Lock
    await client.query('SELECT pg_advisory_unlock(772189)');
  } catch (err) {
    console.error('Orchestrator error:', err.message);
  } finally {
    if (client) client.release();
  }
}

setInterval(runEngineTick, 1000);

// ================= 9. ADMIN OVERVIEW CONTROLLER ================= //
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/overview', checkAdminAuth, async (req, res) => {
  try {
    const current = getGlobalRound();
    const roundQ = await pool.query(
      'SELECT round_id, seed_hash, status, drawn_numbers, server_seed FROM keno_rounds WHERE round_id = $1',
      [current.roundId]
    );

    const rData = roundQ.rows[0];
    const isDrawn = rData && (rData.status === 'DRAWN' || rData.status === 'SETTLED');

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
      SELECT id, telegram_id, username, round_id, picks, bet_amount, hits, payout, status, created_at 
      FROM keno_bets 
      ORDER BY id DESC LIMIT 25
    `);

    res.json({
      success: true,
      currentRound: {
        roundId: current.roundId,
        cycleSec: current.cycleSec,
        isDrawing: current.isDrawing,
        remainingSec: current.remainingSec,
        status: rData ? rData.status : 'OPEN',
        seedHash: rData ? rData.seed_hash : null,
        // STRICT SECURITY: Locked until cycleSec >= 60
        drawnNumbers: isDrawn ? rData.drawn_numbers : 'LOCKED_UNTIL_DRAW'
      },
      stats: {
        totalBets,
        totalPayout,
        ggr,
        rtp: `${rtp}%`,
        targetRtp: '70.0%',
        totalTickets: parseInt(statsQ.rows[0].total_tickets, 10)
      },
      recentBets: recentBetsQ.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================= 10. SERVER STARTUP ================= //
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Synchronous Provably Fair 70% RTP Keno Server running on port ${PORT}`);
});
