// server.js
const express = require("express");
const bodyParser = require("body-parser");
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
app.use(express.static(__dirname)); // Macht alle HTML/CSS/JS Dateien verfügbar

// --- Datenstruktur für Abstimmungen ---
let polls = [];
let pollIdCounter = 1;
// Einfache Whitelist (in-memory)
let whitelist = [
    "_xzl",
    "EnderPro",
    "PixelFreak",
    "UnruheSMP12"
];
// Ausstehende Whitelist-Anfragen (nur sichtbar für Admin über UI)
let pendingRequests = [];

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
    res.json({ success: true, whitelist });
});

// Benutzer kann eine Whitelist-Anfrage stellen
app.post('/whitelist/request', (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    if (whitelist.includes(user)) return res.status(400).json({ error: 'Benutzer bereits whitelisted' });
    if (pendingRequests.includes(user)) return res.status(400).json({ error: 'Anfrage bereits vorhanden' });
    pendingRequests.push(user);
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
    res.json({ success: true, whitelist });
});

// Admin: Anfrage ablehnen
app.post('/whitelist/reject', checkAdmin, (req, res) => {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
    const idx = pendingRequests.indexOf(user);
    if (idx === -1) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
    pendingRequests.splice(idx, 1);
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
    res.json({ success: true, whitelist });
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
    res.json(poll);
});

// Server starten
app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});

