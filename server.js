const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, room) => n + room.players.size, 0) }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Ebediyet Multiplayer Sunucusu çalışıyor.');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function makeRoom(code) {
  return {
    code,
    players: new Map(),
    nextId: 1,
    nextObjectId: 1,
    eventSequence: 1,
    events: [],
    world: { resources: [], buildings: [], soldiers: [], enemies: [] },
    createdAt: Date.now()
  };
}

function roomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  } while (rooms.has(code));
  return code;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room, message, exceptSocket = null) {
  for (const player of room.players.values()) {
    if (player.socket !== exceptSocket && player.socket.readyState === WebSocket.OPEN) {
      send(player.socket, message);
    }
  }
}

function log(room, text) {
  room.events.push({ id: room.eventSequence++, text, time: Date.now() });
  if (room.events.length > 80) room.events.shift();
}

function spawnResources(room) {
  const types = [
    { type: 'wood', count: 16 },
    { type: 'stone', count: 10 },
    { type: 'coal', count: 5 },
    { type: 'iron', count: 5 },
    { type: 'gold', count: 3 }
  ];
  types.forEach(({ type, count }) => {
    for (let i = 0; i < count; i++) {
      room.world.resources.push({
        id: room.nextObjectId++,
        type,
        x: (Math.random() - 0.5) * 150,
        z: (Math.random() - 0.5) * 150,
        amount: type === 'wood' ? 220 : 160,
        gatherDuration: type === 'wood' ? 4200 : 5600,
        radius: 4
      });
    }
  });
}

function playerState(player) {
  return {
    id: player.id,
    name: player.name,
    faction: player.faction,
    cls: player.cls,
    online: player.socket.readyState === WebSocket.OPEN,
    x: player.x,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    hp: player.hp,
    maxhp: player.maxhp,
    gold: player.gold,
    dip: player.dip,
    inv: player.inv,
    gather: player.gather,
    lastSeen: Date.now()
  };
}

function stateFor(room, player) {
  return {
    type: 'state',
    code: room.code,
    time: Date.now(),
    you: playerState(player),
    players: [...room.players.values()].map(playerState),
    resources: room.world.resources,
    buildings: room.world.buildings,
    soldiers: room.world.soldiers,
    enemies: room.world.enemies,
    events: room.events.slice(-25)
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function nearestResource(room, player) {
  return room.world.resources
    .filter(item => item.amount > 0 && distance(item, player) < item.radius + 3)
    .sort((a, b) => distance(a, player) - distance(b, player))[0];
}

function nearestOwnBuilding(room, player) {
  return room.world.buildings
    .filter(building => building.owner === player.id && distance(building, player) < building.radius + 4)
    .sort((a, b) => distance(a, player) - distance(b, player))[0];
}

function addSoldier(room, player, type = 'soldier') {
  const stats = {
    soldier: { hp: 150, damage: 22, speed: 5.5, range: 2.4 },
    archer: { hp: 100, damage: 16, speed: 5.2, range: 14 },
    rider: { hp: 190, damage: 25, speed: 8.5, range: 2.8 },
    butcher: { hp: 170, damage: 27, speed: 5.0, range: 2.2 }
  }[type];
  room.world.soldiers.push({
    id: room.nextObjectId++,
    owner: player.id,
    type,
    x: player.x + (Math.random() - 0.5) * 5,
    z: player.z + (Math.random() - 0.5) * 5,
    yaw: player.yaw,
    hp: stats.hp,
    maxhp: stats.hp,
    damage: stats.damage,
    speed: stats.speed,
    range: stats.range,
    order: 'hold',
    target: null
  });
}

function createBuilding(room, player, type) {
  const costs = {
    house: { wood: 10, stone: 4, iron: 0 },
    castle: { wood: 25, stone: 40, iron: 10 },
    garden: { wood: 12, stone: 2, iron: 0 },
    farm: { wood: 18, stone: 6, iron: 0 },
    shop: { wood: 20, stone: 10, iron: 5 }
  };
  const cost = costs[type];
  if (!cost) return 'Bilinmeyen bina.';
  for (const key in cost) {
    if ((player.inv[key] || 0) < cost[key]) return 'Yeterli kaynak yok.';
  }
  for (const key in cost) player.inv[key] -= cost[key];
  const radius = type === 'castle' ? 14 : 7;
  const building = {
    id: room.nextObjectId++,
    owner: player.id,
    type,
    x: player.x + Math.cos(player.yaw) * 8,
    z: player.z + Math.sin(player.yaw) * 8,
    radius,
    hp: type === 'castle' ? 900 : 350,
    maxhp: type === 'castle' ? 900 : 350,
    createdAt: Date.now()
  };
  room.world.buildings.push(building);
  log(room, `${player.name}, ${type} inşa etti.`);
  return null;
}

function tick(room) {
  const now = Date.now();
  for (const player of room.players.values()) {
    if (player.gather && now - player.gather.start >= player.gather.duration) {
      const resource = room.world.resources.find(item => item.id === player.gather.resourceId);
      if (resource && resource.amount > 0) {
        const taken = Math.min(resource.amount, 18);
        resource.amount -= taken;
        const key = resource.type === 'wood' ? 'wood' : resource.type === 'stone' ? 'stone' : resource.type === 'coal' ? 'coal' : resource.type === 'iron' ? 'iron' : 'gold';
        player.inv[key] = (player.inv[key] || 0) + taken;
        log(room, `${player.name} ${taken} ${key} topladı.`);
      }
      player.gather = null;
    }
  }
  for (const soldier of room.world.soldiers) {
    const enemy = room.world.enemies.find(item => item.hp > 0 && distance(item, soldier) < soldier.range + 1);
    if (enemy) {
      enemy.hp -= soldier.damage / 30;
      soldier.yaw = Math.atan2(enemy.x - soldier.x, enemy.z - soldier.z);
    } else if (soldier.order === 'retreat') {
      const owner = room.players.get(soldier.owner);
      if (owner) {
        const dx = owner.x - soldier.x, dz = owner.z - soldier.z;
        const length = Math.hypot(dx, dz) || 1;
        soldier.x += dx / length * soldier.speed / 30;
        soldier.z += dz / length * soldier.speed / 30;
        soldier.yaw = Math.atan2(dx, dz);
      }
    }
  }
  room.world.enemies = room.world.enemies.filter(enemy => enemy.hp > 0);
  if (room.world.enemies.length < 3 && Math.random() < 0.02) {
    const player = [...room.players.values()][0];
    if (player) {
      room.world.enemies.push({
        id: room.nextObjectId++,
        type: 'bandit',
        x: player.x + (Math.random() - 0.5) * 100,
        z: player.z + (Math.random() - 0.5) * 100,
        yaw: 0,
        hp: 90,
        maxhp: 90,
        damage: 14,
        speed: 4.5,
        range: 2.2
      });
    }
  }
}

wss.on('connection', socket => {
  let room = null;
  let player = null;

  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.type === 'create' || message.type === 'join') {
      if (room) return;
      const code = message.type === 'create' ? roomCode() : String(message.code || '').toUpperCase();
      if (message.type === 'join' && !rooms.has(code)) {
        send(socket, { type: 'error', message: 'Bu kodda açık oda yok.' });
        return;
      }
      room = message.type === 'create' ? makeRoom(code) : rooms.get(code);
      if (message.type === 'create') rooms.set(code, room);
      if (room.players.size >= 4) {
        send(socket, { type: 'error', message: 'Oda dolu. En fazla 4 oyuncu.' });
        return;
      }
      const id = 'p' + room.nextId++;
      player = {
        id,
        socket,
        name: String(message.name || 'Oyuncu').slice(0, 24),
        faction: ['human', 'angel', 'demon', 'fallen'].includes(message.faction) ? message.faction : 'human',
        cls: ['smith', 'soldier', 'archer', 'rider', 'butcher'].includes(message.cls) ? message.cls : 'smith',
        x: (Math.random() - 0.5) * 20,
        z: (Math.random() - 0.5) * 20,
        yaw: 0,
        pitch: 0,
        hp: 240,
        maxhp: 240,
        gold: 180,
        dip: 0,
        inv: { wood: 30, stone: 20, iron: 8, coal: 6, gold: 0 },
        gather: null
      };
      room.players.set(id, player);
      if (room.world.resources.length === 0) spawnResources(room);
      send(socket, { type: 'welcome', id, code: room.code, token: id });
      log(room, `${player.name} odaya katıldı.`);
      broadcast(room, { type: 'state', ...stateFor(room, player) });
      return;
    }

    if (!room || !player) return;

    if (message.type === 'input') {
      const speed = message.run ? 9 : 5.5;
      const length = Math.hypot(message.x || 0, message.z || 0);
      if (length > 0.05) {
        player.x += (message.x / length) * speed / 30;
        player.z += (message.z / length) * speed / 30;
      }
      player.x = Math.max(-180, Math.min(180, player.x));
      player.z = Math.max(-180, Math.min(180, player.z));
      player.yaw = message.yaw || 0;
      player.pitch = message.pitch || 0;
      return;
    }

    if (message.type === 'action') {
      const action = message.action || {};
      if (action.type === 'attack') {
        const enemy = room.world.enemies.find(item => distance(item, player) < 4);
        if (enemy) {
          enemy.hp -= 28;
          log(room, `${player.name} düşmana saldırdı.`);
        }
      } else if (action.type === 'bow') {
        const enemy = room.world.enemies.find(item => distance(item, player) < 18);
        if (enemy) {
          enemy.hp -= 18;
          log(room, `${player.name} ok attı.`);
        }
      } else if (action.type === 'interact') {
        const resource = nearestResource(room, player);
        if (resource) {
          player.gather = { resourceId: resource.id, start: Date.now(), duration: resource.gatherDuration };
        } else {
          const building = nearestOwnBuilding(room, player);
          if (building && building.type === 'house') {
            player.hp = player.maxhp;
            log(room, `${player.name} evinde dinlendi.`);
          }
        }
      } else if (action.type === 'build') {
        const error = createBuilding(room, player, action.building);
        if (error) send(socket, { type: 'error', message: error });
      } else if (action.type === 'recruit') {
        const castle = room.world.buildings.find(item => item.owner === player.id && item.type === 'castle' && distance(item, player) < item.radius + 4);
        if (!castle) {
          send(socket, { type: 'error', message: 'Kalenin yanında olmalısın.' });
        } else if (player.gold < 120) {
          send(socket, { type: 'error', message: '120 altın gerekli.' });
        } else {
          player.gold -= 120;
          addSoldier(room, player, player.cls === 'archer' ? 'archer' : player.cls === 'rider' ? 'rider' : 'soldier');
          log(room, `${player.name} asker aldı.`);
        }
      } else if (action.type === 'buildingAction') {
        const building = room.world.buildings.find(item => item.id === action.building && item.owner === player.id);
        if (!building) return;
        if (building.type === 'garden' || building.type === 'farm') {
          player.inv.wood += 6;
          player.inv.stone += 2;
          log(room, `${player.name} ${building.type} hasadı yaptı.`);
        } else if (building.type === 'shop') {
          const wood = Math.min(player.inv.wood, 20);
          const stone = Math.min(player.inv.stone, 10);
          player.inv.wood -= wood;
          player.inv.stone -= stone;
          player.gold += wood * 2 + stone * 3;
          log(room, `${player.name} kaynak sattı.`);
        }
      } else if (action.type === 'order') {
        const order = ['attack', 'retreat', 'hold'].includes(action.order) ? action.order : 'hold';
        room.world.soldiers.filter(item => item.owner === player.id).forEach(item => item.order = order);
        log(room, `${player.name} ordusuna "${order}" emri verdi.`);
      }
      broadcast(room, { type: 'state', ...stateFor(room, player) });
    }
  });

  socket.on('close', () => {
    if (!room || !player) return;
    player.socket = socket;
    log(room, `${player.name} ayrıldı.`);
    broadcast(room, { type: 'state', ...stateFor(room, player) });
    room.players.delete(player.id);
    if (room.players.size === 0) rooms.delete(room.code);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    tick(room);
    for (const player of room.players.values()) {
      if (player.socket.readyState === WebSocket.OPEN) send(player.socket, { type: 'state', ...stateFor(room, player) });
    }
  }
}, 33);

server.listen(port, () => console.log(`Ebediyet sunucusu ${port} portunda çalışıyor.`));
