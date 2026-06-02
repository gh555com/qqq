// -*- coding: utf-8 -*-
// ============================================================================
// qgs-client.js — SQLite-based qgs client for VS Code extension (q3)
//
// Uses sql.js (WASM, zero native deps) to access the same state.db as
// qqq-shell-v2's state-sqlite.ts. With WAL mode, both processes can
// read/write concurrently — a true "single truth machine".
//
// API mirrors state-sdk.js:
//   const qgs = require('./qgs-client');
//   const clip = qgs.ns('qqq.clip', { v: 1, form: 'doc' });
//   const hist = await clip.get('history');
//   await clip.setNow('history', payload);
// ============================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');

// Lazy-loaded sql.js
let _SQL = null;
let _db = null;
let _ready = null;
let _readyOk = false;

// ---------------------------------------------------------------------------
// DB path discovery
// ---------------------------------------------------------------------------

/**
 * Find state.db path. Priority:
 *   1. QQQ_STATE_DB env var
 *   2. ~/.qqq/state/state.db (shared well-known location)
 *   3. Walk up from __dirname to find qqq-shell-v2/userData/state/state.db
 */
function _findStateDb() {
    // 1. Env override
    if (process.env.QQQ_STATE_DB) return process.env.QQQ_STATE_DB;

    // 2. Shared well-known location (~/.qqq/state/state.db)
    const sharedPath = path.join(os.homedir(), '.qqq', 'state', 'state.db');
    if (fs.existsSync(sharedPath)) return sharedPath;

    // 3. Walk up from __dirname looking for qqq-shell-v2
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, '..', 'qqq-shell-v2', 'userData', 'state', 'state.db');
        try {
            if (fs.existsSync(candidate)) return path.resolve(candidate);
        } catch (_) { /* ignore */ }
        dir = path.join(dir, '..');
    }

    // 4. Fallback: use shared location (will create if not exists)
    return sharedPath;
}

// ---------------------------------------------------------------------------
// Init (lazy, triggered on first use)
// ---------------------------------------------------------------------------

function _init() {
    if (_ready) return _ready;
    _ready = _doInit();
    return _ready;
}

async function _doInit() {
    try {
        // Dynamic require to avoid crash if sql.js not installed
        const initSqlJs = require('sql.js');
        _SQL = await initSqlJs();

        const dbPath = _findStateDb();
        const dbDir = path.dirname(dbPath);
        try { fs.mkdirSync(dbDir, { recursive: true }); } catch (_) { /* ignore */ }

        if (fs.existsSync(dbPath)) {
            try {
                const buf = fs.readFileSync(dbPath);
                _db = new _SQL.Database(buf);
            } catch (e) {
                console.warn('[qgs-client] failed to load state.db, starting fresh:', e.message);
                _db = new _SQL.Database();
            }
        } else {
            _db = new _SQL.Database();
        }

        // Ensure schema (idempotent — matches state-sqlite.ts)
        _db.run(
            `CREATE TABLE IF NOT EXISTS state (
                ns TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                meta TEXT,
                updated_at INTEGER DEFAULT 0,
                PRIMARY KEY (ns, key)
            )`
        );
        _db.run('PRAGMA journal_mode=WAL');
        _db.run('PRAGMA synchronous=NORMAL');  // NORMAL is safe with WAL
        _db.run('PRAGMA busy_timeout=5000');

        _readyOk = true;
        console.log('[qgs-client] ready, db=', dbPath);
    } catch (e) {
        console.error('[qgs-client] init failed:', e.message);
        _readyOk = false;
    }
}

async function _ensureReady() {
    await _init();
    if (!_readyOk) throw new Error('qgs-client not ready');
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

function _saveDb() {
    if (!_db || !_readyOk) return;
    try {
        const data = _db.export();
        const buf = Buffer.from(data);
        const dbPath = _findStateDb();
        // Atomic write: tmp + rename
        const tmpPath = dbPath + '.tmp.' + Date.now();
        fs.writeFileSync(tmpPath, buf);
        try {
            fs.renameSync(tmpPath, dbPath);
        } catch (e) {
            // Retry: unlink target then rename
            try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (_) { /* ignore */ }
            fs.renameSync(tmpPath, dbPath);
        }
    } catch (e) {
        console.error('[qgs-client] _saveDb error:', e.message);
    }
}

// ---------------------------------------------------------------------------
// QgsNs — namespace handle (returned by qgs.ns())
// ---------------------------------------------------------------------------

class QgsNs {
    constructor(ns, schema) {
        this._ns = ns;
        this._schema = schema || { v: 1, form: 'doc' };
    }

    async get(key) {
        await _ensureReady();
        try {
            const stmt = _db.prepare('SELECT value FROM state WHERE ns = ? AND key = ?');
            stmt.bind([this._ns, key]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                stmt.free();
                return row.value ? JSON.parse(row.value) : null;
            }
            stmt.free();
            return null;
        } catch (e) {
            console.error('[qgs-client] get error:', e.message);
            return null;
        }
    }

    async set(key, value) {
        await _ensureReady();
        try {
            const json = JSON.stringify(value);
            const now = Date.now();
            _db.run(
                'INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)',
                [this._ns, key, json, '{}', now]
            );
            _saveDb();
        } catch (e) {
            console.error('[qgs-client] set error:', e.message);
        }
    }

    async setNow(key, value) {
        // setNow is same as set in this client (no debounce needed)
        return this.set(key, value);
    }

    async append(key, value) {
        await _ensureReady();
        try {
            const existing = await this.get(key);
            const arr = Array.isArray(existing) ? existing : [];
            arr.push(value);
            await this.setNow(key, arr);
        } catch (e) {
            console.error('[qgs-client] append error:', e.message);
        }
    }

    async del(key) {
        await _ensureReady();
        try {
            _db.run('DELETE FROM state WHERE ns = ? AND key = ?', [this._ns, key]);
            _saveDb();
        } catch (e) {
            console.error('[qgs-client] del error:', e.message);
        }
    }

    async list() {
        await _ensureReady();
        try {
            const keys = [];
            const stmt = _db.prepare('SELECT key FROM state WHERE ns = ? ORDER BY updated_at DESC');
            stmt.bind([this._ns]);
            while (stmt.step()) {
                keys.push(stmt.getAsObject().key);
            }
            stmt.free();
            return keys;
        } catch (e) {
            console.error('[qgs-client] list error:', e.message);
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

/**
 * Get a namespace handle.
 * @param {string} ns - Namespace (e.g., 'qqq.clip', 'qqq.cache')
 * @param {object} [schema] - Schema config { v, form }
 * @returns {QgsNs}
 */
function ns(ns, schema) {
    return new QgsNs(ns, schema);
}

/**
 * Force close the database (call on extension deactivate).
 */
async function close() {
    if (_db) {
        _saveDb();
        _db.close();
        _db = null;
        _readyOk = false;
        _ready = null;
    }
}

module.exports = { ns, close };
