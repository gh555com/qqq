const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class TransactionManager {
    static STORAGE_KEY = 'qqq.transactions';
    static context = null;

    static init(context) {
        this.context = context;
    }

    static createId() {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let id = "";
        for (let i = 0; i < 6; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }

    static async register(id, targetDir) {
        if (!this.context) return;
        const trans = this._getAll();
        trans[id] = {
            id,
            targetDir,
            startTime: Date.now(),
            tempFiles: [],
            landedFiles: [],
            status: 'pending' // pending -> committing -> done
        };
        await this._save(trans);
    }

    static async addTempFile(id, filePath) {
        if (!this.context) return;
        const trans = this._getAll();
        if (trans[id]) {
            // Avoid duplicates
            if (!trans[id].tempFiles.includes(filePath)) {
                trans[id].tempFiles.push(filePath);
                await this._save(trans);
            }
        }
    }

    static async commit(id, landedFiles) {
        if (!this.context) return;
        const trans = this._getAll();
        if (trans[id]) {
            trans[id].status = 'committing';
            trans[id].landedFiles = landedFiles || [];
            await this._save(trans);
        }
    }

    static async complete(id) {
        if (!this.context) return;
        const trans = this._getAll();
        if (trans[id]) {
            delete trans[id];
            await this._save(trans);
        }
    }

    static async rollback(id) {
        if (!this.context) return;
        const trans = this._getAll();
        if (trans[id]) {
            await this._cleanupFiles(trans[id]);
            delete trans[id];
            await this._save(trans);
        }
    }

    static async recover() {
        if (!this.context) return;
        const trans = this._getAll();
        let changed = false;

        for (const id in trans) {
            const t = trans[id];
            // If we are recovering, it means the extension was restarted or crashed.
            // Any pending/committing transactions are considered failed/interrupted.
            // We should clean them up to ensure "Zero Garbage".
            console.log(`[Transaction] Recovering/Rolling back transaction ${id}`);
            await this._cleanupFiles(t);
            delete trans[id];
            changed = true;
        }

        if (changed) await this._save(trans);
    }

    static async _cleanupFiles(t) {
        // Merge tempFiles and landedFiles
        const files = new Set([...(t.tempFiles || []), ...(t.landedFiles || [])]);

        for (const f of files) {
            try {
                if (fs.existsSync(f)) {
                    fs.unlinkSync(f);
                    console.log(`[Transaction] Deleted: ${f}`);
                }
                // Try cleaning related files (common in downloads)
                const related = [
                    f + ".part",
                    f + ".ytdl",
                    f + ".tmp",
                    f + ".aria2"
                ];
                for (const r of related) {
                    if (fs.existsSync(r)) {
                        fs.unlinkSync(r);
                        console.log(`[Transaction] Deleted related: ${r}`);
                    }
                }
            } catch (e) {
                console.error(`[Transaction] Failed to delete ${f}: ${e.message}`);
            }
        }
    }

    static _getAll() {
        return this.context.globalState.get(this.STORAGE_KEY, {});
    }

    static async _save(trans) {
        await this.context.globalState.update(this.STORAGE_KEY, trans);
    }
}

module.exports = TransactionManager;
