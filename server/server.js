// Roll With Your Friends : serveur de synchronisation.
// Compatible avec le serveur d'origine de Roll Together (rt-sync.azurewebsites.net) :
// même protocole socket.io, donc l'extension et Pazulu Reader marchent sans autre changement
// que l'adresse du serveur.
//
// Connexion : query « room » (facultatif, sinon un salon est créé), « videoProgress », « videoState ».
// Serveur -> client : « join » (roomId, état, position, nb) et « update » (id, état, position, nb).
// Client -> serveur : « update » (état, position).
// Les salons ne vivent qu'en mémoire, tant qu'au moins une personne est connectée.

const http = require("http");
const { Server } = require("socket.io");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PLAYING = "playing";
const PAUSED = "paused";
const rooms = new Map(); // roomId -> { state, progress, lastUpdate, users:Set }

const first = (v) => (Array.isArray(v) ? (v.length ? v[0] : null) : v);
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

function genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function progressOf(room) {
  const extra = room.state === PLAYING ? (Date.now() - room.lastUpdate) / 1000 : 0;
  return room.progress + extra;
}

const httpServer = http.createServer((req, res) => {
  // Page de santé (Render la consulte, et elle réveille le serveur).
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Roll With Your Friends sync : ok (${rooms.size} salon(s))\n`);
});

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  allowEIO3: true, // anciens clients
  pingInterval: 20000,
  pingTimeout: 25000,
});

io.on("connection", (socket) => {
  const asked = first(socket.handshake.query.room);
  const roomId = asked && ROOM_RE.test(asked) ? asked : genId();
  const initial = parseFloat(first(socket.handshake.query.videoProgress) || "0") || 0;

  let room = rooms.get(roomId);
  if (!room) {
    room = { state: PAUSED, progress: initial, lastUpdate: Date.now(), users: new Set() };
    rooms.set(roomId, room);
  }
  socket.join(roomId);
  // Comme le serveur d'origine : une arrivée met le salon en pause
  // (l'extension sait relancer la lecture toute seule).
  room.progress = progressOf(room);
  room.lastUpdate = Date.now();
  room.state = PAUSED;
  room.users.add(socket.id);

  const count = room.users.size;
  const progress = progressOf(room);
  socket.emit("join", roomId, room.state, progress, count);
  socket.to(roomId).emit("update", socket.id, room.state, progress, count);
  console.log(`join ${roomId} (${count} pers.)`);

  socket.on("update", (state, videoProgress) => {
    const r = rooms.get(roomId);
    if (!r) return;
    if (state !== PLAYING && state !== PAUSED) return;
    const p = Number(videoProgress);
    if (!Number.isFinite(p) || p < 0) return;
    r.state = state;
    r.progress = p;
    r.lastUpdate = Date.now();
    socket.to(roomId).emit("update", socket.id, r.state, progressOf(r), r.users.size);
  });

  socket.on("disconnect", () => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.users.delete(socket.id);
    if (r.users.size === 0) rooms.delete(roomId);
    console.log(`leave ${roomId} (${r.users.size} pers.)`);
  });
});

httpServer.listen(PORT, () => console.log(`Roll With Your Friends sync sur le port ${PORT}`));
