'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { DatabaseSync } = require('node:sqlite');

// ── Database ──────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, 'db', 'daggerheart.sqlite');

let db;

function openDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
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
  `);

  const count = db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
  if (count === 0) {
    seed();
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
      hp:     { current: 12, max: 12 },
      stress: { current: 0,  max: 12 },
      hope:   3,
      gold:   { handfuls: 0, bags: 0, chests: 0 }
    },
    // Effective damage thresholds (armor base + level). Minor < Major < Severe.
    // Gap: major − minor = 12, severe − major = 21 (per River's armor).
    thresholds: { minor: 5, major: 17, severe: 38 },
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
      { name: 'Fireball',       type: 'spell',  mod: 4,
        diceCount: 4, diceSides: 20, dmod: 5,  damageType: 'magical',  trait: 'presence',
        range: ['Far'],  aoe: true,  friendlyFire: true,
        note: 'AoE Very Close around target. Reaction Roll DC13: fail=full damage, success=half.' },
      { name: 'Wild Flame',     type: 'spell',  mod: 4,
        diceCount: 2, diceSides: 6,  dmod: 0,  damageType: 'magical',  trait: 'presence',
        range: ['Melee'], aoe: true,
        note: 'Up to 3 targets in Melee range of River.' },
      { name: 'Wall of Flame',  type: 'spell',  mod: 4,
        diceCount: 4, diceSides: 10, dmod: 3,  damageType: 'magical',  trait: 'presence',
        range: ['Melee', 'Close', 'Far'], noRoll: true,
        note: 'Flat damage to anything crossing. No attack roll needed against crossing creatures.' },
      { name: 'Mystic Tether',  type: 'spell',  mod: 4,
        diceCount: 0, diceSides: 6,  dmod: 0,  damageType: null,       trait: 'presence',
        range: ['Far'], utility: true, groundsFliers: true,
        note: 'No damage. Restrains target at Far range. Also grounds flying enemies.' },
      { name: 'Blunderburst',   type: 'weapon', mod: 2,
        diceCount: 2, diceSides: 8,  dmod: 6,  damageType: 'physical', trait: 'agility',
        range: ['Close'],
        note: 'Reliable single-target Close attack. Highest flat modifier of any weapon.' },
      { name: 'Bladed Whip',    type: 'weapon', mod: 1,
        diceCount: 4, diceSides: 8,  dmod: 3,  damageType: 'physical', trait: 'finesse',
        range: ['Melee'],
        note: 'High die-count Melee strike. Lower hit modifier but strong damage ceiling.' },
      { name: 'Whip',           type: 'weapon', mod: 4,
        diceCount: 2, diceSides: 6,  dmod: 0,  damageType: 'physical', trait: 'finesse',
        range: ['Melee', 'Very Short'],
        note: 'Highest hit modifier of any weapon. Light damage but nearly guaranteed to land.' },
      { name: 'Long Tongue',    type: 'weapon', mod: 2,
        diceCount: 4, diceSides: 12, dmod: 0,  damageType: 'physical', trait: 'agility',
        range: ['Close'], costStress: true,
        note: 'Exceptional damage ceiling. Costs 1 Stress — a strong trade when Stress is available.' },
      { name: 'Construct Attack', type: 'ability', mod: 4,
        diceCount: 2, diceSides: 10, dmod: 3, damageType: 'physical', trait: 'agility',
        range: ['Melee', 'Close', 'Far'], needConstruct: true,
        note: 'Flexible range and high hit modifier. Maximises value while the construct is active.' }
    ],
    weapons: [
      { id: 'w1', name: 'Blunderburst', wield: 'main', trait: 'agility', range: 'Close',
        diceCount: 2, diceSides: 8,  dmod: 6, damageType: 'physical', note: '' },
      { id: 'w2', name: 'Bladed Whip',  wield: 'main', trait: 'finesse', range: 'Melee',
        diceCount: 4, diceSides: 8,  dmod: 3, damageType: 'physical', note: '' },
      { id: 'w3', name: 'Whip',         wield: 'off',  trait: 'finesse', range: 'Melee',
        diceCount: 2, diceSides: 6,  dmod: 0, damageType: 'physical', note: '' },
      { id: 'w4', name: 'Long Tongue',  wield: 'main', trait: 'agility', range: 'Close',
        diceCount: 4, diceSides: 12, dmod: 0, damageType: 'physical', note: 'Costs 1 Stress.' }
    ],
    inventory:   [],
    domainCards: [],
    experiences: [
      { id: 'exp1', name: 'Experience 1', description: '', modifier: 2 },
      { id: 'exp2', name: 'Experience 2', description: '', modifier: 2 }
    ],
    notes: ''
  };

  const insertBranch = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active) VALUES ('main', NULL, 1)`
  );
  const branchId = insertBranch.run().lastInsertRowid;

  db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, NULL, 'Initial character — River Sky, Ribbet Wordsmith Lv.5', ?)`
  ).run(branchId, JSON.stringify(character));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActiveBranch() {
  return db.prepare('SELECT * FROM branches WHERE is_active = 1 LIMIT 1').get();
}

function getLatestSnapshot(branchId) {
  return db.prepare(
    'SELECT * FROM snapshots WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));

// GET /api/character
app.get('/api/character', (req, res) => {
  const branch   = getActiveBranch();
  const snapshot = getLatestSnapshot(branch.id);
  res.json({
    snapshotId:  snapshot.id,
    branchId:    branch.id,
    branchName:  branch.name,
    description: snapshot.description,
    createdAt:   snapshot.created_at,
    character:   JSON.parse(snapshot.character_data)
  });
});

// POST /api/character/save
app.post('/api/character/save', (req, res) => {
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
  const branches = db.prepare('SELECT * FROM branches ORDER BY id ASC').all();

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
app.post('/api/branches/restore/:snapshotId', (req, res) => {
  const snapshotId = parseInt(req.params.snapshotId, 10);
  const source = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!source) return res.status(404).json({ error: 'Snapshot not found' });

  const branchName = (req.body && req.body.branchName)
    ? req.body.branchName.trim()
    : `Restore from "${source.description}"`;

  db.prepare('UPDATE branches SET is_active = 0').run();
  const newBranch = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active) VALUES (?, ?, 1)`
  ).run(branchName, snapshotId);

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
app.post('/api/branches/switch/:branchId', (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });

  db.prepare('UPDATE branches SET is_active = 0').run();
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

// ── Boot ──────────────────────────────────────────────────────────────────────

initDb();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Daggerheart app running at http://localhost:${PORT}`);
  console.log(`Character sheet: http://localhost:${PORT}/character.html`);
});
