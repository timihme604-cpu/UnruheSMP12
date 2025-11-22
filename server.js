// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
// Load environment variables from .env if present
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
// Admin-Passwort (aus Umgebungsvariable oder Default)
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

// Middleware
app.use(bodyParser.json());
// Einfaches Request-Logging zur Fehlersuche
app.use((req, res, next) => {
    console.log(new Date().toISOString(), req.method, req.url);
    next();
});
// CORS erlauben (erlaubt Aufrufe vom Frontend, z.B. GitHub Pages)
app.use(cors());
app.use(express.static(__dirname)); // Macht alle HTML/CSS/JS Dateien verfügbar

// --- Datenstruktur für Abstimmungen ---
// Persistence: load/save from data.json
const dataFile = path.join(__dirname, 'data.json');

let polls = [];
let pollIdCounter = 1;
// Einfache Whitelist (in-memory fallback)
let whitelist = ["_xzl", "EnderPro", "PixelFreak", "UnruheSMP12"];
// Ausstehende Whitelist-Anfragen (nur sichtbar für Admin über UI)
let pendingRequests = [];

function loadData() {
    try {
        if (fs.existsSync(dataFile)) {
            const raw = fs.readFileSync(dataFile, 'utf8');
            if (raw && raw.trim().length) {
                const obj = JSON.parse(raw);
                polls = obj.polls || [];
                whitelist = obj.whitelist || whitelist;
                pendingRequests = obj.pendingRequests || [];
                pollIdCounter = obj.pollIdCounter || (polls.reduce((max, p) => Math.max(max, p.id), 0) + 1) || 1;
                console.log('Loaded data from', dataFile);
                return;
            }
        }
        // If we get here, create default file
        saveData();
    } catch (err) {
        console.error('Fehler beim Laden der Daten:', err);
    }
}

function saveToFile() {
    try {
        const tmpFile = dataFile + '.tmp';
        const toWrite = JSON.stringify({ polls, whitelist, pendingRequests, pollIdCounter }, null, 2);
        fs.writeFileSync(tmpFile, toWrite, 'utf8');
        fs.renameSync(tmpFile, dataFile);
    } catch (err) {
        console.error('Fehler beim Speichern der Daten:', err);
    }
}

// Load data at startup
loadData();

// --- SQLite DB (for durable local persistence)
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile);

function initDbAndMigrate() {
    db.serialize(() => {
        db.run("CREATE TABLE IF NOT EXISTS whitelist (user TEXT PRIMARY KEY)");
        db.run("CREATE TABLE IF NOT EXISTS pendingRequests (user TEXT PRIMARY KEY)");
        db.run("CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY, question TEXT, yes INTEGER, no INTEGER, comments TEXT, voters TEXT)");

        db.get("SELECT COUNT(*) as c FROM whitelist", (err, row) => {
            if (err) return console.error('DB count error', err);
            if (row && row.c > 0) {
                loadFromDb();
            } else {
                try {
                    if (fs.existsSync(dataFile)) {
                        const raw = fs.readFileSync(dataFile, 'utf8');
                        if (raw && raw.trim().length) {
                            const obj = JSON.parse(raw);
                            const wl = obj.whitelist || [];
                            const stmtWl = db.prepare('INSERT OR IGNORE INTO whitelist(user) VALUES (?)');
                            wl.forEach(u => stmtWl.run(u));
                            stmtWl.finalize();
                            const pr = obj.pendingRequests || [];
                            const stmtPr = db.prepare('INSERT OR IGNORE INTO pendingRequests(user) VALUES (?)');
                            pr.forEach(u => stmtPr.run(u));
                            stmtPr.finalize();
                            const pollsToInsert = obj.polls || [];
                            const stmtPoll = db.prepare('INSERT OR REPLACE INTO polls(id,question,yes,no,comments,voters) VALUES (?,?,?,?,?,?)');
                            pollsToInsert.forEach(p => {
                                stmtPoll.run(p.id, p.question, p.yes || 0, p.no || 0, JSON.stringify(p.comments || []), JSON.stringify(p.voters || {}));
                            });
                            stmtPoll.finalize();
                        }
                    }
                } catch (e) { console.error('Migration error', e); }
                loadFromDb();
                saveData();
            }
        });
    });
}

function loadFromDb() {
    db.all('SELECT user FROM whitelist', (err, rows) => { if (!err) whitelist = rows.map(r => r.user); });
    db.all('SELECT user FROM pendingRequests', (err, rows) => { if (!err) pendingRequests = rows.map(r => r.user); });
    db.all('SELECT * FROM polls', (err, rows) => {
        if (!err) {
            polls = rows.map(r => ({ id: r.id, question: r.question, yes: r.yes, no: r.no, comments: (() => { try { return JSON.parse(r.comments || '[]'); } catch(e){ return []; } })(), voters: (() => { try { return JSON.parse(r.voters || '{}'); } catch(e){ return {}; } })() }));
            pollIdCounter = polls.reduce((max, p) => Math.max(max, p.id), 0) + 1;
        }
    });
}

function persistAllToDb() {
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM whitelist');
        const stmtW = db.prepare('INSERT INTO whitelist(user) VALUES (?)');
        whitelist.forEach(u => stmtW.run(u));
        stmtW.finalize();

        db.run('DELETE FROM pendingRequests');
        const stmtP = db.prepare('INSERT INTO pendingRequests(user) VALUES (?)');
        pendingRequests.forEach(u => stmtP.run(u));
        stmtP.finalize();

        db.run('DELETE FROM polls');
        const stmtPoll = db.prepare('INSERT INTO polls(id,question,yes,no,comments,voters) VALUES (?,?,?,?,?,?)');
        polls.forEach(p => stmtPoll.run(p.id, p.question, p.yes || 0, p.no || 0, JSON.stringify(p.comments || []), JSON.stringify(p.voters || {})));
        stmtPoll.finalize();

        db.run('COMMIT');
    });
}
// If DATABASE_URL is provided, use Postgres; otherwise use SQLite
const usePg = !!process.env.DATABASE_URL;
let pgPool = null;
if (usePg) {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false });
    // Postgres init and migration
    function initPgAndMigrate() {
        pgPool.connect((err, client, release) => {
            if (err) return console.error('Postgres connect error', err);
            client.query(`
                CREATE TABLE IF NOT EXISTS whitelist ("user" TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS pendingRequests ("user" TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY, question TEXT, yes INTEGER, no INTEGER, comments TEXT, voters TEXT);
            `, (err) => {
                if (err) { console.error('Postgres init error', err); release(); return; }
                // Check if whitelist has rows
                client.query('SELECT COUNT(*) as c FROM whitelist', (err, res) => {
                    if (err) { console.error('Postgres count error', err); release(); return; }
                    const c = parseInt(res.rows[0].c, 10);
                    if (c > 0) {
                        // load
                        loadFromPg();
                        release();
                    } else {
                        // migrate from data.json
                        try {
                            if (fs.existsSync(dataFile)) {
                                const raw = fs.readFileSync(dataFile, 'utf8');
                                if (raw && raw.trim().length) {
                                    const obj = JSON.parse(raw);
                                    const wl = obj.whitelist || [];
                                    const pr = obj.pendingRequests || [];
                                    const pollsToInsert = obj.polls || [];
                                    // insert whitelist
                                    const wlPromises = wl.map(u => client.query('INSERT INTO whitelist("user") VALUES($1) ON CONFLICT DO NOTHING', [u]));
                                    // insert pending
                                    const prPromises = pr.map(u => client.query('INSERT INTO pendingRequests("user") VALUES($1) ON CONFLICT DO NOTHING', [u]));
                                    // insert polls
                                    const pollPromises = pollsToInsert.map(p => client.query('INSERT INTO polls(id,question,yes,no,comments,voters) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET question=EXCLUDED.question', [p.id, p.question, p.yes||0, p.no||0, JSON.stringify(p.comments||[]), JSON.stringify(p.voters||{})]));
                                    Promise.all([...wlPromises, ...prPromises, ...pollPromises]).then(()=>{
                                        loadFromPg();
                                        saveData();
                                        release();
                                    }).catch(e=>{ console.error('Postgres migration error', e); release(); });
                                } else { loadFromPg(); release(); }
                            } else { loadFromPg(); release(); }
                        } catch(e){ console.error('Postgres migration error', e); release(); }
                    }
                });
            });
        });
    }

    function loadFromPg() {
        // whitelist
        pgPool.query('SELECT "user" FROM whitelist').then(r => { whitelist = r.rows.map(x => x.user); }).catch(e=>console.error(e));
        pgPool.query('SELECT "user" FROM pendingRequests').then(r => { pendingRequests = r.rows.map(x => x.user); }).catch(e=>console.error(e));
        pgPool.query('SELECT * FROM polls').then(r => {
            polls = r.rows.map(row => {
                let comments = [];
                let voters = {};
                try { comments = JSON.parse(row.comments || '[]'); } catch(e) { comments = []; }
                try { voters = JSON.parse(row.voters || '{}'); } catch(e) { voters = {}; }
                return { id: row.id, question: row.question, yes: row.yes, no: row.no, comments, voters };
            });
            pollIdCounter = polls.reduce((max, p) => Math.max(max, p.id), 0) + 1;
        }).catch(e => console.error(e));
    }

    function persistAllToPg() {
        pgPool.connect((err, client, release)=>{
            if (err) { console.error('PG connect error', err); return; }
            client.query('BEGIN').then(()=>{
                return client.query('DELETE FROM whitelist');
            }).then(()=>{
                const promises = whitelist.map(u => client.query('INSERT INTO whitelist("user") VALUES($1)', [u]));
                return Promise.all(promises);
            }).then(()=> client.query('DELETE FROM pendingRequests')).then(()=>{
                const promises = pendingRequests.map(u => client.query('INSERT INTO pendingRequests("user") VALUES($1)', [u]));
                return Promise.all(promises);
            }).then(()=> client.query('DELETE FROM polls')).then(()=>{
                const promises = polls.map(p => client.query('INSERT INTO polls(id,question,yes,no,comments,voters) VALUES($1,$2,$3,$4,$5,$6)', [p.id,p.question,p.yes||0,p.no||0,JSON.stringify(p.comments||[]),JSON.stringify(p.voters||{})]));
                return Promise.all(promises);
            }).then(()=> client.query('COMMIT')).then(()=>{ release(); }).catch(e=>{ console.error('PG persist error', e); client.query('ROLLBACK').finally(()=>release()); });
        });
    }

    initPgAndMigrate();

} else {
    // Initialize SQLite DB and migrate if needed
    initDbAndMigrate();
}

// --- Routen ---
// Alle Abstimmungen abrufen
app.get("/polls", (req, res) => {
    res.json(polls);
});

// Whitelist abrufen
app.get('/whitelist', (req, res) => {
    res.json(whitelist);
});

// Admin-Check Middleware
function checkAdmin(req, res, next) {
    const pass = req.get('x-admin-pass');
    if (!pass || pass !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Admin-Passwort fehlt oder ungültig' });
    }
    next();
}

// Neuen User zur Whitelist hinzufügen (Admin)
app.post('/whitelist', checkAdmin, (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    if (whitelist.includes(user)) return res.status(400).json({ error: 'Benutzer bereits auf der Whitelist' });
    whitelist.push(user);
    saveData();
    res.json({ success: true, whitelist });
});

// Benutzer kann eine Whitelist-Anfrage stellen
app.post('/whitelist/request', (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    if (whitelist.includes(user)) return res.status(400).json({ error: 'Benutzer bereits whitelisted' });
    if (pendingRequests.includes(user)) return res.status(400).json({ error: 'Anfrage bereits vorhanden' });
    pendingRequests.push(user);
    saveData();
    res.json({ success: true });
});

// Admin: ausstehende Anfragen abrufen
app.get('/whitelist/requests', checkAdmin, (req, res) => {
    res.json(pendingRequests);
});

// Admin: Anfrage genehmigen (in Whitelist übernehmen)
app.post('/whitelist/approve', checkAdmin, (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    const idx = pendingRequests.indexOf(user);
    if (idx === -1) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
    if (!whitelist.includes(user)) whitelist.push(user);
    // aus pending entfernen
    pendingRequests.splice(idx, 1);
    saveData();
    res.json({ success: true, whitelist });
});

// Admin: Anfrage ablehnen
app.post('/whitelist/reject', checkAdmin, (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    const idx = pendingRequests.indexOf(user);
    if (idx === -1) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
    pendingRequests.splice(idx, 1);
    saveData();
    res.json({ success: true });
});

// Admin: komplette Whitelist abrufen (geschützt)
app.get('/admin/whitelist', checkAdmin, (req, res) => {
    res.json(whitelist);
});

// Admin: Benutzer von Whitelist entfernen
app.delete('/admin/whitelist', checkAdmin, (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    const idx = whitelist.indexOf(user);
    if (idx === -1) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    whitelist.splice(idx, 1);
    saveData();
    res.json({ success: true, whitelist });
});

// Admin: Poll / Event löschen
app.delete('/admin/polls/:id', checkAdmin, (req, res) => {
    const pollId = parseInt(req.params.id);
    if (isNaN(pollId)) return res.status(400).json({ error: 'Ungültige ID' });
    const idx = polls.findIndex(p => p.id === pollId);
    if (idx === -1) return res.status(404).json({ error: 'Event nicht gefunden' });
    polls.splice(idx, 1);
    saveData();
    res.json({ success: true, polls });
});

// Neue Abstimmung erstellen
app.post("/polls", (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Frage fehlt" });

    const newPoll = {
        id: pollIdCounter++,
        question,
        yes: 0,
        no: 0,
        comments: [],
        voters: {} // speichert user -> "yes" | "no"
    };
    polls.push(newPoll);
    saveData();
    res.json(newPoll);
});

// Abstimmen
app.post("/polls/:id/vote", (req, res) => {
    const pollId = parseInt(req.params.id);
    const { vote, user } = req.body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return res.status(404).json({ error: "Abstimmung nicht gefunden" });

    if (!user) return res.status(400).json({ error: "Benutzername (user) wird benötigt" });
    if (!vote) return res.status(400).json({ error: "Stimme (vote) wird benötigt" });

    if (vote !== "yes" && vote !== "no") return res.status(400).json({ error: "Ungültige Stimme" });

    if (!poll.voters) poll.voters = {};

    const previous = poll.voters[user];

    // Wenn gleiche Stimme wie vorher, nichts ändern
    if (previous === vote) {
        return res.json(poll);
    }

    // Falls der Benutzer vorher eine andere Stimme hatte, zurücksetzen
    if (previous === "yes") {
        poll.yes = Math.max(0, poll.yes - 1);
    } else if (previous === "no") {
        poll.no = Math.max(0, poll.no - 1);
    }

    // Neue Stimme anwenden
    if (vote === "yes") poll.yes++;
    else poll.no++;

    // Speichere/aktualisiere die Stimme des Benutzers
    poll.voters[user] = vote;

    saveData();

    res.json(poll);
});

// Kommentar hinzufügen
app.post("/polls/:id/comment", (req, res) => {
    const pollId = parseInt(req.params.id);
    const { user, text } = req.body;
    const poll = polls.find(p => p.id === pollId);
    if (!poll) return res.status(404).json({ error: "Abstimmung nicht gefunden" });
    if (!user || !text) return res.status(400).json({ error: "Fehlender Benutzername oder Kommentar" });

    poll.comments.push({ user, text });
    saveData();
    res.json(poll);
});

// Server starten
app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});

