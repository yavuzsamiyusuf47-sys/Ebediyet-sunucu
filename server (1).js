// Ebediyet multiplayer sunucusu — kale seçimi, NPC ticareti ve diplomasi destekli
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_MS = 33;
const BOUND = 98;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Ebediyet sunucusu calisiyor');
});

const wss = new WebSocketServer({ server });

const rooms = new Map();
const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const BIGCASTLES = [
  { name: 'Kuzey Kalesi', x: -60, z: -60 },
  { name: 'Doğu Kalesi', x: 60, z: -60 },
  { name: 'Güney Kalesi', x: 60, z: 60 },
  { name: 'Batı Kalesi', x: -60, z: 60 },
];
const NPCS = [
  { id: 'merchant', name: 'Tüccar Aldric', x: 12, z: 10 },
  { id: 'blacksmith', name: 'Demirci Borin', x: -12, z: 10 },
  { id: 'envoy', name: 'Elçi Mira', x: 10, z: -12 },
];
const CLASSES = {
  smith: { hp: 240, melee: 45, bow: 25, walk: 3.2, run: 6 },
  soldier: { hp: 280, melee: 55, bow: 20, walk: 3, run: 5.6 },
  archer: { hp: 220, melee: 35, bow: 40, walk: 3.2, run: 6.2 },
  rider: { hp: 240, melee: 40, bow: 20, walk: 4.2, run: 7.6 },
  butcher: { hp: 250, melee: 50, bow: 18, walk: 3.2, run: 6 },
};
const BUILD_DEFS = {
  house: { cost: { wood: 10, stone: 4 }, radius: 5 },
  castle: { cost: { wood: 25, stone: 40, iron: 10 }, radius: 9 },
  garden: { cost: { wood: 12, stone: 2 }, radius: 4 },
  farm: { cost: { wood: 18, stone: 6 }, radius: 5 },
  shop: { cost: { wood: 20, stone: 10, iron: 5 }, radius: 5 },
};
const RES_DEFS = {
  wood: { count: 14, amount: 220, duration: 4200 },
  stone: { count: 10, amount: 160, duration: 5600 },
  iron: { count: 6, amount: 120, duration: 7000 },
  coal: { count: 4, amount: 100, duration: 7000 },
  gold: { count: 3, amount: 80, duration: 8000 },
};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? makeCode() : c;
}

function addEvent(room, text) {
  room.events.push({ id: room.nextEvent++, text, time: Date.now() });
  if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
}

function spawnEnemy(room) {
  let x = 0, z = 0, tries = 0;
  while (tries++ < 40) {
    x = rnd(-80, 80); z = rnd(-80, 80);
    if (Math.hypot(x, z) > 25 && BIGCASTLES.every(c => dist(x, z, c.x, c.z) > 20)) break;
  }
  room.enemies.push({ id: 'e' + room.nextEnemy++, type: 'bandit', x, z, yaw: 0, hp: 90, maxhp: 90, damage: 14, speed: 4.5, range: 2.2, atkAt: 0 });
}

function makeRoom() {
  const room = {
    code: makeCode(), players: new Map(), resources: [], buildings: [], soldiers: [], enemies: [],
    events: [], nextRes: 1, nextBld: 1, nextSol: 1, nextEnemy: 1, nextEvent: 1, nextPlayer: 0,
    timer: null, lastActivity: Date.now(), respawn: [],
  };
  for (const [type, def] of Object.entries(RES_DEFS)) {
    for (let i = 0; i < def.count; i++) {
      let x = 0, z = 0, tries = 0;
      while (tries++ < 40) {
        x = rnd(-90, 90); z = rnd(-90, 90);
        if (Math.hypot(x, z) > 18
          && BIGCASTLES.every(c => dist(x, z, c.x, c.z) > 24)
          && NPCS.every(n => dist(x, z, n.x, n.z) > 8)
          && room.resources.every(r => dist(x, z, r.x, r.z) > 7)) break;
      }
      room.resources.push({ id: room.nextRes++, type, x, z, amount: def.amount, gatherDuration: def.duration, radius: 4 });
    }
  }
  BIGCASTLES.forEach((c, i) => {
    room.buildings.push({ id: 'bc' + i, type: 'bigcastle', name: c.name, x: c.x, z: c.z, radius: 12, owner: null });
  });
  for (let i = 0; i < 5; i++) spawnEnemy(room);
  room.timer = setInterval(() => tick(room), TICK_MS);
  rooms.set(room.code, room);
  return room;
}

function makePlayer(room, name, faction, cls) {
  const id = 'p' + (++room.nextPlayer);
  const c = CLASSES[cls] || CLASSES.smith;
  const p = {
    id, token: crypto.randomBytes(8).toString('hex'), name: (name || 'Oyuncu').slice(0, 24),
    faction: faction || 'human', cls: cls || 'smith',
    x: rnd(-8, 8), z: rnd(-8, 8), yaw: 0, pitch: 0,
    hp: c.hp, maxhp: c.hp, gold: 180, dip: 0,
    inv: { wood: 30, stone: 20, iron: 8, coal: 6, gold: 0 },
    gather: null, online: true, lastSeen: Date.now(), choosing: true, envoyAt: 0,
    dirX: 0, dirZ: 0, run: false, melee: c.melee, bowDmg: c.bow, walk: c.walk, runSpd: c.run, ws: null,
  };
  room.players.set(p.token, p);
  return p;
}

function playerPublic(p) {
  return {
    id: p.id, name: p.name, faction: p.faction, cls: p.cls, online: p.online,
    x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, maxhp: p.maxhp,
    gold: p.gold, dip: p.dip, inv: p.inv, gather: p.gather, lastSeen: p.lastSeen, choosing: p.choosing,
  };
}

function stateFor(room, p) {
  return {
    type: 'state', code: room.code, time: Date.now(), you: playerPublic(p),
    players: [...room.players.values()].map(playerPublic),
    soldiers: room.soldiers, enemies: room.enemies, buildings: room.buildings,
    resources: room.resources.map(r => ({ id: r.id, type: r.type, x: r.x, z: r.z })),
    events: room.events,
    castles: room.buildings.filter(b => b.type === 'bigcastle').map(b => ({ id: b.id, name: b.name, x: b.x, z: b.z, owner: b.owner })),
    npcs: NPCS.map(n => ({ id: n.id, x: n.x, z: n.z })),
  };
}

function err(ws, msg) { try { ws.send(JSON.stringify({ type: 'error', message: msg })); } catch (e) {} }
function errP(p, msg) { if (p && p.ws) err(p.ws, msg); }

function canAfford(inv, cost) { return Object.entries(cost).every(([k, v]) => (inv[k] || 0) >= v); }
function pay(inv, cost) { Object.entries(cost).forEach(([k, v]) => inv[k] -= v); }

function nearestEnemy(room, x, z, maxD) {
  let best = null, bd = maxD;
  room.enemies.forEach(e => { if (e.hp > 0) { const d = dist(x, z, e.x, e.z); if (d < bd) { bd = d; best = e; } } });
  return best;
}

function handleAction(room, p, a) {
  if (!p.online || p.choosing) return;
  p.lastSeen = Date.now();
  if (a.type === 'interact') {
    if (p.gather) return;
    let best = null, bd = 1e9;
    room.resources.forEach(r => { const d = dist(p.x, p.z, r.x, r.z); if (d < r.radius + 3.5 && d < bd) { bd = d; best = r; } });
    if (best) p.gather = { resourceId: best.id, start: Date.now(), duration: best.gatherDuration };
    return;
  }
  if (a.type === 'build') {
    const def = BUILD_DEFS[a.building];
    if (!def) return;
    if (!canAfford(p.inv, def.cost)) { errP(p, 'Yetersiz kaynak.'); return; }
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    pay(p.inv, def.cost);
    room.buildings.push({ id: 'b' + room.nextBld++, type: a.building, x: clamp(p.x + fx * 4, -BOUND, BOUND), z: clamp(p.z + fz * 4, -BOUND, BOUND), radius: def.radius, owner: p.id });
    addEvent(room, p.name + ', ' + a.building + ' inşa etti.');
    return;
  }
  if (a.type === 'attack') {
    const e = nearestEnemy(room, p.x, p.z, 2.8);
    if (e) { e.hp -= p.melee; addEvent(room, p.name + ' düşmana saldırdı.'); }
    return;
  }
  if (a.type === 'bow') {
    addEvent(room, p.name + ' ok attı.');
    const e = nearestEnemy(room, p.x, p.z, 26);
    if (e) e.hp -= p.bowDmg;
    return;
  }
  if (a.type === 'recruit') {
    const b = room.buildings.find(x => x.id === a.building && x.owner === p.id);
    if (!b) { errP(p, 'Binan bulunamadı.'); return; }
    if (dist(p.x, p.z, b.x, b.z) > b.radius + 3) { errP(p, 'Kalenin yanında olmalısın.'); return; }
    if (p.gold < 120) { errP(p, '120 altın gerekli.'); return; }
    p.gold -= 120;
    room.soldiers.push({ id: 's' + room.nextSol++, owner: p.id, x: b.x + rnd(-4, 4), z: b.z + rnd(-4, 4), yaw: 0, hp: 150, maxhp: 150, damage: 22, speed: 5.5, range: 2.4, order: 'hold', atkAt: 0 });
    addEvent(room, p.name + ' asker aldı.');
    return;
  }
  if (a.type === 'order') {
    room.soldiers.forEach(s => { if (s.owner === p.id) s.order = a.order; });
    addEvent(room, p.name + ' ordusuna "' + a.order + '" emri verdi.');
    return;
  }
  if (a.type === 'buildingAction') {
    const b = room.buildings.find(x => x.id === a.building && x.owner === p.id);
    if (!b || dist(p.x, p.z, b.x, b.z) > b.radius + 3) return;
    if (b.type === 'house') { p.hp = Math.min(p.maxhp, p.hp + 60); addEvent(room, p.name + ' evinde dinlendi.'); }
    else if (b.type === 'farm') { p.inv.wood += 8; p.inv.stone += 4; addEvent(room, p.name + ' çiftlikten hasat etti.'); }
    else if (b.type === 'garden') { p.inv.wood += 5; addEvent(room, p.name + ' bahçeden hasat etti.'); }
    else if (b.type === 'shop') {
      if (p.inv.stone >= 10) { p.inv.stone -= 10; p.gold += 30; addEvent(room, p.name + ' dükkanda 10 taş sattı (+30 altın).'); }
      else errP(p, 'Dükkanda satmak için 10 taş gerekli.');
    }
    return;
  }
  if (a.type === 'npc') {
    const n = NPCS.find(x => x.id === a.npc);
    if (!n) return;
    if (dist(p.x, p.z, n.x, n.z) > 5.5) { errP(p, 'Yaklaşman gerek.'); return; }
    if (n.id === 'merchant') {
      if (p.gold >= 40) { p.gold -= 40; p.inv.iron += 10; addEvent(room, p.name + ' tüccardan 10 demir aldı.'); }
      else errP(p, '40 altın gerekli.');
    } else if (n.id === 'blacksmith') {
      if (p.inv.wood >= 10) { p.inv.wood -= 10; p.gold += 30; addEvent(room, p.name + ' demirciye 10 odun sattı (+30 altın).'); }
      else errP(p, '10 odun gerekli.');
    } else if (n.id === 'envoy') {
      const now = Date.now();
      if (now - p.envoyAt > 60000) { p.envoyAt = now; p.dip += 5; addEvent(room, p.name + ' elçiyle görüştü (+5 diplomasi).'); }
      else errP(p, 'Elçi şu anda meşgul, biraz bekle.');
    }
    return;
  }
}

function tick(room) {
  const now = Date.now();
  const players = [...room.players.values()];
  const online = players.filter(p => p.online && p.ws);

  players.forEach(p => {
    if (!p.online || p.choosing || p.hp <= 0) { p.dirX = p.dirZ = 0; }
    if (p.dirX || p.dirZ) {
      const spd = (p.run ? p.runSpd : p.walk) * TICK_MS / 1000;
      p.x = clamp(p.x + p.dirX * spd, -BOUND, BOUND);
      p.z = clamp(p.z + p.dirZ * spd, -BOUND, BOUND);
      room.buildings.forEach(b => {
        const d = dist(p.x, p.z, b.x, b.z), min = b.radius + .7;
        if (d < min && d > 0.001) { p.x = b.x + (p.x - b.x) / d * min; p.z = b.z + (p.z - b.z) / d * min; }
      });
      room.resources.forEach(r => {
        const d = dist(p.x, p.z, r.x, r.z), min = r.radius + .7;
        if (d < min && d > 0.001) { p.x = r.x + (p.x - r.x) / d * min; p.z = r.z + (p.z - r.z) / d * min; }
      });
      if (p.gather) {
        const r = room.resources.find(x => x.id === p.gather.resourceId);
        if (!r || dist(p.x, p.z, r.x, r.z) > r.radius + 7) p.gather = null;
      }
    }
    if (p.gather && now >= p.gather.start + p.gather.duration) {
      const r = room.resources.find(x => x.id === p.gather.resourceId);
      if (r && r.amount > 0) {
        const got = Math.min(18, r.amount);
        r.amount -= got;
        p.inv[r.type] = (p.inv[r.type] || 0) + got;
        addEvent(room, p.name + ' ' + got + ' ' + r.type + ' topladı.');
      }
      p.gather = null;
      if (r && r.amount <= 0) room.resources = room.resources.filter(x => x !== r);
    }
  });

  room.enemies.forEach(e => {
    if (e.hp <= 0) return;
    let t = null, bd = 52;
    players.forEach(p => {
      if (p.online && !p.choosing && p.hp > 0) { const d = dist(e.x, e.z, p.x, p.z); if (d < bd) { bd = d; t = p; } }
    });
    if (t) {
      if (bd > e.range) {
        const d = Math.max(bd, .001);
        e.x += (t.x - e.x) / d * e.speed * TICK_MS / 1000;
        e.z += (t.z - e.z) / d * e.speed * TICK_MS / 1000;
        e.yaw = Math.atan2(t.x - e.x, t.z - e.z);
      } else if (now >= e.atkAt) {
        e.atkAt = now + 1200;
        t.hp = Math.max(0, t.hp - e.damage);
        addEvent(room, 'Haydut ' + t.name + "'a saldırdı.");
        if (t.hp <= 0) addEvent(room, t.name + ' öldü.');
      }
    }
  });
  const deadEnemies = room.enemies.filter(e => e.hp <= 0);
  if (deadEnemies.length) {
    room.enemies = room.enemies.filter(e => e.hp > 0);
    deadEnemies.forEach(() => room.respawn.push(now + 45000));
  }
  while (room.respawn.length && room.respawn[0] <= now) { room.respawn.shift(); spawnEnemy(room); }

  room.soldiers.forEach(s => {
    if (s.hp <= 0) return;
    const owner = players.find(p => p.id === s.owner);
    if (s.order === 'attack') {
      let t = null, bd = 60;
      room.enemies.forEach(e => { const d = dist(s.x, s.z, e.x, e.z); if (d < bd) { bd = d; t = e; } });
      if (t) {
        if (bd > s.range) {
          const d = Math.max(bd, .001);
          s.x += (t.x - s.x) / d * s.speed * TICK_MS / 1000;
          s.z += (t.z - s.z) / d * s.speed * TICK_MS / 1000;
          s.yaw = Math.atan2(t.x - s.x, t.z - s.z);
        } else if (now >= s.atkAt) { s.atkAt = now + 1000; t.hp -= s.damage; }
      } else if (owner) {
        const d = dist(s.x, s.z, owner.x, owner.z);
        if (d > 4) { s.x += (owner.x - s.x) / d * s.speed * TICK_MS / 1000; s.z += (owner.z - s.z) / d * s.speed * TICK_MS / 1000; }
      }
    } else if (s.order === 'retreat') {
      const home = room.buildings.find(b => b.owner === s.owner && (b.type === 'castle' || b.type === 'bigcastle')) || owner;
      if (home) {
        const d = dist(s.x, s.z, home.x, home.z);
        if (d > 10) { s.x += (home.x - s.x) / d * s.speed * TICK_MS / 1000; s.z += (home.z - s.z) / d * s.speed * TICK_MS / 1000; }
      }
    }
  });
  room.soldiers = room.soldiers.filter(s => s.hp > 0);

  online.forEach(p => {
    if (p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(stateFor(room, p))); } catch (e) {} }
  });

  if (!online.length && now - room.lastActivity > 300000) {
    clearInterval(room.timer);
    rooms.delete(room.code);
  }
}

wss.on('connection', ws => {
  let room = null, player = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (room) room.lastActivity = Date.now();

    if (m.type === 'create') {
      if (room) return;
      room = makeRoom();
      player = makePlayer(room, m.name, m.faction, m.cls);
      attach();
      addEvent(room, player.name + ' odayı kurdu.');
    } else if (m.type === 'join') {
      if (room) return;
      room = rooms.get((m.code || '').toUpperCase());
      if (!room) { err(ws, 'Oda bulunamadı. Kodu kontrol et.'); return; }
      if (m.token && room.players.has(m.token)) {
        player = room.players.get(m.token);
        if (player.ws && player.ws !== ws) { try { player.ws.close(); } catch (e) {} }
        player.online = true;
      } else {
        if ([...room.players.values()].filter(p => p.online).length >= 4) { err(ws, 'Oda dolu (4 kişi).'); room = null; return; }
        player = makePlayer(room, m.name, m.faction, m.cls);
        addEvent(room, player.name + ' odaya katıldı.');
      }
      attach();
    } else if (m.type === 'chooseCastle') {
      if (!room || !player || !player.choosing) return;
      const c = room.buildings.find(b => b.id === m.castleId && b.type === 'bigcastle');
      if (!c) { errP(player, 'Kale bulunamadı.'); return; }
      if (c.owner && c.owner !== player.id) { errP(player, c.name + ' zaten alınmış. Başka bir kale seç.'); return; }
      c.owner = player.id;
      player.x = c.x + rnd(6, 9);
      player.z = c.z + rnd(6, 9);
      player.choosing = false;
      addEvent(room, player.name + ', ' + c.name + "'ni seçti.");
    } else if (m.type === 'input') {
      if (!player) return;
      player.lastSeen = Date.now();
      let x = +m.x || 0, z = +m.z || 0;
      const mag = Math.hypot(x, z);
      if (mag > 1) { x /= mag; z /= mag; }
      player.dirX = x; player.dirZ = z;
      player.yaw = +m.yaw || 0; player.pitch = +m.pitch || 0;
      player.run = !!m.run;
    } else if (m.type === 'action') {
      if (!room || !player) return;
      handleAction(room, player, m.action || {});
    }
  });

  function attach() {
    player.ws = ws;
    ws.send(JSON.stringify({ type: 'welcome', id: player.id, code: room.code, token: player.token }));
  }

  ws.on('close', () => {
    if (player) {
      player.online = false; player.ws = null; player.dirX = player.dirZ = 0;
      if (room) room.lastActivity = Date.now();
    }
  });
});

server.listen(PORT, () => console.log('Ebediyet sunucusu port ' + PORT + ' üzerinde çalışıyor'));
