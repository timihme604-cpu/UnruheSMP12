const express = require("express");
const path = require("path");
const app = express();

// Statische Dateien (CSS, Bilder, JS)
app.use(express.static(__dirname));

// Route für Startseite
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Route für Hauptseite / Home
app.get("/home", (req, res) => {
  res.sendFile(path.join(__dirname, "home.html"));
});

// Optional: Route für andere Seiten
// app.get("/events", (req, res) => {
//   res.sendFile(path.join(__dirname, "events.html"));
// });

// Port setzen (Render nutzt process.env.PORT)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
});
