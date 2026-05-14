import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const players = {};
let hostId = null;

let ctScore = 0;
let tScore = 0;
let bombPlanted = false;
let bombPos = null;

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Send current players to the new player
  socket.emit('current_players', players);
  socket.emit('score_update', { ct: ctScore, t: tScore });
  if (bombPlanted) {
      socket.emit('bomb_planted', bombPos);
  }
  
  if (!hostId) {
    hostId = socket.id;
    socket.emit('set_host', true);
  } else {
    socket.emit('set_host', false);
  }

  socket.on('join_game', (team) => {
    players[socket.id] = {
      id: socket.id,
      team: team, // 0 = CT, 1 = T
      pos: { x: 0, y: 2, z: 0 },
      rot: 0,
      health: 100,
      isDead: false
    };
    socket.broadcast.emit('player_joined', players[socket.id]);
  });

  socket.on('update_transform', (data) => {
    if (players[socket.id]) {
      players[socket.id].pos = data.pos;
      players[socket.id].rot = data.rot;
      socket.broadcast.emit('player_moved', { id: socket.id, pos: data.pos, rot: data.rot });
    }
  });

  socket.on('shoot', (data) => {
    socket.broadcast.emit('player_shoot', { id: socket.id, pos: data.pos, dir: data.dir });
  });

  socket.on('player_hit', (data) => {
    if (players[data.id] && !players[data.id].isDead) {
      players[data.id].health -= data.damage;
      if (players[data.id].health <= 0) {
        players[data.id].isDead = true;
        players[data.id].health = 0;
      }
      io.emit('update_health', { id: data.id, health: players[data.id].health, isDead: players[data.id].isDead });
    }
  });

  let bombTimer = null;

  socket.on('plant_bomb', (pos) => {
      if (!bombPlanted) {
          bombPlanted = true;
          bombPos = pos;
          io.emit('bomb_planted', pos);
          
          bombTimer = setTimeout(() => {
              if (bombPlanted) {
                  bombPlanted = false;
                  bombPos = null;
                  tScore++;
                  io.emit('bomb_exploded');
                  io.emit('score_update', { ct: ctScore, t: tScore });
                  setTimeout(() => { io.emit('new_round'); resetPlayers(); }, 3000);
              }
          }, 40000); // 40 seconds
      }
  });

  socket.on('defuse_bomb', () => {
      if (bombPlanted) {
          bombPlanted = false;
          bombPos = null;
          ctScore++;
          if (bombTimer) clearTimeout(bombTimer);
          io.emit('bomb_defused');
          io.emit('score_update', { ct: ctScore, t: tScore });
          setTimeout(() => { io.emit('new_round'); resetPlayers(); }, 3000);
      }
  });

  socket.on('bomb_exploded', () => {
      // no-op, handled by server timer now
  });

  socket.on('team_win', (winnerTeam) => {
      if (winnerTeam === 0) ctScore++;
      else tScore++;
      io.emit('score_update', { ct: ctScore, t: tScore });
      setTimeout(() => { io.emit('new_round'); resetPlayers(); }, 3000);
  });

  socket.on('bot_sync', (botsData) => {
    if (socket.id === hostId) {
      socket.broadcast.emit('bot_sync', botsData);
    }
  });
  
  socket.on('bot_shot', (data) => {
    if (hostId && socket.id !== hostId) {
      io.to(hostId).emit('bot_shot', data);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete players[socket.id];
    io.emit('player_left', socket.id);
    
    if (socket.id === hostId) {
      const remainingIds = Object.keys(players);
      if (remainingIds.length > 0) {
        hostId = remainingIds[0];
        io.to(hostId).emit('set_host', true);
      } else {
        hostId = null;
        // reset game if everyone leaves
        ctScore = 0;
        tScore = 0;
        bombPlanted = false;
        bombPos = null;
      }
    }
  });

  function resetPlayers() {
      for (let id in players) {
          players[id].health = 100;
          players[id].isDead = false;
      }
  }
});

const PORT = 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket.IO Server running on port ${PORT}`);
});
