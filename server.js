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
  // v2 redesign: campaign flavour + per-character ownership (read with COALESCE(...,'you')).
  if (!hasColumn('campaigns', 'gm')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN gm TEXT');
  }
  if (!hasColumn('campaigns', 'tagline')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN tagline TEXT');
  }
  if (!hasColumn('characters', 'owner')) {
    db.exec('ALTER TABLE characters ADD COLUMN owner TEXT');
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

// Stamp a character + its main branch + initial snapshot, optionally joining a campaign.
function seedCharacter(name, owner, data, campaignId) {
  const characterId = db.prepare('INSERT INTO characters (name, owner) VALUES (?, ?)').run(name, owner).lastInsertRowid;
  const branchId = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active, character_id) VALUES ('main', NULL, 1, ?)`
  ).run(characterId).lastInsertRowid;
  const snap = db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data) VALUES (?, NULL, ?, ?)`
  ).run(branchId, `Initial character — ${name}`, JSON.stringify(data));
  if (campaignId) {
    db.prepare('INSERT OR IGNORE INTO campaign_characters (campaign_id, character_id) VALUES (?, ?)')
      .run(campaignId, characterId);
  }
  return { characterId, branchId, snapshotId: snap.lastInsertRowid };
}

// A light party-member PC (another player's hero, or a fallen one) — just enough for
// the campaign roster + peek sheet.
function partyMember(o) {
  return {
    basicInfo: { name: o.name, pronouns: '', ancestry: o.ancestry || '', community: '',
      class: o.cls, subclass: o.subclass || '', level: o.level || 5, proficiency: Math.ceil((o.level || 5) / 2) },
    traits: { agility: 0, strength: 0, finesse: 0, instinct: 0, presence: 0, knowledge: 0 },
    resources: { hp: { current: o.hp, max: o.hpMax }, stress: { current: o.stress || 0, max: o.stressMax || 6 },
      hope: o.hope ?? 2, gold: { handfuls: 0, bags: 0, chests: 0 } },
    thresholds: { major: 0, severe: 0 }, defenses: { evasion: 10 },
    armor: { equippedId: null, slotsMax: 0, slotsUsed: 0, items: [] },
    conditions: { vulnerable: false, restrained: false, hidden: false, unconscious: false },
    attacks: [], weapons: [], inventory: [], domainCards: [], experiences: [], features: [], downtimeProjects: [],
    portrait: { hue: o.hue, glyph: o.glyph }, notes: '', dead: !!o.dead,
    ...(o.fellAt ? { fellAt: o.fellAt } : {}),
    ...(o.epitaph ? { epitaph: o.epitaph } : {}),
  };
}

function seed() {
  const character = {
    basicInfo: {
      name: 'River Sky',
      pronouns: 'they/them',
      ancestry: 'Ribbet',
      community: 'Loreborne',
      class: 'Sorcerer',
      subclass: 'Wordsmith',
      level: 5,
      proficiency: 4
    },
    portrait: { hue: 32, glyph: '✦' },
    traits: {
      agility: 1,
      strength: 0,
      finesse: 2,
      instinct: 0,
      presence: 4,
      knowledge: 0
    },
    resources: {
      hp:     { current: 7, max: 12 },
      stress: { current: 4, max: 12 },
      hope:   3,
      gold:   { handfuls: 4, bags: 2, chests: 0 }
    },
    thresholds: { major: 17, severe: 38 },
    defenses: { evasion: 12 },
    armor: {
      equippedId: 'ar1',
      slotsMax:   4,   // River has 4 armor slots
      slotsUsed:  1,
      items: [ { id: 'ar1', name: 'Quilted Cloak', major: 7, severe: 14, slots: 4 } ]
    },
    conditions: {
      vulnerable:  true,
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
    inventory: [
      { id: 'i1', name: 'Lyra of Whispers', qty: 1, note: 'Bardic focus. +1 to Presence rolls when held.' },
      { id: 'i2', name: 'Healing Salve',    qty: 3, note: 'Restore 1d4 HP. Single use.' },
      { id: 'i3', name: 'Spell Components',  qty: 1, note: 'Pouch — sufficient for any spell unless the GM says otherwise.' },
      { id: 'i4', name: 'Travel Rations',    qty: 5, note: '1 day of food.' },
      { id: 'i5', name: 'Hooded Cloak',      qty: 1, note: '+1 to Hide rolls in dim light.' }
    ],
    domainCards: [
      { id: 'd1', name: 'Parallela', domain: 'Codex', recall: 2, level: 3, type: 'Spell',
        summary: "Mirror an ally's last action.",
        text: 'Spend 2 Hope. Choose an ally within Close range. You may immediately repeat the most recent action they took, using your own roll. The action shares its target restrictions and resource costs.' },
      { id: 'd2', name: 'Repudiate', domain: 'Codex', recall: 1, level: 2, type: 'Reaction',
        summary: 'Cancel an enemy spell.',
        text: 'When an enemy within Far range casts a spell, you may interrupt it with a Presence reaction roll vs. their Spellcast. On success, the spell fizzles and the caster takes 1 Stress.' },
      { id: 'd3', name: 'Flame Hound', domain: 'Codex', recall: 3, level: 4, type: 'Summon',
        summary: 'Summon a fiery construct ally.',
        text: 'Mark 1 Stress to summon a Flame Hound at Close range. It has 5 HP, Evasion 11, and may use the Construct Attack action on your turn. The hound persists until destroyed or dismissed.' },
      { id: 'd4', name: "Wordsmith's Edge", domain: 'Codex', recall: 0, level: 1, type: 'Passive',
        summary: 'Add Knowledge to your Spellcast crits.',
        text: 'When you score a critical success on a Spellcast roll, add your Knowledge modifier to the damage dealt. Always active.' },
      { id: 'd5', name: 'Glyph of Warding', domain: 'Arcana', recall: 1, level: 2, type: 'Spell',
        summary: 'Place a damage rune on a surface.',
        text: 'Spend an action to inscribe a glyph at Close range. The first creature to cross it takes 2d8 magical damage. Lasts until triggered or until you take a long rest.' }
    ],
    experiences: [
      { id: 'exp1', name: 'Court Poet', modifier: 2, description: 'Knows the rhythms and rituals of noble houses.' },
      { id: 'exp2', name: 'Swamp-born', modifier: 2, description: 'Comfortable in wet, low-light environments.' }
    ],
    features: [
      { id: 'ft1', name: 'Volatile Magic',    note: 'Once per rest, reroll any number of your Spellcast damage dice.' },
      { id: 'ft2', name: 'Channel Raw Power', note: 'Spend a Hope to scribe a spell from a domain card; mark it to cast at +1d6.' },
      { id: 'ft3', name: 'Minor Illusion',    note: 'Create a small visual or audible illusion within Close range, no roll.' }
    ],
    downtimeProjects: [
      { id: 'dp1', name: 'Translate the Wordstone Codex',    progress: 5, max: 8, note: 'Each long rest: a Knowledge roll adds 1–2 segments.' },
      { id: 'dp2', name: 'Re-string the Lyra of Whispers',   progress: 8, max: 8, note: 'Complete — focus restored to full resonance.' },
      { id: 'dp3', name: 'Map the drowned approach to Vael', progress: 2, max: 6, note: 'Vesper is helping chart the tunnels.' }
    ],
    notes: 'Heading to the Whispering Vaults to recover the Wordstone. Captain Brell expects us by the new moon. Still carrying Thornwick’s signet — means to return it home.',
    dead: false
  };

  const campaignId = db.prepare(
    'INSERT INTO campaigns (name, description, gm, tagline) VALUES (?, ?, ?, ?)'
  ).run(
    'Embers of the Reach',
    'The borderlands are burning. Five companions chase the source of the wildfire blights to the drowned city of Vael.',
    'Dana',
    'A Daggerheart campaign'
  ).lastInsertRowid;

  const river = seedCharacter('River Sky', 'you', character, campaignId);

  const thorn = seedCharacter('Thornwick the Bold', 'you', partyMember({
    name: 'Thornwick the Bold', cls: 'Guardian', subclass: 'Stalwart', ancestry: 'Dwarf', level: 4,
    hue: 8, glyph: '❖', hp: 0, hpMax: 11, stress: 0, stressMax: 8, hope: 0, dead: true,
    fellAt: 'Session 6 · The Sundering Bridge', epitaph: 'Held the line so the others could cross.'
  }), campaignId);

  seedCharacter('Kesh Ironwood', 'Maya', partyMember({
    name: 'Kesh Ironwood', cls: 'Warrior', subclass: 'Call of the Brave', ancestry: 'Human', level: 5,
    hue: 145, glyph: '⚔', hp: 9, hpMax: 13, stress: 2, stressMax: 10, hope: 5 }), campaignId);
  seedCharacter('Vesper Quill', 'Theo', partyMember({
    name: 'Vesper Quill', cls: 'Rogue', subclass: 'Nightwalker', ancestry: 'Faerie', level: 5,
    hue: 268, glyph: '◐', hp: 4, hpMax: 9, stress: 6, stressMax: 9, hope: 2 }), campaignId);
  seedCharacter('Marrow', 'Sam', partyMember({
    name: 'Marrow', cls: 'Druid', subclass: 'Warden of Renewal', ancestry: 'Katari', level: 5,
    hue: 110, glyph: '❧', hp: 11, hpMax: 12, stress: 1, stressMax: 11, hope: 4 }), campaignId);

  // A little past history so the shared feed isn't empty on a fresh install.
  const s6 = db.prepare(
    "INSERT INTO sessions (name, started_at, ended_at, branch_id, campaign_id) VALUES (?, datetime('now','localtime','-9 days'), datetime('now','localtime','-9 days','+4 hours'), ?, ?)"
  ).run('Session 6 · The Sundering Bridge', thorn.branchId, campaignId).lastInsertRowid;
  const s7 = db.prepare(
    "INSERT INTO sessions (name, started_at, ended_at, branch_id, campaign_id) VALUES (?, datetime('now','localtime','-2 days'), datetime('now','localtime','-2 days','+3 hours'), ?, ?)"
  ).run('Session 7 · Into the Vaults', river.branchId, campaignId).lastInsertRowid;

  const entry = db.prepare(
    "INSERT INTO session_entries (session_id, kind, content, created_at) VALUES (?, ?, ?, datetime('now','localtime',?))");
  entry.run(s6, 'note', 'Death Move: Blaze of Glory — took the bridge down with the ogre. The party crossed safely.', '-9 days');
  entry.run(s7, 'stat', 'HP: 9 → 7', '-2 days');
  entry.run(s7, 'note', 'Found the Wordstone’s resting place sealed behind a glyph-locked door. Repudiate might crack it.', '-2 days');

  setActiveCharacterId(river.characterId);
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

// ── Roster / campaign-feed helpers (v2 redesign) ────────────────────────────────

// A character avatar in the v2 design is a coloured sigil, not real art. Derive a
// stable {hue, glyph} from the class when the character data doesn't carry one.
function classGlyph(cls) {
  return {
    Bard: '♪', Druid: '❧', Guardian: '❖', Ranger: '➶', Rogue: '◐',
    Seraph: '☼', Sorcerer: '✦', Warrior: '⚔', Wizard: '✶', Witch: '☾',
  }[cls] || '✦';
}
function classHue(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function derivePortrait(c) {
  if (c && c.portrait && typeof c.portrait === 'object') return c.portrait;
  const cls = c && c.basicInfo ? c.basicInfo.class : '';
  return { hue: classHue(cls || (c && c.basicInfo && c.basicInfo.name)), glyph: classGlyph(cls) };
}

// Summarise a character (row from `characters`) from its active branch's latest
// snapshot — everything the Campaign roster / switcher needs at a glance.
function characterCardSummary(ch) {
  const branch = db.prepare('SELECT * FROM branches WHERE character_id = ? AND is_active = 1 LIMIT 1').get(ch.id)
              || db.prepare('SELECT * FROM branches WHERE character_id = ? ORDER BY id DESC LIMIT 1').get(ch.id);
  let c = null;
  if (branch) {
    const snap = getLatestSnapshot(branch.id);
    if (snap) { try { c = JSON.parse(snap.character_data); } catch { /* leave null */ } }
  }
  const bi  = (c && c.basicInfo) || {};
  const res = (c && c.resources) || {};
  const hopeIsObj = res.hope && typeof res.hope === 'object';
  return {
    characterId: ch.id,
    name:     bi.name || ch.name,
    owner:    ch.owner || 'you',
    isYou:   (ch.owner || 'you') === 'you',
    status:  (c && c.dead) ? 'fallen' : 'active',
    class:    bi.class || '',
    subclass: bi.subclass || '',
    ancestry: bi.ancestry || '',
    level:    bi.level ?? null,
    portrait: derivePortrait(c),
    hp:       res.hp || null,
    stress:   res.stress || null,
    hope:    (hopeIsObj ? res.hope.current : res.hope) ?? 0,
    hopeMax: (hopeIsObj ? res.hope.max     : res.hopeMax) ?? 6,
    fellAt:  (c && c.fellAt) || null,
    epitaph: (c && c.epitaph) || null,
  };
}

// Build the shared campaign feed: session_entries across the campaign's sessions
// (attributed to each session's character + owner) plus derived session-start/end
// milestones. Timestamps are 'YYYY-MM-DD HH:MM:SS' localtime → lexicographically
// sortable; the client formats them into relative "when" labels.
function buildCampaignFeed(campaignId, limit = 30) {
  const campaign = db.prepare('SELECT name, gm FROM campaigns WHERE id = ?').get(campaignId) || {};
  const sessions = db.prepare(`
    SELECT s.id, s.name, s.started_at, s.ended_at,
           ch.name AS character_name, ch.owner AS owner
    FROM sessions s
    LEFT JOIN branches b   ON b.id = s.branch_id
    LEFT JOIN characters ch ON ch.id = b.character_id
    WHERE s.campaign_id = ? ORDER BY s.id ASC`).all(campaignId);

  const items = [];
  const entryStmt = db.prepare(
    'SELECT id, kind, content, created_at FROM session_entries WHERE session_id = ? ORDER BY id ASC');

  for (const s of sessions) {
    const who = s.character_name || campaign.name || 'The party';
    const owner = s.owner || 'you';
    if (s.started_at) items.push({ id: `ms${s.id}`, kind: 'milestone', who: campaign.name || who, actor: campaign.gm || 'GM', when: s.started_at, text: `${s.name} began` });
    if (s.ended_at)   items.push({ id: `me${s.id}`, kind: 'milestone', who: campaign.name || who, actor: campaign.gm || 'GM', when: s.ended_at,   text: `${s.name} ended` });
    for (const e of entryStmt.all(s.id)) {
      let kind = e.kind;
      if (/death move|blaze of glory|has died|has fallen/i.test(e.content)) kind = 'death';
      items.push({ id: `e${e.id}`, kind, who, actor: owner, when: e.created_at, text: e.content });
    }
  }
  items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return items.slice(0, limit);
}

// ── Page dates ────────────────────────────────────────────────────────────────
//
// Site-level created/modified dates, derived from git history at deploy time
// by scripts/generate-page-dates.sh (the image has no .git — see that script
// and msge-no ADR 0004 / hetzner-server ADR 0015). Missing file (e.g. a bare
// `docker compose build` that skipped `make deploy`) falls back to boot time.

const SITE_URL  = 'https://rpg.msge.no/';
const BOOT_ISO  = new Date().toISOString();

function loadPageDates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'page-dates.json'), 'utf8'));
    if (parsed.created && parsed.modified) return { created: parsed.created, modified: parsed.modified };
  } catch (_err) {
    // absent/unreadable — fall back to boot time below
  }
  return { created: BOOT_ISO, modified: BOOT_ISO };
}

const PAGE_DATES = loadPageDates();

// Stamps <meta name="date">/last-modified, article:published_time/modified_time
// and a minimal JSON-LD WebSite node into an HTML page's <head>. None of these
// pages carry a JSON-LD node of their own, so this always adds the minimal form.
function injectPageDates(html, dates) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'River Sky',
    url: SITE_URL,
    dateCreated: dates.created,
    datePublished: dates.created,
    dateModified: dates.modified,
  });
  const metaTags = `<meta name="date" content="${dates.created}">\n` +
    `<meta name="last-modified" content="${dates.modified}">\n` +
    `<meta property="article:published_time" content="${dates.created}">\n` +
    `<meta property="article:modified_time" content="${dates.modified}">\n` +
    `<script type="application/ld+json">${jsonLd}</script>\n`;
  return html.includes('</head>') ? html.replace('</head>', `${metaTags}</head>`) : html;
}

// Every HTML page this app serves — auth-gated or noindex pages still carry
// the metadata (see hetzner-server admin/adr precedent).
const HTML_PAGES = [
  'index.html', 'login.html', 'campaigns.html', 'character.html',
  'advisor.html', 'odds.html', 'sessions.html', 'mobile.html',
];

// Stamped once at boot and served from memory so the placeholder-free source
// files on disk are never shipped raw.
const pageCache = new Map(HTML_PAGES.map(file =>
  [file, injectPageDates(fs.readFileSync(path.join(__dirname, file), 'utf8'), PAGE_DATES)]));

const sitemapCache = fs.readFileSync(path.join(__dirname, 'sitemap.xml'), 'utf8')
  .replace('__SITE_MODIFIED_ISO__', PAGE_DATES.modified);

const LAST_MODIFIED_HTTP = new Date(PAGE_DATES.modified).toUTCString();

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// Unauthenticated liveness probe for the container healthcheck
// (hetzner-server ADR 0006 — box_health scrapes Docker health status).
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Served from memory (see "Page dates" above) — must come before the static
// handler below so the stamped copies win over the raw files on disk.
app.get(['/', ...HTML_PAGES.map(f => `/${f}`)], (req, res) => {
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.setHeader('Last-Modified', LAST_MODIFIED_HTTP);
  res.type('html').send(pageCache.get(file));
});

app.get('/sitemap.xml', (_req, res) => {
  res.setHeader('Last-Modified', LAST_MODIFIED_HTTP);
  res.type('application/xml').send(sitemapCache);
});

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
  const name  = (req.body && req.body.name && req.body.name.trim()) || 'New Character';
  const owner = (req.body && req.body.owner && String(req.body.owner).trim()) || 'you';
  const characterId = db.prepare('INSERT INTO characters (name, owner) VALUES (?, ?)').run(name, owner).lastInsertRowid;
  const branchId = db.prepare(
    `INSERT INTO branches (name, parent_snapshot_id, is_active, character_id) VALUES ('main', NULL, 1, ?)`
  ).run(characterId).lastInsertRowid;
  const snap = db.prepare(
    `INSERT INTO snapshots (branch_id, parent_id, description, character_data)
     VALUES (?, NULL, 'Initial character', ?)`
  ).run(branchId, JSON.stringify(blankCharacter(name)));
  // Optionally drop the new PC straight onto a campaign's table.
  const campaignId = req.body && parseInt(req.body.campaignId, 10);
  if (campaignId && db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId)) {
    db.prepare('INSERT OR IGNORE INTO campaign_characters (campaign_id, character_id) VALUES (?, ?)')
      .run(campaignId, characterId);
  }
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

// GET /api/campaigns/:id — detail with members (enriched roster), sessions, and feed
app.get('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const activeId = getActiveCharacterId();
  const memberRows = db.prepare(`
    SELECT ch.id, ch.name, ch.owner FROM characters ch
    JOIN campaign_characters cc ON cc.character_id = ch.id
    WHERE cc.campaign_id = ? ORDER BY ch.id`).all(id);
  // `characters` carries id + name (back-compat for campaigns.html) plus the v2 roster fields.
  const characters = memberRows.map(ch => ({
    ...characterCardSummary(ch),
    id: ch.id,
    isActive: ch.id === activeId,
  }));

  const sessions = db.prepare(`
    SELECT s.*, ch.name AS character_name,
      (SELECT COUNT(*) FROM session_entries se WHERE se.session_id = s.id) AS entryCount
    FROM sessions s
    LEFT JOIN branches b ON b.id = s.branch_id
    LEFT JOIN characters ch ON ch.id = b.character_id
    WHERE s.campaign_id = ? ORDER BY s.id DESC`).all(id);

  res.json({ ...campaign, characters, sessions, feed: buildCampaignFeed(id) });
});

// PATCH /api/campaigns/:id — edit campaign flavour (name / description / gm / tagline)
app.patch('/api/campaigns/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM campaigns WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Campaign not found' });

  const sets = [], vals = [];
  for (const k of ['name', 'description', 'gm', 'tagline']) {
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, k)) continue;
    const v = req.body[k];
    if (k === 'name' && !(v && String(v).trim())) continue;  // never blank the NOT NULL name
    sets.push(`${k} = ?`);
    vals.push(v == null ? null : String(v));
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  res.json({ ok: true });
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
