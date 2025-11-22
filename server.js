// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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

function saveData() {
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

