'use strict';
window.G = window.G || {};
// 플레이어·파티 봇·적·탄환·전리품. 전투와 성장(경험치·레벨·장비 등급) 규칙을 담는다.
(function (G) {
  const BOT_DOWN_TIME = 7, BOT_RANGE = 18, BOT_SPEED = 4.4, BOT_TELEPORT = 26, BOT_JUMP = 6.4;
  const ORB_LIFE = 4, PICKUP_RADIUS = 1.4, ASSIST_ANGLE = 0.055, ASSIST_ANGLE_TOUCH = 0.11;
  const LOOT_CHANCE = 0.11, HEAL_CHANCE = 0.16, HEAL_AMOUNT = 30, PLAYER_HP = 130;

  const TYPES = {
    noise: { name: '잡음', hp: 46, speed: 2.7, dmg: 8, range: 1.5, size: 0.85, xp: 12, kind: 'melee', col: [0.86, 0.86, 0.8] },
    echo: { name: '반향', hp: 34, speed: 2.0, dmg: 7, range: 13, size: 0.75, xp: 16, kind: 'ranged', col: [0.78, 0.28, 0.22] },
    glitch: { name: '왜곡', hp: 20, speed: 4.4, dmg: 12, range: 1.3, size: 0.5, xp: 14, kind: 'bomber', col: [0.95, 0.55, 0.15] },
    ghost: { name: '접속자 7', hp: 260, speed: 3.4, dmg: 6, range: 14, size: 1.0, xp: 90, kind: 'ranged', col: [0.06, 0.06, 0.07] },
  };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const has = (S, name) => (S.player.buffs[name] || 0) > S.time;
  const rule = (S, id) => G.Rules.active(S, id);
  const charName = (id) => (id < 0 ? '접속자 7' : G.GAME_DATA.characters[id].name);
  const centerY = (e) => e.y + e.def.size * (e.stretch || 1) * 0.55;

  function makeWeapon(base, rarity, prefix) {
    const b = G.CONTENT.weapons[base], r = G.CONTENT.rarity[rarity];
    return Object.assign({}, b, {
      base, rarity, dmg: b.dmg * r.mult, name: (prefix && !b.exclusive ? prefix + ' ' : '') + b.name,
      color: b.exclusive ? G.CONTENT.css[2] : r.color, rgb: b.beam || r.rgb,
    });
  }
  const weaponScore = (w) => w.dmg * w.pellets * w.rate * (w.splash ? 1.25 : 1);

  function rollRarity(tier) {
    const r = Math.random();
    if (r < 0.03 + tier * 0.012) return 3;
    if (r < 0.13 + tier * 0.02) return 2;
    if (r < 0.42) return 1;
    return 0;
  }

  function createPlayer(charId, x, z) {
    const weapon = makeWeapon(G.CONTENT.startWeapon[charId], 0, G.GAME_DATA.characters[charId].item);
    return {
      charId, x, y: 0, z, vy: 0, yaw: 0, pitch: 0, r: 0.32, hp: PLAYER_HP, maxHp: PLAYER_HP, lvl: 1, xp: 0,
      alive: true, respawnT: 0, weapon, ammo: weapon.mag, fireCd: 0, reloadT: 0, skillCd: 0,
      lastHurt: -99, onGround: true, buffs: {}, history: [], histT: 0, inv: 0, walk: 0,
    };
  }

  function createBot(charId, slot, x, z) {
    return {
      charId, slot, name: charName(charId), x, y: 0, z, vy: 0, yaw: 0, r: 0.32, hp: 120, maxHp: 120,
      weapon: makeWeapon(G.CONTENT.startWeapon[charId] || 'pistol', 0),
      alive: true, downT: 0, target: null, thinkT: 0, fireCd: 1, gunFlash: 0, skillT: rnd(12, 22), chatT: rnd(18, 40), walk: 0, onGround: true,
    };
  }

  function spawnEnemy(S, type, x, z, room, scale) {
    const def = TYPES[type], hp = Math.round(def.hp * (scale || 1));
    const e = {
      type, def, x, z, y: 0, yaw: 0, r: Math.min(0.9, def.size * 0.42), hp, maxHp: hp, room, alive: true,
      atkCd: rnd(0.3, 1), shootCd: rnd(1, 2), flash: 0, stuckT: 0, alt: 1, revUntil: 0, bob: Math.random() * 6, walk: 0,
    };
    S.enemies.push(e);
    return e;
  }

  // ---- 성장 ----
  const xpNeed = (lvl) => 50 + lvl * 40;

  function addXP(S, n) {
    const p = S.player;
    p.xp += Math.round(n * S.xpMult);
    while (p.xp >= xpNeed(p.lvl)) {
      p.xp -= xpNeed(p.lvl);
      p.lvl += 1;
      p.maxHp += 12;
      p.hp = p.maxHp;
      S.bots.forEach((b) => { b.maxHp += 10; b.hp = b.maxHp; });
      G.hud.levelUp(p.lvl);
      G.audio.sfx('level');
    }
  }

  const dmgMult = (S) => (1 + 0.09 * (S.player.lvl - 1)) * (has(S, 'fury') ? 1.25 : 1) * (rule(S, 'giant') ? 1.5 : 1);
  const critChance = (S) => 0.06 + (has(S, 'focus') ? 0.3 : 0) + (has(S, 'mark') ? 0.4 : 0);

  // ---- 효과 ----
  function burst(S, x, y, z, col, n, speed) {
    for (let i = 0; i < n; i++) {
      S.parts.push({ x, y, z, vx: rnd(-1, 1) * speed, vy: rnd(0.2, 1.2) * speed, vz: rnd(-1, 1) * speed, t: rnd(0.4, 0.9), col, s: rnd(0.06, 0.16) });
    }
  }

  // ---- 피해 ----
  function hurtEnemy(S, e, dmg, crit, byPlayer) {
    if (!e.alive || (e.def.kind === 'anchor' && !byPlayer)) return;
    const amount = S.time < e.revUntil ? dmg * 1.5 : dmg;
    const oldHp = e.hp;
    e.hp = e.type === 'origin' ? G.Bosses.originDamage(S, e, amount, byPlayer) : e.hp - amount;
    if (e.type === 'origin' && e.hp === oldHp) return;
    // The second exposure must happen even when a single burst crosses the phase boundary.
    if (e.type === 'family' && e.phase === 1) e.hp = Math.max(e.maxHp * 0.5, e.hp);
    if (e.phaseGuard) e.hp = Math.max(1, e.hp);
    e.flash = 0.08;
    if (e.hp < oldHp && (byPlayer || Math.random() < 0.4)) {
      G.hud.floatText(e.x, e.y + e.def.size + 0.3, e.z, Math.round(Math.min(amount, oldHp - e.hp)) + (crit ? '!' : ''), crit ? '#ffd34d' : byPlayer ? '#ffffff' : '#9fb8a8', crit);
    }
    if (byPlayer) { S.hitMarkT = 0.12; G.audio.sfx(crit ? 'crit' : 'hit'); }
    if (e.hp <= 0) killEnemy(S, e);
  }

  function dropLoot(S, x, z, rarity) {
    const base = pick(Object.keys(G.CONTENT.weapons).filter((key) => !G.CONTENT.weapons[key].exclusive));
    S.pickups.push({ type: 'loot', x, z, y: 0, t: 0, w: makeWeapon(base, rarity, pick(G.CONTENT.lootPrefix)) });
  }

  function killEnemy(S, e) {
    e.alive = false;
    if (e.def.kind === 'anchor') { G.Bosses.anchorDown(S, e); return; }
    S.kills += 1;
    const tier = e.room ? e.room.tier : 1;
    addXP(S, e.def.xp * (1 + tier * 0.15));
    const boss = e.def.kind === 'boss';
    burst(S, e.x, centerY(e), e.z, e.def.col, boss ? 56 : 14, 5);
    G.audio.sfx('kill');
    if (boss) {
      S.orbs = S.orbs.filter((o) => o.boss !== e);
      dropLoot(S, e.x, e.z, e.type === 'family' || e.type === 'drowned' ? 3 : 2);
      G.Main.bossDown(e);
      return;
    }
    if (Math.random() < LOOT_CHANCE + tier * 0.01) dropLoot(S, e.x, e.z, rollRarity(tier));
    else if (Math.random() < HEAL_CHANCE) S.pickups.push({ type: 'heal', x: e.x, z: e.z, y: 0, t: 0 });
    if (Math.random() < 0.1) botSay(S, pick(S.bots), 'kill');
  }

  function explode(S, pt, radius, dmg, skip) {
    S.enemies.forEach((e) => {
      if (!e.alive || e === skip) return;
      const d = Math.hypot(e.x - pt[0], centerY(e) - pt[1], e.z - pt[2]);
      if (d < radius) hurtEnemy(S, e, dmg * (1 - d / radius * 0.5), false, true);
    });
    burst(S, pt[0], pt[1], pt[2], [1, 0.62, 0.2], 12, 4);
    S.flashT = Math.max(S.flashT, 0.05);
    G.audio.sfx('boom');
  }

  function hurtFriendly(S, f, dmg) {
    if (f === S.player) {
      if (!f.alive || f.inv > 0) return;
      f.hp -= dmg;
      f.lastHurt = S.time;
      S.hurt = Math.min(1, S.hurt + dmg / 28);
      G.audio.sfx('hurt');
      if (f.hp <= 0) G.Main.playerDown();
      return;
    }
    if (!f.alive) return;
    f.hp -= dmg * 0.75;
    if (f.hp <= 0) { f.hp = 0; f.alive = false; f.downT = BOT_DOWN_TIME; botSay(S, f, 'down'); }
  }

  // ---- 사격 ----
  function rayEnemy(S, o, d, maxT, minT) {
    let best = null, bt = maxT;
    for (const e of S.enemies) {
      if (!e.alive) continue;
      const boss = e.def.kind === 'boss';
      const rx = boss ? Math.max(0.96, e.def.size * e.def.ratio * (e.widthScale || 1) * 0.55) : e.def.size * 0.6;
      const ry = boss ? e.def.size * (e.stretch || 1) * 0.55 : rx;
      const ox = (e.x - o[0]) / rx, oy = (centerY(e) - o[1]) / ry, oz = (e.z - o[2]) / rx;
      const dx = d[0] / rx, dy = d[1] / ry, dz = d[2] / rx;
      const a = dx * dx + dy * dy + dz * dz;
      const tc = (ox * dx + oy * dy + oz * dz) / a;
      if (tc < minT) continue;
      const closest = (ox - dx * tc) ** 2 + (oy - dy * tc) ** 2 + (oz - dz * tc) ** 2;
      if (closest > 1) continue;
      const t = Math.max(minT, tc - Math.sqrt((1 - closest) / a));
      if (t < bt) { bt = t; best = e; }
    }
    return best ? { e: best, t: bt } : null;
  }

  // 조준 보조: 십자선 근처의 보이는 적을 맞힌 것으로 처리 (가볍게 즐기도록)
  function assist(S, cam) {
    let best = null, ba = G.input.touch ? ASSIST_ANGLE_TOUCH : ASSIST_ANGLE;
    const eye = { x: cam.eye[0], z: cam.eye[2] };
    for (const e of S.enemies) {
      if (!e.alive) continue;
      const cy = centerY(e), vx = e.x - cam.eye[0], vy = cy - cam.eye[1], vz = e.z - cam.eye[2];
      const L = Math.hypot(vx, vy, vz);
      if (L > 45 || L < cam.minT) continue;
      const ang = Math.acos(Math.min(1, (vx * cam.dir[0] + vy * cam.dir[1] + vz * cam.dir[2]) / L));
      if (ang < ba && G.world.los(eye, cam.eye[1], e, cy)) { ba = ang; best = { e, t: L - e.def.size * 0.4 }; }
    }
    return best;
  }

  function jitter(d, s) {
    const x = d[0] + rnd(-s, s), y = d[1] + rnd(-s, s), z = d[2] + rnd(-s, s), l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }

  function playerFire(S) {
    const p = S.player, w = p.weapon, cam = S.cam;
    const rapid = rule(S, 'burst');
    p.fireCd = Math.max(0, p.fireCd + 1 / (w.rate * (rapid ? 2 : 1)));
    if (!rapid) p.ammo -= 1;
    S.flashT = 0.05;
    S.recoil = Math.min(0.3, S.recoil + (w.beam ? 0.045 : 0.1));
    G.audio.sfx(w.sfx);
    const from = G.Characters.muzzle(S, p);
    const splash = w.splash || (rule(S, 'explosive') ? 2.2 : 0);
    for (let i = 0; i < w.pellets; i++) {
      const d = jitter(cam.dir, w.spread * (S.aiming ? 0.4 : 1));
      const wallT = G.world.raycast(cam.eye[0], cam.eye[1], cam.eye[2], d[0], d[1], d[2], 70);
      let hit = rayEnemy(S, cam.eye, d, wallT, cam.minT);
      if (!hit && i === 0) hit = assist(S, cam);
      const t = hit ? hit.t : wallT;
      const end = [cam.eye[0] + d[0] * t, cam.eye[1] + d[1] * t, cam.eye[2] + d[2] * t];
      S.tracers.push({ a: from, b: end, t: w.beam ? 0.09 : 0.06, col: w.rgb, beam: !!w.beam });
      if (hit) {
        const crit = Math.random() < critChance(S);
        hurtEnemy(S, hit.e, w.dmg * dmgMult(S) * (crit ? 2 : 1), crit, true);
      } else if (t < 70) burst(S, end[0], end[1], end[2], [0.7, 0.7, 0.6], 2, 1.5);
      if (splash && t < 70) explode(S, end, splash, w.dmg * 0.6 * dmgMult(S), hit && hit.e);
    }
  }

  // ---- 고유 능력 ----
  const enemiesNear = (S, a, r) => S.enemies.filter((e) => e.alive && flat(e, a) < r);

  function useSkill(S) {
    const p = S.player;
    if (p.skillCd > 0 || !p.alive) return;
    const sk = G.CONTENT.skills[p.charId];
    p.skillCd = sk.cd;
    S.shift = Math.max(S.shift, 0.35);
    G.audio.sfx('skill');
    G.hud.toast(sk.name, G.CONTENT.css[p.charId]);
    const col = G.CONTENT.colors[p.charId];
    if (p.charId === 0) {
      enemiesNear(S, p, 14).forEach((e) => { e.revUntil = S.time + 4; });
      p.hp = Math.min(p.maxHp, p.hp + 25);
    } else if (p.charId === 1) {
      p.buffs.mark = S.time + 7;
    } else if (p.charId === 2) {
      const h = p.history[0];
      burst(S, p.x, p.y + 1, p.z, col, 16, 3);
      if (h) { p.x = h.x; p.y = h.y; p.z = h.z; p.hp = Math.max(p.hp, h.hp); }
      p.ammo = p.weapon.mag; p.reloadT = 0;
    } else if (p.charId === 3) {
      p.buffs.slow = S.time + 5;
    } else if (p.charId === 4) {
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      for (let i = 0; i < 20; i++) G.world.move(p, fx * 0.35, fz * 0.35);
      p.buffs.haste = S.time + 4;
      p.inv = 0.5;
    } else {
      enemiesNear(S, p, 7).forEach((e) => {
        const d = flat(e, p) || 1;
        hurtEnemy(S, e, 45 * dmgMult(S), false, true);
        if (e.type !== 'origin' && e.def.kind !== 'anchor') G.world.move(e, (e.x - p.x) / d * 2.5, (e.z - p.z) / d * 2.5);
      });
      S.orbs = S.orbs.filter((o) => Math.hypot(o.x - p.x, o.z - p.z) > 9);
    }
    burst(S, p.x, p.y + 1, p.z, col, 18, 4);
  }

  // ---- 파티 봇 ----
  function botSay(S, b, kind) {
    if (!b) return;
    const own = b.charId >= 0 ? G.GAME_DATA.characters[b.charId] : null;
    const line = kind === 'quote' && own ? own.quote : pick(G.CONTENT.botLines[kind] || G.CONTENT.botLines.idle);
    G.hud.chat('party', b.name, line, b.charId >= 0 ? G.CONTENT.css[b.charId] : '#888');
  }

  function nearestEnemy(S, from, range) {
    let best = null, bd = range;
    for (const e of S.enemies) {
      if (!e.alive || e.def.kind === 'anchor' || G.Bosses.isProtected(e)) continue;
      const d = flat(e, from);
      if (d < bd && G.world.los(from, from.y + 1.4, e, centerY(e))) { bd = d; best = e; }
    }
    return best;
  }

  function fall(a, dt, g) {
    a.vy -= g * dt;
    a.y += a.vy * dt;
    const gr = G.world.groundAt(a.x, a.z, a.r, a.y);
    if (a.y <= gr) { a.y = gr; a.vy = 0; a.onGround = true; } else a.onGround = false;
  }

  function botShoot(S, b, t) {
    const w = b.weapon;
    b.fireCd = rnd(0.86, 1.14) / (1.45 + w.rate * 0.18);
    b.gunFlash = 0.065;
    const cy = centerY(t), hit = Math.random() < 0.6;
    const end = hit ? [t.x, cy, t.z] : [t.x + rnd(-1, 1), cy + rnd(-0.5, 1), t.z + rnd(-1, 1)];
    S.tracers.push({ a: G.Characters.muzzle(S, b), b: end, t: 0.05, col: w.rgb, beam: !!w.beam });
    const distance = flat(b, S.player);
    if (distance < 14) G.audio.sfx(w.sfx, 0.32 * (1 - distance / 14));
    const damage = Math.sqrt(w.dmg * w.pellets) * 0.75 + 1.4 * S.player.lvl;
    if (hit) hurtEnemy(S, t, damage * (Math.random() < 0.08 ? 2 : 1), false, false);
  }

  function botSkill(S, b) {
    b.skillT = rnd(18, 28);
    const hits = enemiesNear(S, b, 5);
    if (!hits.length) return;
    hits.forEach((e) => hurtEnemy(S, e, 28 + 3 * S.player.lvl, false, false));
    burst(S, b.x, b.y + 1, b.z, b.charId >= 0 ? G.CONTENT.colors[b.charId] : [0.2, 0.2, 0.2], 20, 4);
    if (b.charId >= 0) G.hud.chat('party', b.name, G.GAME_DATA.characters[b.charId].ability + '!', G.CONTENT.css[b.charId]);
  }

  function updateBot(S, b, dt) {
    const p = S.player;
    b.gunFlash -= dt;
    if (!b.alive) {
      b.downT -= dt;
      if (b.downT <= 0) { b.alive = true; b.hp = b.maxHp * 0.6; botSay(S, b, 'up'); }
      return;
    }
    b.thinkT -= dt;
    if (b.thinkT <= 0) { b.thinkT = rnd(0.25, 0.45); b.target = nearestEnemy(S, b, BOT_RANGE); }
    const t = b.target && b.target.alive ? b.target : null;
    const ang = p.yaw + Math.PI + (b.slot - 2) * 0.6, rad = t ? 3.6 : 2.6;
    const tx = p.x + Math.sin(ang) * rad, tz = p.z + Math.cos(ang) * rad;
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    if (p.alive && d > BOT_TELEPORT) { b.x = p.x + rnd(-0.5, 0.5); b.z = p.z + rnd(-0.5, 0.5); b.y = p.y; }
    else if (p.alive && d > 0.6) {
      const sp = BOT_SPEED * (d > 8 ? 1.5 : 1) * Math.min(1, d / 1.5);
      if (G.world.move(b, dx / d * sp * dt, dz / d * sp * dt) && b.onGround) b.vy = BOT_JUMP;
      b.walk += dt * 9;
      if (!t) b.yaw = Math.atan2(dx, dz);
    }
    if (t) {
      b.yaw = Math.atan2(t.x - b.x, t.z - b.z);
      b.fireCd -= dt;
      if (b.fireCd <= 0) botShoot(S, b, t);
      b.skillT -= dt;
      if (b.skillT <= 0) botSkill(S, b);
    }
    fall(b, dt, 18);
    b.chatT -= dt;
    if (b.chatT <= 0) { b.chatT = rnd(30, 60); botSay(S, b, Math.random() < 0.4 ? 'quote' : 'idle'); }
  }

  function updateBots(S, dt) { S.bots.forEach((b) => updateBot(S, b, dt)); }

  // ---- 적 ----
  function pickTarget(S, e) {
    const p = S.player;
    let best = null, bd = Infinity;
    if (p.alive) { best = p; bd = flat(e, p) * 0.8; }
    S.bots.forEach((b) => { if (!b.alive) return; const d = flat(e, b); if (d < bd) { bd = d; best = b; } });
    return best;
  }

  function shootOrb(S, x, y, z, tx, ty, tz, speed, dmg) {
    const dx = tx - x, dy = ty - y, dz = tz - z, l = Math.hypot(dx, dy, dz) || 1;
    S.orbs.push({ x, y, z, vx: dx / l * speed, vy: dy / l * speed, vz: dz / l * speed, dmg, life: ORB_LIFE });
  }

  function steer(S, e, mx, mz, spd, dt) {
    if (e.stuckT > 0) { e.stuckT -= dt; const ox = mx; mx = -mz * e.alt; mz = ox * e.alt; }
    const bx = e.x, bz = e.z;
    G.world.move(e, mx * spd * dt, mz * spd * dt);
    const moved = Math.hypot(e.x - bx, e.z - bz);
    if (moved < spd * dt * 0.3 && e.stuckT <= 0) { e.stuckT = 0.6; e.alt = Math.random() < 0.5 ? 1 : -1; }
    e.walk += moved * 3;
  }

  function updateEnemy(S, e, dt) {
    if (e.def.kind === 'boss') { G.Bosses.update(S, e, dt); return; }
    e.flash = Math.max(0, e.flash - dt);
    if (e.def.kind === 'anchor') return;
    e.atkCd -= dt;
    const tgt = pickTarget(S, e);
    if (!tgt) return;
    const dx = tgt.x - e.x, dz = tgt.z - e.z, d = Math.hypot(dx, dz) || 0.001;
    e.yaw = Math.atan2(dx, dz);
    e.y = G.world.groundAt(e.x, e.z, e.r, e.y);
    if (d > 22 && e.room !== S.room) return;
    let mx = dx / d, mz = dz / d;
    const reversed = S.time < e.revUntil;
    if (reversed) { mx = -mx; mz = -mz; }
    const kind = e.def.kind;
    if (kind === 'ranged' && !reversed) {
      if (d < 7) { mx = -mx; mz = -mz; }
      else if (d < 11) { const s = Math.sin(S.time * 1.3 + e.bob) > 0 ? 1 : -1; const ox = mx; mx = -mz * s; mz = ox * s; }
    }
    steer(S, e, mx, mz, e.def.speed, dt);
    if (reversed) return;
    if (kind === 'melee' && d < e.def.range + tgt.r && e.atkCd <= 0) {
      e.atkCd = 0.9;
      hurtFriendly(S, tgt, e.def.dmg);
    } else if (kind === 'bomber' && d < e.def.range) {
      const all = [S.player].concat(S.bots);
      all.forEach((f) => { const fd = flat(f, e); if (fd < 2.8) hurtFriendly(S, f, e.def.dmg * (1 - fd / 2.8 * 0.5)); });
      burst(S, e.x, e.y + 0.4, e.z, e.def.col, 16, 5);
      G.audio.sfx('boom');
      killEnemy(S, e);
    } else if (kind === 'ranged') {
      e.shootCd -= dt;
      if (e.shootCd <= 0 && d < e.def.range && G.world.los(e, centerY(e), tgt, tgt.y + 1.2)) {
        e.shootCd = rnd(1.6, 2.3);
        shootOrb(S, e.x, centerY(e), e.z, tgt.x, tgt.y + 1.1, tgt.z, 8.5, e.def.dmg);
        G.audio.sfx('orb');
      }
    }
  }

  function separate(S) {
    const list = S.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive || a.def.kind === 'boss' || a.def.kind === 'anchor') continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive || b.def.kind === 'boss' || b.def.kind === 'anchor') continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r;
        if (d > 0.001 && d < min) {
          const push = (min - d) * 0.5;
          G.world.move(a, -dx / d * push, -dz / d * push);
          G.world.move(b, dx / d * push, dz / d * push);
        }
      }
    }
  }

  function updateEnemies(S, dt) {
    S.enemies.forEach((e) => { if (e.alive) updateEnemy(S, e, dt); });
    separate(S);
    if (S.enemies.length > 60 || Math.random() < 0.02) S.enemies = S.enemies.filter((e) => e.alive);
  }

  // ---- 탄환·전리품·입자 ----
  function updateOrbs(S, dt) {
    const friends = [S.player].concat(S.bots);
    S.orbs = S.orbs.filter((o) => {
      o.life -= dt;
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;
      if (o.life <= 0 || o.y < 0 || o.y < G.world.heightAt(o.x, o.z)) return false;
      for (const f of friends) {
        if (!f.alive) continue;
        if (Math.hypot(o.x - f.x, o.y - (f.y + 1), o.z - f.z) < 0.65) { hurtFriendly(S, f, o.dmg); return false; }
      }
      return true;
    });
  }

  function takeLoot(S, w) {
    const p = S.player, r = G.CONTENT.rarity[w.rarity];
    if (weaponScore(w) > weaponScore(p.weapon) * 1.02) {
      p.weapon = w; p.ammo = w.mag; p.reloadT = 0;
      G.hud.toast(`[${r.name}] ${w.name} 장착`, r.color);
      G.hud.chat('system', '', `[${r.name}] ${w.name} 획득`, r.color);
    } else {
      addXP(S, 15);
      G.hud.toast(`[${r.name}] ${w.name} 분해 · +15 XP`, '#9a9a90');
    }
  }

  function updatePickups(S, dt) {
    const p = S.player;
    S.pickups = S.pickups.filter((pk) => {
      pk.t += dt;
      if (!p.alive || Math.hypot(p.x - pk.x, p.z - pk.z) > PICKUP_RADIUS || Math.abs(p.y - pk.y) > 2) return true;
      G.audio.sfx('pickup');
      if (pk.type === 'seal') G.Main.takeSeal(pk.room);
      else if (pk.type === 'loot') takeLoot(S, pk.w);
      else p.hp = Math.min(p.maxHp, p.hp + HEAL_AMOUNT);
      return false;
    });
  }

  function updateFx(S, dt) {
    S.tracers = S.tracers.filter((t) => (t.t -= dt) > 0);
    S.parts = S.parts.filter((q) => {
      q.t -= dt; q.vy -= 12 * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < 0) { q.y = 0; q.vy *= -0.3; }
      return q.t > 0;
    });
    if (S.parts.length > 400) S.parts = S.parts.slice(-400);
  }

  G.Actors = {
    TYPES, makeWeapon, rollRarity, createPlayer, createBot, spawnEnemy, addXP, dropLoot, hurtFriendly,
    playerFire, useSkill, updateBots, updateEnemies, updateOrbs, updatePickups, updateFx, fall, botSay, burst, rayEnemy, charName, has,
  };
})(window.G);
