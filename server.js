// server.js
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const PORT = process.env.PORT || 3000;

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

// --- Routen ---
// Alle Abstimmungen abrufen
app.get("/polls", (req, res) => {
    res.json(polls);
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

