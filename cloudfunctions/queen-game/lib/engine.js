// cloudfunctions/queen-game/lib/engine.js
// 《女王万岁》规则引擎（纯函数式，操作传入的 state 对象的深拷贝）
//
// 设计核心：
//  - 一次 rollDice 后，引擎计算「命中位置上双方两张牌」的激活效果，
//    自动结算所有「无需玩家选择」的部分，把「需要玩家选择」的部分压入
//    state.pendingChoices 队列；前端逐个 resolveChoice 消费。
//  - 队列空后进入 reposition 阶段，玩家可选择交换/换主谋，然后 endTurn。

const POSITIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

// 点对称映射（以 7 为中心）
const POINT_SYMMETRY = { 2: 12, 3: 11, 4: 10, 5: 9, 6: 8, 7: 7, 8: 6, 9: 5, 10: 4, 11: 3, 12: 2 }

// 角色定义：initiative（左上编号）+ 声望色 + 是否可当主谋
const CHARACTERS = {
  SNIPER:      { init: 1, name: '狙击手', prestige: 'r', emoji: '🎯', canMaster: true },
  ASSASSIN:    { init: 2, name: '刺客',   prestige: 'r', emoji: '🗡️', canMaster: true },
  SCHEMER:     { init: 3, name: '阴谋家', prestige: 'y', emoji: '🎭', canMaster: true },
  NOBLE:       { init: 4, name: '贵族',   prestige: 'y', emoji: '🎩', canMaster: true },
  GAMBLER:     { init: 5, name: '赌徒',   prestige: null, emoji: '🎲', canMaster: false },
  PRINCESS:    { init: 6, name: '公主',   prestige: null, emoji: '👸', canMaster: false },
  PILOT:       { init: 7, name: '飞行员', prestige: 'b', emoji: '✈️', canMaster: true },
  ENTERTAINER: { init: 8, name: '艺人',   prestige: 'b', emoji: '🎻', canMaster: true },
  SPY:         { init: 9, name: '间谍',   prestige: 'b', emoji: '🕵️', canMaster: true },
  RECRUIT:     { init: 99, name: '新兵',  prestige: null, emoji: '🪖', canMaster: false },
  GUARD:       { init: 100, name: '卫兵', prestige: null, emoji: '🛡️', canMaster: false },
}

const COLOR_NAME = { r: '红', y: '黄', b: '蓝' }
function colorName(c) { return c === 'white' ? '白玫瑰' : '黑玫瑰' }
function opp(color) { return color === 'white' ? 'black' : 'white' }

function clone(o) { return JSON.parse(JSON.stringify(o)) }

// 取某角色的有效 initiative（新兵继承主谋）
function effectiveInit(state, color, role) {
  if (role === 'RECRUIT') {
    const m = state.masters[color]
    return m && m.role ? CHARACTERS[m.role].init : CHARACTERS.RECRUIT.init
  }
  return CHARACTERS[role].init
}

// 取某角色的有效行为角色（新兵继承主谋的能力）
function effectiveRole(state, color, role) {
  if (role === 'RECRUIT') {
    const m = state.masters[color]
    return m && m.role ? m.role : null
  }
  return role
}

function log(state, msg) {
  if (!state.log) state.log = []
  state.log.push(msg)
}

// ── 声望操作 ─────────────────────────────────────────
// 拿 1 个指定色（供应假设无限，但集齐 6 个立即清空）
function gainPrestige(state, color, c) {
  if (!c) return
  state.prestige[color][c] += 1
  log(state, `${colorName(color)}方 +1 ${COLOR_NAME[c]}声望`)
  if (state.prestige[color][c] >= 6) {
    state.prestige[color][c] = 0
    log(state, `${colorName(color)}方 ${COLOR_NAME[c]}声望达到6个，全部退回供应`)
  }
}
// 从对手退回 1 个指定色（schemer）
function removeOppPrestige(state, color, c) {
  const o = opp(color)
  if (state.prestige[o][c] > 0) {
    state.prestige[o][c] -= 1
    log(state, `${colorName(color)}方使${colorName(o)}方退回 1 ${COLOR_NAME[c]}声望`)
  }
}
// 从对手拿 1 个指定色到自己（gambler/entertainer）
function stealPrestige(state, color, c) {
  const o = opp(color)
  if (state.prestige[o][c] > 0) {
    state.prestige[o][c] -= 1
    state.prestige[color][c] += 1
    log(state, `${colorName(color)}方从${colorName(o)}方夺取 1 ${COLOR_NAME[c]}声望`)
    if (state.prestige[color][c] >= 6) { state.prestige[color][c] = 0; log(state, `${colorName(color)}方 ${COLOR_NAME[c]}声望达6个全部退回`) }
  }
}
// 给对手 1 个指定色（entertainer）：从自己扣 1 个，转移给对手（只能给自己拥有的颜色）
function givePrestige(state, color, c) {
  const o = opp(color)
  if (state.prestige[color][c] <= 0) {
    log(state, `${colorName(color)}方没有 ${COLOR_NAME[c]}声望可赠送`)
    return false
  }
  state.prestige[color][c] -= 1
  state.prestige[o][c] += 1
  log(state, `${colorName(color)}方赠予${colorName(o)}方 1 ${COLOR_NAME[c]}声望`)
  if (state.prestige[o][c] >= 6) { state.prestige[o][c] = 0; log(state, `${colorName(o)}方 ${COLOR_NAME[c]}声望达6个全部退回`) }
  return true
}

// 对手是否有任意声望
function oppHasAnyPrestige(state, color) {
  const p = state.prestige[opp(color)]
  return p.r > 0 || p.y > 0 || p.b > 0
}
// 自己拥有的声望颜色（用于"赠送给对手"时的可选项）
function selfColorsOwned(state, color) {
  const p = state.prestige[color]
  return ['r', 'y', 'b'].filter(c => p[c] > 0)
}
function selfColorsAvailableFromOpp(state, color) {
  const p = state.prestige[opp(color)]
  return ['r', 'y', 'b'].filter(c => p[c] > 0)
}

// ── 翻面操作（受卫兵保护） ───────────────────────────
// 将某方某位置的牌翻成背面（若可能）。返回是否成功翻面。
function turnFaceDown(state, color, pos) {
  const cell = state.board[pos]
  if (!cell || !cell[color]) return false
  const tile = cell[color]
  if (!tile.faceUp) return false  // 已是背面
  // 卫兵保护：相邻位置存在正面 GUARD 则免疫
  if (isGuardedBy(state, color, pos)) {
    log(state, `${colorName(color)}方位置${pos}的${CHARACTERS[tile.role].name}被卫兵保护，未被翻面`)
    return false
  }
  tile.faceUp = false
  log(state, `${colorName(color)}方位置${pos}的${CHARACTERS[tile.role].name}被翻为背面`)
  // 公主被翻面 → 对方斩首胜利
  if (tile.role === 'PRINCESS') {
    state.winnerColor = opp(color)
    log(state, `${colorName(color)}方公主被翻面！${colorName(opp(color))}方斩首获胜！`)
  }
  return true
}

// 相邻位置是否有正面卫兵保护本位置（卫兵不保护自己）
function isGuardedBy(state, color, pos) {
  const idx = POSITIONS.indexOf(pos)
  for (const d of [-1, 1]) {
    const n = POSITIONS[idx + d]
    if (n == null) continue
    const cell = state.board[n]
    const tile = cell && cell[color]
    if (tile && tile.faceUp && tile.role === 'GUARD') return true
  }
  return false
}

// ── 翻开操作 ────────────────────────────────────────
function turnFaceUp(state, color, pos) {
  const cell = state.board[pos]
  if (!cell || !cell[color]) return
  if (cell[color].faceUp) return
  cell[color].faceUp = true
  log(state, `${colorName(color)}方位置${pos}的${CHARACTERS[cell[color].role].name}翻开`)
}

// ── 胜负判定 ────────────────────────────────────────
function checkPrestigeVictory(state, color) {
  const p = state.prestige[color]
  return p.r >= 3 && p.y >= 3 && p.b >= 3
}
function checkVictory(state) {
  if (state.winnerColor) return state.winnerColor
  for (const color of ['white', 'black']) {
    if (checkPrestigeVictory(state, color)) {
      state.winnerColor = color
      log(state, `${colorName(color)}方集齐三色声望，统一帮派获胜！`)
      return color
    }
  }
  return null
}

module.exports = {
  POSITIONS, POINT_SYMMETRY, CHARACTERS, COLOR_NAME,
  clone, opp, colorName, effectiveInit, effectiveRole, log,
  gainPrestige, removeOppPrestige, stealPrestige, givePrestige,
  oppHasAnyPrestige, selfColorsAvailableFromOpp, selfColorsOwned,
  turnFaceDown, turnFaceUp, isGuardedBy,
  checkVictory, checkPrestigeVictory,
}
