// Clean single-file server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

app.use(bodyParser.json());
app.use(cors());
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');

let state = {
  polls: [],
  pollIdCounter: 1,
  whitelist: ['_xzl','EnderPro','PixelFreak','UnruheSMP12'],
  pendingRequests: []
};

async function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      state = Object.assign(state, parsed);
      if (typeof state.pollIdCounter !== 'number') {
        state.pollIdCounter = (state.polls && state.polls.length) ? state.polls.length + 1 : 1;
      }
    }
  } catch (err) {
    console.error('loadData error:', err);
  }
}

async function saveData() {
  try {
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (err) {
    console.error('saveData error:', err);
  }
}

function checkAdmin(req, res, next) {
  const pass = req.get('x-admin-pass');
  if (!pass || pass !== ADMIN_PASS) return res.status(401).json({ error: 'Admin-Passwort fehlt oder ungültig' });
  next();
}

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// Whitelist endpoints
app.get('/whitelist', (req, res) => res.json(state.whitelist));

app.post('/whitelist/request', async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
  if (state.whitelist.includes(user)) return res.status(400).json({ error: 'Benutzer bereits whitelisted' });
  if (state.pendingRequests.includes(user)) return res.status(400).json({ error: 'Anfrage bereits vorhanden' });
  state.pendingRequests.push(user);
  await saveData();
  res.json({ success: true });
});

app.get('/whitelist/requests', checkAdmin, (req, res) => res.json(state.pendingRequests));

app.post('/whitelist/approve', checkAdmin, async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
  const idx = state.pendingRequests.indexOf(user);
  if (idx === -1) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
  if (!state.whitelist.includes(user)) state.whitelist.push(user);
  state.pendingRequests.splice(idx, 1);
  await saveData();
  res.json({ success: true, whitelist: state.whitelist });
});

app.post('/whitelist/reject', checkAdmin, async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
  const idx = state.pendingRequests.indexOf(user);
  if (idx === -1) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
  state.pendingRequests.splice(idx, 1);
  await saveData();
  res.json({ success: true });
});

app.post('/whitelist', checkAdmin, async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
  if (state.whitelist.includes(user)) return res.status(400).json({ error: 'Benutzer bereits auf der Whitelist' });
  state.whitelist.push(user);
  await saveData();
  res.json({ success: true, whitelist: state.whitelist });
});

app.delete('/admin/whitelist', checkAdmin, async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Benutzername fehlt' });
  const idx = state.whitelist.indexOf(user);
  if (idx === -1) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  state.whitelist.splice(idx, 1);
  await saveData();
  res.json({ success: true, whitelist: state.whitelist });
});

// Poll endpoints
app.get('/polls', (req, res) => res.json(state.polls));

app.post('/polls', async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Frage fehlt' });
  const p = { id: state.pollIdCounter++, question, yes: 0, no: 0, comments: [], voters: {} };
  state.polls.push(p);
  await saveData();
  res.json(p);
});

app.post('/polls/:id/vote', async (req, res) => {
  const pollId = parseInt(req.params.id, 10);
  const { user, vote } = req.body || {};
  const poll = state.polls.find(x => x.id === pollId);
  if (!poll) return res.status(404).json({ error: 'Abstimmung nicht gefunden' });
  if (!user || !vote) return res.status(400).json({ error: 'Benutzername und Stimme werden benötigt' });
  if (vote !== 'yes' && vote !== 'no') return res.status(400).json({ error: 'Ungültige Stimme' });
  const prev = poll.voters[user];
  if (prev === vote) return res.json(poll);
  if (prev === 'yes') poll.yes = Math.max(0, poll.yes - 1);
  if (prev === 'no') poll.no = Math.max(0, poll.no - 1);
  if (vote === 'yes') poll.yes++;
  else poll.no++;
  poll.voters[user] = vote;
  await saveData();
  res.json(poll);
});

app.post('/polls/:id/comment', async (req, res) => {
  const pollId = parseInt(req.params.id, 10);
  const { user, text } = req.body || {};
  const poll = state.polls.find(x => x.id === pollId);
  if (!poll) return res.status(404).json({ error: 'Abstimmung nicht gefunden' });
  if (!user || !text) return res.status(400).json({ error: 'Benutzername und Text werden benötigt' });
  poll.comments.push({ user, text });
  await saveData();
  res.json(poll);
});

app.delete('/admin/polls/:id', checkAdmin, async (req, res) => {
  const pollId = parseInt(req.params.id, 10);
  const idx = state.polls.findIndex(x => x.id === pollId);
  if (idx === -1) return res.status(404).json({ error: 'Event nicht gefunden' });
  state.polls.splice(idx, 1);
  await saveData();
  res.json({ success: true, polls: state.polls });
});

// Only start listening when run directly (helps tests and syntax checks)
if (require.main === module) {
  loadData().then(() => {
    app.listen(PORT, () => console.log('Server läuft auf http://localhost:' + PORT));
  }).catch(err => {
    console.error('Start error:', err);
    app.listen(PORT, () => console.log('Server läuft auf http://localhost:' + PORT));
  });
} else {
  module.exports = app;
}
