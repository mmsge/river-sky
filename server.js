'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ── Database ──────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'db', 'daggerheart.sqlite');

let db;

function openDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
}

function initDb() {
  openDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      parent_snapshot_id INTEGER REFERENCES snapshots(id),
      created_at         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      is_active          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id      INTEGER NOT NULL REFERENCES branches(id),
      parent_id      INTEGER REFERENCES snapshots(id),
      description    TEXT    NOT NULL,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      character_data TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_branch ON snapshots(branch_id);
    CREATE INDEX IF NOT EXISTS idx_branches_active  ON branches(is_active);

    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      started_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      ended_at   TEXT,
      branch_id  INTEGER NOT NULL REFERENCES branches(id)
    );

    CREATE TABLE IF NOT EXISTS session_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id),
      kind        TEXT    NOT NULL CHECK(kind IN ('note','stat')),
      content     TEXT    NOT NULL,
      snapshot_id INTEGER REFERENCES snapshots(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_session ON session_entries(session_id);
  `);

  createNewTables();
  migrateSchema();

  const count = db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
  if (count === 0) {
    seed();
  } else {
    backfill();
  }
}

// ── Multi-character / multi-campaign schema ─────────────────────────────────────

function createNewTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS campaign_characters (
      campaign_id  INTEGER NOT NULL REFERENCES campaigns(id),
      character_id INTEGER NOT NULL REFERENCES characters(id),
      PRIMARY KEY (campaign_id, character_id)
    );
  `);
}

function hasColumn(table, col) {
  // `table` is always an internal literal — PRAGMA cannot be parameterized.
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

function migrateSchema() {
  // Additive, nullable columns (the safe ALTER form — no default needed).
  if (!hasColumn('branches', 'character_id')) {
    db.exec('ALTER TABLE branches ADD COLUMN character_id INTEGER REFERENCES characters(id)');
  }
  if (!hasColumn('sessions', 'campaign_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)');
  }
  // Indexes go after the ALTERs so the columns exist.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_branches_character ON branches(character_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_campaign  ON sessions(campaign_id);
  `);
}

// Idempotent backfill for installs that predate the multi-character model.
function backfill() {
  const charCount = db.prepare('SELECT COUNT(*) AS n FROM characters').get().n;

  if (charCount === 0) {
    // Derive a name from the existing character data.
    const active = db.prepare('SELECT * FROM branches WHERE is_active = 1 LIMIT 1').get()
                || db.prepare('SELECT * FROM branches ORDER BY id ASC LIMIT 1').get();
    let charName = 'River Sky';
    if (active) {
      const snap = getLatestSnapshot(active.id);
      if (snap) {
        try {
          const c = JSON.parse(snap.character_data);
          if (c?.basicInfo?.name) charName = c.basicInfo.name;
        } catch { /* keep default */ }
      }
    }

    const characterId = db.prepare('INSERT INTO characters (name) VALUES (?)').run(charName).lastInsertRowid;
    db.prepare('UPDATE branches SET character_id = ? WHERE character_id IS NULL').run(characterId);

    const campaignId = db.prepare(
      "INSERT INTO campaigns (name, description) VALUES ('Main Campaign', '')"
    ).run().lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO campaign_characters (campaign_id, character_id) VALUES (?, ?)')
      .run(campaignId, characterId);
    db.prepare('UPDATE sessions SET campaign_id = ? WHERE campaign_id IS NULL').run(campaignId);

    setActiveCharacterId(characterId);
    return;
  }

  // Safety net: re-link anything left orphaned by a partial migration.
  const orphanBranches = db.prepare('SELECT COUNT(*) AS n FROM branches WHERE character_id IS NULL').get().n;
  if (orphanBranches > 0) {
    const firstChar = db.prepare('SELECT id FROM characters ORDER BY id ASC LIMIT 1').get();
    if (firstChar) db.prepare('UPDATE branches SET character_id = ? WHERE character_id IS NULL').run(firstChar.id);
  }
  const orphanSessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE campaign_id IS NULL').get().n;
  if (orphanSessions > 0) {
    const firstCamp = db.prepare('SELECT id FROM campaigns ORDER BY id ASC LIMIT 1').get();
    if (firstCamp) db.prepare('UPDATE sessions SET campaign_id = ? WHERE campaign_id IS NULL').run(firstCamp.id);
  }
  if (!db.prepare("SELECT value FROM app_state WHERE key='active_character_id'").get()) {
    const firstChar = db.prepare('SELECT id FROM characters ORDER BY id ASC LIMIT 1').get();
    if (firstChar) setActiveCharacterId(firstChar.id);
  }
}

function seed() {
  const character = {
    basicInfo: {
      name: 'River Sky',
      pronouns: 'they/them',
      ancestry: 'Ribbet',
      community: '',
      class: 'Sorcerer',
      subclass: 'Wordsmith',
      level: 5,
      proficiency: 4
    },
    traits: {
      agility: 1,
      strength: 0,
      finesse: 2,
      instinct: 0,
      presence: 4,
      knowledge: 0
    },
    resources: {
      hp:     { current: 0, max: 12 },
      stress: { current: 0, max: 12 },
      hope:   3,
      gold:   { handfuls: 0, bags: 0, chests: 0 }
    },
    thresholds: { major: 17, severe: 38 },
    defenses: { evasion: 12 },
    armor: {
      equippedId: null,
      slotsMax:   4,   // River has 4 armor slots
      slotsUsed:  0,
      items: []
    },
    conditions: {
      vulnerable:  false,
      restrained:  false,
      hidden:      false,
      unconscious: false
    },
    attacks: [
      { name: 'Fireball',       type: 'spell',  mod: 4, modUseProf: true,
        diceCount: 4, diceSides: 20, diceCountUseProf: true, dmod: 5,  damageType: 'magical',  trait: 'presence',
        range: ['Far'],  aoe: true,  friendlyFire: true,
        note: 'AoE Very Close around target. Reaction Roll DC13: fail=full damage, success=half.' },
      { name: 'Wild Flame',     type: 'spell',  mod: 4, modUseProf: true,
        diceCount: 2, diceSides: 6,  dmod: 0,  damageType: 'magical',  trait: 'presence',
        range: ['Melee'], aoe: true,
        note: 'Up to 3 targets in Melee range of River.' },
      { name: 'Wall of Flame',  type: 'spell',  mod: 4, modUseProf: true,
        diceCount: 4, diceSides: 10, diceCountUseProf: true, dmod: 3,  damageType: 'magical',  trait: 'presence',
        range: ['Melee', 'Close', 'Far'], noRoll: true,
        note: 'Flat damage to anything crossing. No attack roll needed against crossing creatures.' },
      { name: 'Mystic Tether',  type: 'spell',  mod: 4, modUseProf: true,
        diceCount: 0, diceSides: 6,  dmod: 0,  damageType: null,       trait: 'presence',
        range: ['Far'], utility: true, groundsFliers: true,
        note: 'No damage. Restrains target at Far range. Also grounds flying enemies.' },
      { name: 'Blunderburst',   type: 'weapon', mod: 2,
        diceCount: 2, diceSides: 8,  dmod: 6,  damageType: 'physical', trait: 'agility',
        range: ['Close'],
        note: 'Reliable single-target Close attack. Highest flat modifier of any weapon.' },
      { name: 'Bladed Whip',    type: 'weapon', mod: 1,
        diceCount: 4, diceSides: 8,  diceCountUseProf: true, dmod: 3,  damageType: 'physical', trait: 'finesse',
        range: ['Melee'],
        note: 'High die-count Melee strike. Lower hit modifier but strong damage ceiling.' },
      { name: 'Whip',           type: 'weapon', mod: 4,
        diceCount: 2, diceSides: 6,  dmod: 0,  damageType: 'physical', trait: 'finesse',
        range: ['Melee', 'Very Short'],
        note: 'Highest hit modifier of any weapon. Light damage but nearly guaranteed to land.' },
      { name: 'Long Tongue',    type: 'weapon', mod: 2,
        diceCount: 4, diceSides: 12, diceCountUseProf: true, dmod: 0,  damageType: 'physical', trait: 'agility',
        range: ['Close'], costStress: true,
        note: 'Exceptional damage ceiling. Costs 1 Stress — a strong trade when Stress is available.' },
      { name: 'Construct Attack', type: 'ability', mod: 4, modUseProf: true,
        diceCount: 2, diceSides: 10, dmod: 3, damageType: 'physical', trait: 'agility',
        range: ['Melee', 'Close', 'Far'], needConstruct: true,
        note: 'Flexible range and high hit modifier. Maximises value while the construct is active.' }
    ],
    weapons: [
      { id: 'w1', name: 'Blunderburst', wield: 'main', trait: 'agility', range: 'Close',
        diceCount: 2, diceSides: 8,  dmod: 6, damageType: 'physical', note: '' },
      { id: 'w2', name: 'Bladed Whip',  wield: 'main', trait: 'finesse', range: 'Melee',
        diceCount: 4, diceSides: 8,  diceCountUseProf: true, dmod: 3, damageType: 'physical', note: '' },
      { id: 'w3', name: 'Whip',         wield: 'off',  trait: 'finesse', range: 'Melee',
        diceCount: 2, diceSides: 6,  dmod: 0, damageType: 'physical', note: '' },
      { id: 'w4', name: 'Long Tongue',  wield: 'main', trait: 'agility', range: 'Close',
        diceCount: 4, diceSides: 12, diceCountUseProf: true, dmod: 0, damageType: 'physical', note: 'Costs 1 Stress.' }
    ],
    inventory:   [],
    domainCards: [],
    experiences: [
      { id: 'exp1', name: 'Experience 1', description: '', modifier: 2 },
      { id: 'exp2', name: 'Experience 2', description: '', modifier: 2 }
    ],
    features: [],
    downtimeProjects: [],
    notes: '',
    dead: false
  };

  const characterId = db.prepare("INSERT INTO characters (name) VALUES ('River Sky')").run().lastInsertRowid;

  const branchId = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active, character_id) VALUES ('main', NULL, 1, ?)`
  ).run(characterId).lastInsertRowid;

  db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, NULL, 'Initial character — River Sky, Ribbet Wordsmith Lv.5', ?)`
  ).run(branchId, JSON.stringify(character));

  const campaignId = db.prepare(
    "INSERT INTO campaigns (name, description) VALUES ('Main Campaign', '')"
  ).run().lastInsertRowid;
  db.prepare('INSERT INTO campaign_characters (campaign_id, character_id) VALUES (?, ?)')
    .run(campaignId, characterId);
  setActiveCharacterId(characterId);
}

// Blank starter character for newly-created characters.
function blankCharacter(name) {
  return {
    basicInfo: {
      name: name || 'New Character', pronouns: '', ancestry: '', community: '',
      class: '', subclass: '', level: 1, proficiency: 1
    },
    traits: { agility: 0, strength: 0, finesse: 0, instinct: 0, presence: 0, knowledge: 0 },
    resources: {
      hp:     { current: 0, max: 6 },
      stress: { current: 0, max: 6 },
      hope:   2,
      gold:   { handfuls: 0, bags: 0, chests: 0 }
    },
    thresholds: { major: 0, severe: 0 },
    defenses: { evasion: 10 },
    armor: { equippedId: null, slotsMax: 0, slotsUsed: 0, items: [] },
    conditions: { vulnerable: false, restrained: false, hidden: false, unconscious: false },
    attacks: [], weapons: [], inventory: [], domainCards: [],
    experiences: [], features: [], downtimeProjects: [],
    notes: '',
    dead: false
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActiveCharacterId() {
  const row = db.prepare("SELECT value FROM app_state WHERE key='active_character_id'").get();
  if (row) return parseInt(row.value, 10);
  const first = db.prepare('SELECT id FROM characters ORDER BY id ASC LIMIT 1').get();
  if (!first) return null;
  setActiveCharacterId(first.id);
  return first.id;
}

function setActiveCharacterId(id) {
  db.prepare("INSERT OR REPLACE INTO app_state (key,value) VALUES ('active_character_id', ?)")
    .run(String(id));
}

// Active branch is scoped to a character (defaults to the active one).
function getActiveBranch(characterId = getActiveCharacterId()) {
  let b = db.prepare(
    'SELECT * FROM branches WHERE character_id = ? AND is_active = 1 LIMIT 1'
  ).get(characterId);
  if (!b) {
    // Self-heal: no active branch for this character — activate its newest.
    b = db.prepare('SELECT * FROM branches WHERE character_id = ? ORDER BY id DESC LIMIT 1').get(characterId);
    if (b) db.prepare('UPDATE branches SET is_active = 1 WHERE id = ?').run(b.id);
  }
  return b;
}

function getLatestSnapshot(branchId) {
  return db.prepare(
    'SELECT * FROM snapshots WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
}

function getActiveSessionId() {
  const row = db.prepare("SELECT value FROM app_state WHERE key='active_session_id'").get();
  return row ? parseInt(row.value, 10) : null;
}

function setActiveSessionId(id) {
  db.prepare("INSERT OR REPLACE INTO app_state (key,value) VALUES ('active_session_id',?)").run(String(id));
}

function clearActiveSessionId() {
  db.prepare("DELETE FROM app_state WHERE key='active_session_id'").run();
}

function diffCharacter(oldC, newC) {
  const msgs = [];
  if (oldC.resources.hp.current !== newC.resources.hp.current)
    msgs.push(`HP: ${oldC.resources.hp.current} → ${newC.resources.hp.current}`);
  if (oldC.resources.stress.current !== newC.resources.stress.current)
    msgs.push(`Stress: ${oldC.resources.stress.current} → ${newC.resources.stress.current}`);
  if (oldC.resources.hope !== newC.resources.hope)
    msgs.push(`Hope: ${oldC.resources.hope} → ${newC.resources.hope}`);
  const g0 = oldC.resources.gold, g1 = newC.resources.gold;
  if (g0.chests !== g1.chests || g0.bags !== g1.bags || g0.handfuls !== g1.handfuls)
    msgs.push(`Gold: ${g0.chests}ch ${g0.bags}bg ${g0.handfuls}hf → ${g1.chests}ch ${g1.bags}bg ${g1.handfuls}hf`);
  if (oldC.armor.slotsUsed !== newC.armor.slotsUsed)
    msgs.push(`Armor slots: ${oldC.armor.slotsUsed} → ${newC.armor.slotsUsed}`);
  for (const cond of ['vulnerable', 'restrained', 'hidden', 'unconscious']) {
    if (oldC.conditions[cond] !== newC.conditions[cond])
      msgs.push(`Condition: ${cond.charAt(0).toUpperCase() + cond.slice(1)} ${newC.conditions[cond] ? 'gained' : 'cleared'}`);
  }
  const oldDead = oldC.dead || false, newDead = newC.dead || false;
  if (!oldDead && newDead) msgs.push('💀 Character has died');
  if (oldDead && !newDead) msgs.push('Character revived');
  return msgs;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

// ── Auth ──────────────────────────────────────────────────────────────────────

const APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) {
  console.warn('WARNING: APP_PASSWORD is not set — write endpoints are unprotected');
}

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessionStore = new Map();

function parseCookies(req) {
  const cookies = {};
  const header  = req.headers.cookie;
  if (header) header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const token  = parseCookies(req).session;
  const expiry = token && sessionStore.get(token);
  if (!expiry || expiry < Date.now()) {
    if (token) sessionStore.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body ?? {};
  if (!APP_PASSWORD || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token  = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + SESSION_TTL;
  sessionStore.set(token, expiry);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}; Path=/`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).session;
  if (token) sessionStore.delete(token);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
  res.json({ ok: true });
});

// ── Characters ──────────────────────────────────────────────────────────────────

// GET /api/characters — card summaries for the selection page
app.get('/api/characters', (req, res) => {
  const activeId = getActiveCharacterId();
  const characters = db.prepare('SELECT * FROM characters ORDER BY id ASC').all();
  const campNames = db.prepare(`
    SELECT c.name FROM campaigns c
    JOIN campaign_characters cc ON cc.campaign_id = c.id
    WHERE cc.character_id = ? ORDER BY c.name`);

  const out = characters.map(ch => {
    const branch = db.prepare('SELECT * FROM branches WHERE character_id = ? AND is_active = 1 LIMIT 1').get(ch.id)
                || db.prepare('SELECT * FROM branches WHERE character_id = ? ORDER BY id DESC LIMIT 1').get(ch.id);
    let summary = null;
    if (branch) {
      const snap = getLatestSnapshot(branch.id);
      if (snap) {
        try {
          const c = JSON.parse(snap.character_data);
          summary = {
            name:     c.basicInfo?.name ?? ch.name,
            pronouns: c.basicInfo?.pronouns ?? '',
            ancestry: c.basicInfo?.ancestry ?? '',
            class:    c.basicInfo?.class ?? '',
            subclass: c.basicInfo?.subclass ?? '',
            level:    c.basicInfo?.level ?? null,
            hp:       c.resources?.hp ?? null,
            dead:     c.dead === true
          };
        } catch { /* leave summary null */ }
      }
    }
    return {
      id: ch.id, name: ch.name, createdAt: ch.created_at,
      active: ch.id === activeId, summary,
      campaigns: campNames.all(ch.id).map(r => r.name)
    };
  });
  res.json(out);
});

// POST /api/characters — create a new (blank) character
app.post('/api/characters', requireAuth, (req, res) => {
  const name = (req.body && req.body.name && req.body.name.trim()) || 'New Character';
  const characterId = db.prepare('INSERT INTO characters (name) VALUES (?)').run(name).lastInsertRowid;
  const branchId = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active, character_id) VALUES ('main', NULL, 1, ?)`
  ).run(characterId).lastInsertRowid;
  const snap = db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, NULL, 'Initial character', ?)`
  ).run(branchId, JSON.stringify(blankCharacter(name)));
  setActiveCharacterId(characterId);
  res.json({ characterId, branchId, snapshotId: snap.lastInsertRowid });
});

// POST /api/characters/select/:id — set the active character (view pointer only, no auth)
app.post('/api/characters/select/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ch = db.prepare('SELECT id FROM characters WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: 'Character not found' });
  setActiveCharacterId(id);
  res.json({ activeCharacterId: id });
});

// ── Campaigns ───────────────────────────────────────────────────────────────────

// GET /api/campaigns — list with member counts
app.get('/api/campaigns', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM campaign_characters cc WHERE cc.campaign_id = c.id) AS characterCount,
      (SELECT COUNT(*) FROM sessions s WHERE s.campaign_id = c.id) AS sessionCount
    FROM campaigns c ORDER BY c.id ASC`).all();
  res.json(rows);
});

// GET /api/campaigns/:id — detail with members and sessions
app.get('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const characters = db.prepare(`
    SELECT ch.id, ch.name FROM characters ch
    JOIN campaign_characters cc ON cc.character_id = ch.id
    WHERE cc.campaign_id = ? ORDER BY ch.name`).all(id);

  const sessions = db.prepare(`
    SELECT s.*, ch.name AS character_name,
      (SELECT COUNT(*) FROM session_entries se WHERE se.session_id = s.id) AS entryCount
    FROM sessions s
    LEFT JOIN branches b ON b.id = s.branch_id
    LEFT JOIN characters ch ON ch.id = b.character_id
    WHERE s.campaign_id = ? ORDER BY s.id DESC`).all(id);

  res.json({ ...campaign, characters, sessions });
});

// POST /api/campaigns — create
app.post('/api/campaigns', requireAuth, (req, res) => {
  const name = req.body && req.body.name && req.body.name.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const description = (req.body.description || '').trim();
  const id = db.prepare('INSERT INTO campaigns (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid;
  res.json({ id });
});

// POST /api/campaigns/:id/characters — add a character to a campaign
app.post('/api/campaigns/:id/characters', requireAuth, (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const characterId = req.body && parseInt(req.body.characterId, 10);
  if (!characterId) return res.status(400).json({ error: 'characterId is required' });
  if (!db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId))
    return res.status(404).json({ error: 'Campaign not found' });
  if (!db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId))
    return res.status(404).json({ error: 'Character not found' });
  db.prepare('INSERT OR IGNORE INTO campaign_characters (campaign_id, character_id) VALUES (?, ?)')
    .run(campaignId, characterId);
  res.json({ ok: true });
});

// POST /api/campaigns/:id/characters/remove — remove a character from a campaign
app.post('/api/campaigns/:id/characters/remove', requireAuth, (req, res) => {
  const campaignId = parseInt(req.params.id, 10);
  const characterId = req.body && parseInt(req.body.characterId, 10);
  if (!characterId) return res.status(400).json({ error: 'characterId is required' });
  db.prepare('DELETE FROM campaign_characters WHERE campaign_id = ? AND character_id = ?')
    .run(campaignId, characterId);
  res.json({ ok: true });
});

// GET /api/character
app.get('/api/character', (req, res) => {
  const characterId = getActiveCharacterId();
  const branch   = getActiveBranch(characterId);
  const snapshot = getLatestSnapshot(branch.id);
  const campaigns = db.prepare(`
    SELECT c.id, c.name FROM campaigns c
    JOIN campaign_characters cc ON cc.campaign_id = c.id
    WHERE cc.character_id = ? ORDER BY c.name`).all(characterId);
  res.json({
    snapshotId:   snapshot.id,
    branchId:     branch.id,
    branchName:   branch.name,
    characterId,
    campaigns,
    description:  snapshot.description,
    createdAt:    snapshot.created_at,
    character:    JSON.parse(snapshot.character_data)
  });
});

// POST /api/character/save
app.post('/api/character/save', requireAuth, (req, res) => {
  const { description, character } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (!character || typeof character !== 'object') {
    return res.status(400).json({ error: 'character data is required' });
  }

  const branch   = getActiveBranch();
  const previous = getLatestSnapshot(branch.id);

  const snap = db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, ?, ?, ?)`
  ).run(branch.id, previous.id, description.trim(), JSON.stringify(character));

  const sessionId = getActiveSessionId();
  if (sessionId) {
    const oldC = JSON.parse(previous.character_data);
    const msgs = diffCharacter(oldC, character);
    const insertEntry = db.prepare(
      'INSERT INTO session_entries (session_id, kind, content, snapshot_id) VALUES (?,?,?,?)'
    );
    for (const msg of msgs) {
      insertEntry.run(sessionId, 'stat', msg, snap.lastInsertRowid);
    }
  }

  res.json({ snapshotId: snap.lastInsertRowid });
});

// GET /api/history
app.get('/api/history', (req, res) => {
  const branch = getActiveBranch();
  const rows   = db.prepare(
    `SELECT id, branch_id, parent_id, description, created_at
     FROM snapshots WHERE branch_id = ? ORDER BY id ASC`
  ).all(branch.id);
  res.json({ branchId: branch.id, branchName: branch.name, snapshots: rows });
});

// GET /api/branches
app.get('/api/branches', (req, res) => {
  const characterId = getActiveCharacterId();
  const branches = db.prepare('SELECT * FROM branches WHERE character_id = ? ORDER BY id ASC').all(characterId);

  const enriched = branches.map(b => {
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM snapshots WHERE branch_id = ?'
    ).get(b.id).n;

    let parentInfo = null;
    if (b.parent_snapshot_id) {
      const ps = db.prepare(
        `SELECT s.description, s.created_at, br.name AS branch_name
         FROM snapshots s JOIN branches br ON br.id = s.branch_id
         WHERE s.id = ?`
      ).get(b.parent_snapshot_id);
      parentInfo = ps || null;
    }

    return { ...b, snapshotCount: count, parentSnapshot: parentInfo };
  });

  res.json(enriched);
});

// POST /api/branches/restore/:snapshotId
app.post('/api/branches/restore/:snapshotId', requireAuth, (req, res) => {
  const snapshotId = parseInt(req.params.snapshotId, 10);
  const source = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!source) return res.status(404).json({ error: 'Snapshot not found' });

  const branchName = (req.body && req.body.branchName)
    ? req.body.branchName.trim()
    : `Restore from "${source.description}"`;

  // Resolve which character this snapshot belongs to (via its branch).
  const sourceBranch = db.prepare('SELECT character_id FROM branches WHERE id = ?').get(source.branch_id);
  const characterId  = sourceBranch ? sourceBranch.character_id : getActiveCharacterId();

  db.prepare('UPDATE branches SET is_active = 0 WHERE character_id = ?').run(characterId);
  const newBranch = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active, character_id) VALUES (?, ?, 1, ?)`
  ).run(branchName, snapshotId, characterId);

  const newSnap = db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, ?, ?, ?)`
  ).run(
    newBranch.lastInsertRowid,
    snapshotId,
    `Restored from: "${source.description}"`,
    source.character_data
  );

  res.json({
    branchId:   newBranch.lastInsertRowid,
    snapshotId: newSnap.lastInsertRowid
  });
});

// POST /api/branches/switch/:branchId
app.post('/api/branches/switch/:branchId', requireAuth, (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });

  db.prepare('UPDATE branches SET is_active = 0 WHERE character_id = ?').run(branch.character_id);
  db.prepare('UPDATE branches SET is_active = 1 WHERE id = ?').run(branchId);

  res.json({ branchId, name: branch.name });
});

// GET /api/snapshots/:snapshotId
app.get('/api/snapshots/:snapshotId', (req, res) => {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?')
    .get(parseInt(req.params.snapshotId, 10));
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  res.json({ ...snap, character: JSON.parse(snap.character_data) });
});

// ── Session endpoints ─────────────────────────────────────────────────────────

// GET /api/session/active
app.get('/api/session/active', (req, res) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) return res.json({ session: null });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    clearActiveSessionId();
    return res.json({ session: null });
  }

  const entries = db.prepare(
    'SELECT id, kind, content, snapshot_id, created_at FROM session_entries WHERE session_id = ? ORDER BY id ASC'
  ).all(sessionId);

  res.json({ session: { ...session, entries } });
});

// POST /api/session/start
app.post('/api/session/start', requireAuth, (req, res) => {
  if (getActiveSessionId()) return res.status(409).json({ error: 'A session is already active' });

  const branch = getActiveBranch();
  const characterId = getActiveCharacterId();
  const name   = (req.body && req.body.name && req.body.name.trim()) || `Session`;

  // Resolve the campaign: explicit body.campaignId, else the character's first campaign.
  let campaignId = req.body && parseInt(req.body.campaignId, 10);
  if (!campaignId) {
    const row = db.prepare(
      'SELECT campaign_id AS id FROM campaign_characters WHERE character_id = ? ORDER BY campaign_id ASC LIMIT 1'
    ).get(characterId);
    campaignId = row ? row.id : null;
  }

  const result = db.prepare(
    'INSERT INTO sessions (name, branch_id, campaign_id) VALUES (?, ?, ?)'
  ).run(name, branch.id, campaignId);

  setActiveSessionId(result.lastInsertRowid);
  res.json({ sessionId: result.lastInsertRowid });
});

// POST /api/session/end
app.post('/api/session/end', requireAuth, (req, res) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) return res.status(404).json({ error: 'No active session' });

  db.prepare(
    "UPDATE sessions SET ended_at = datetime('now','localtime') WHERE id = ?"
  ).run(sessionId);
  clearActiveSessionId();

  res.json({ sessionId });
});

// POST /api/session/note
app.post('/api/session/note', requireAuth, (req, res) => {
  const sessionId = getActiveSessionId();
  if (!sessionId) return res.status(404).json({ error: 'No active session' });

  const content = req.body && req.body.content && req.body.content.trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  const result = db.prepare(
    'INSERT INTO session_entries (session_id, kind, content) VALUES (?, ?, ?)'
  ).run(sessionId, 'note', content);

  res.json({ entryId: result.lastInsertRowid });
});

// GET /api/sessions
app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare(`
    SELECT s.*, c.name AS campaign_name, ch.name AS character_name, ch.id AS character_id
    FROM sessions s
    LEFT JOIN campaigns c   ON c.id = s.campaign_id
    LEFT JOIN branches b    ON b.id = s.branch_id
    LEFT JOIN characters ch ON ch.id = b.character_id
    ORDER BY s.id DESC`).all();
  const enriched = sessions.map(s => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM session_entries WHERE session_id = ?').get(s.id).n;
    return { ...s, entryCount: count };
  });
  res.json(enriched);
});

// GET /api/sessions/:id
app.get('/api/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = db.prepare(`
    SELECT s.*, c.name AS campaign_name, ch.name AS character_name, ch.id AS character_id
    FROM sessions s
    LEFT JOIN campaigns c   ON c.id = s.campaign_id
    LEFT JOIN branches b    ON b.id = s.branch_id
    LEFT JOIN characters ch ON ch.id = b.character_id
    WHERE s.id = ?`).get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const entries = db.prepare(
    'SELECT id, kind, content, snapshot_id, created_at FROM session_entries WHERE session_id = ? ORDER BY id ASC'
  ).all(id);

  res.json({ ...session, entries });
});

// GET /api/backup
app.get('/api/backup', requireAuth, (req, res) => {
  const characters         = db.prepare('SELECT * FROM characters ORDER BY id ASC').all();
  const campaigns          = db.prepare('SELECT * FROM campaigns ORDER BY id ASC').all();
  const campaignCharacters = db.prepare('SELECT * FROM campaign_characters').all();
  const branches           = db.prepare('SELECT * FROM branches ORDER BY id ASC').all();
  const snapshots          = db.prepare('SELECT * FROM snapshots ORDER BY id ASC').all();
  const sessions           = db.prepare('SELECT * FROM sessions ORDER BY id ASC').all();
  const sessionEntries     = db.prepare('SELECT * FROM session_entries ORDER BY id ASC').all();
  const appState           = db.prepare('SELECT * FROM app_state').all();

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="daggerheart-backup-${date}.json"`);
  res.json({ exportedAt: new Date().toISOString(), version: 2,
    characters, campaigns, campaignCharacters,
    branches, snapshots, sessions, sessionEntries, appState });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

initDb();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Daggerheart app running at http://localhost:${PORT}`);
  console.log(`Character sheet: http://localhost:${PORT}/character.html`);
});
