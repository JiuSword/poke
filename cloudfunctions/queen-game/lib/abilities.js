// cloudfunctions/queen-game/lib/abilities.js
// 激活流程 + 角色能力结算 + 待决策队列

const E = require('./engine')

// 生成唯一决策 id（基于队列长度，无需随机）
function mkChoiceId(state) {
  state._choiceSeq = (state._choiceSeq || 0) + 1
  return `c${state.turnCount}_${state._choiceSeq}`
}

// 掷骰命中后处理整个位置（双方牌）。
// 自动结算所有不需玩家选择的效果，需要选择的压入 pendingChoices。
function activatePosition(state, pos) {
  state.activePosition = pos
  const cell = state.board[pos]
  if (!cell) { finishActivations(state); return }

  const current = state.currentPlayerColor
  const order = [current, E.opp(current)] // 谁先无所谓，下面按 initiative 排序

  // 收集本位置双方两张牌的状态
  const tiles = []
  for (const color of order) {
    const tile = cell[color]
    if (tile) tiles.push({ color, tile })
  }

  // 分情况：A 都背面→都翻开不触发；B 都正面→都激活；C 一正一背→先结算正面再翻开背面
  const faceUps = tiles.filter(t => t.tile.faceUp)
  const faceDowns = tiles.filter(t => !t.tile.faceUp)

  if (faceUps.length === 0) {
    // A：都背面 → 都翻开，不触发
    if (faceDowns.length > 0) E.log(state, `位置${pos}双方均为背面，翻开但不触发能力`)
    for (const t of faceDowns) E.turnFaceUp(state, t.color, pos)
    state.pendingActivations = []
    state.pendingFaceUps = []
    finishActivations(state)
    return
  }

  // 需要激活的正面牌：按有效 initiative 升序结算；initiative 相同则都不激活
  let toActivate = faceUps.slice()
  if (toActivate.length === 2) {
    const i0 = E.effectiveInit(state, toActivate[0].color, toActivate[0].tile.role)
    const i1 = E.effectiveInit(state, toActivate[1].color, toActivate[1].tile.role)
    if (i0 === i1) {
      E.log(state, `位置${pos}双方先攻值相同，均不激活`)
      toActivate = []
    } else {
      toActivate.sort((a, b) =>
        E.effectiveInit(state, a.color, a.tile.role) - E.effectiveInit(state, b.color, b.tile.role))
    }
  }

  // 把"待激活的正面牌"和"待翻开的背面牌"组织为按 initiative 的步骤序列。
  // 背面牌在其能力结算后翻开（C 情况），但翻开不影响激活顺序——
  // 规则：先结算正面牌能力，再翻开背面牌。
  // 我们把激活步骤压入 state.pendingActivations，按序逐个处理（中间可能插入玩家决策）。
  state.pendingActivations = toActivate.map(t => ({
    color: t.color, pos, role: t.tile.role,
    init: E.effectiveInit(state, t.color, t.tile.role),
  }))
  state.pendingFaceUps = faceDowns.map(t => ({ color: t.color, pos }))

  // 立即推进激活流水线（会自动结算到遇到第一个需要玩家决策处）
  pumpActivations(state)
}

// 推进激活流水线：依次结算 pendingActivations，遇到需玩家选择则停下（已压入 pendingChoices）
function pumpActivations(state) {
  if (state.winnerColor) { finishActivations(state); return }
  while (state.pendingActivations && state.pendingActivations.length > 0) {
    if (state.pendingChoices && state.pendingChoices.length > 0) return // 等待玩家决策
    const step = state.pendingActivations[0]
    const cell = state.board[step.pos]
    const tile = cell && cell[step.color]
    // 该牌可能在前一步被翻成背面 → 不激活（规则：被翻面则本回合不激活）
    if (!tile || !tile.faceUp) {
      E.log(state, `位置${step.pos}的${E.colorName(step.color)}方牌已被翻面，跳过激活`)
      state.pendingActivations.shift()
      continue
    }
    state.pendingActivations.shift()
    applyAbility(state, step.color, step.pos, step.role)
    if (state.winnerColor) { finishActivations(state); return }
  }
  // 激活完成 → 翻开背面牌（C 情况）
  if (state.pendingChoices && state.pendingChoices.length > 0) return
  finishActivations(state)
}

function finishActivations(state) {
  if (!state.winnerColor && state.pendingFaceUps) {
    for (const f of state.pendingFaceUps) E.turnFaceUp(state, f.color, f.pos)
  }
  state.pendingActivations = []
  state.pendingFaceUps = []
  E.checkVictory(state)
  // 进入 reposition 阶段（若未分胜负）
  if (!state.winnerColor) {
    state.phase = 'reposition'
    // 先手玩家首回合不可 reposition
    const isStarterFirstTurn = (state.currentPlayerColor === state.starterColor) && !state.firstTurnDone
    state.canReposition = !isStarterFirstTurn
  } else {
    state.phase = 'finished'
    state.canReposition = false
  }
}

// 结算单张牌能力。需要玩家选择时压入 pendingChoices 并 return（暂停）。
function applyAbility(state, color, pos, rawRole) {
  const role = E.effectiveRole(state, color, rawRole)
  if (rawRole === 'RECRUIT') {
    // 新兵：翻开主谋（若未翻开），以主谋能力结算
    const m = state.masters[color]
    if (!m || !m.role) { E.log(state, `${E.colorName(color)}方新兵无主谋可继承，无效果`); return }
    if (!m.faceUp) { m.faceUp = true; E.log(state, `${E.colorName(color)}方主谋（${E.CHARACTERS[m.role].name}）翻开`) }
    E.log(state, `${E.colorName(color)}方新兵继承主谋（${E.CHARACTERS[m.role].name}）能力`)
  }
  if (!role) return
  const o = E.opp(color)

  switch (role) {
    case 'SNIPER': {
      E.gainPrestige(state, color, 'r')
      const sym = E.POINT_SYMMETRY[pos]
      E.turnFaceDown(state, o, sym)
      break
    }
    case 'ASSASSIN': {
      E.gainPrestige(state, color, 'r')
      E.turnFaceDown(state, o, pos)
      break
    }
    case 'SCHEMER': {
      E.gainPrestige(state, color, 'y')
      const opts = E.selfColorsAvailableFromOpp(state, color)
      if (opts.length === 0) { E.log(state, `对手无声望可退回`); break }
      if (opts.length === 1) { E.removeOppPrestige(state, color, opts[0]); break }
      pushChoice(state, { owner: color, type: 'schemer_remove', role, optional: false,
        options: opts, label: '选择退回对手 1 个声望' })
      return
    }
    case 'NOBLE': {
      E.gainPrestige(state, color, 'y')
      // 再拿任意 1 个（供应无限，三色皆可）
      pushChoice(state, { owner: color, type: 'noble_gain', role, optional: false,
        options: ['r', 'y', 'b'], label: '选择额外获得 1 个声望' })
      return
    }
    case 'GAMBLER': {
      // 从对手拿任意 2 个（对手只有 1 个就拿 1 个）
      const avail = totalOppPrestige(state, color)
      if (avail === 0) { E.log(state, `对手无声望可夺取`); break }
      const times = Math.min(2, avail)
      pushChoice(state, { owner: color, type: 'gambler_steal', role, optional: false,
        options: E.selfColorsAvailableFromOpp(state, color), label: `从对手夺取声望（${times}次中的第1次）`,
        remaining: times })
      return
    }
    case 'PRINCESS': {
      // 翻开己方任意 1 张背面牌（可选）
      const downs = facedownPositions(state, color)
      if (downs.length === 0) { E.log(state, `己方无背面牌可翻开`); break }
      pushChoice(state, { owner: color, type: 'princess_reveal', role, optional: true,
        options: downs, publicOptions: downs, label: '可翻开己方 1 张背面牌（可跳过）' })
      return
    }
    case 'PILOT': {
      E.gainPrestige(state, color, 'b')
      // 可交换己方相邻一对，最多两次（可选）
      pushChoice(state, { owner: color, type: 'pilot_swap', role, optional: true,
        options: adjacentSwapPairs(state, color), publicOptions: adjacentSwapPairs(state, color),
        label: '可交换己方相邻两张牌（最多2次，可跳过）', remaining: 2 })
      return
    }
    case 'ENTERTAINER': {
      E.gainPrestige(state, color, 'b')
      // 先给对手 1 个，再从对手拿 1 个
      pushChoice(state, { owner: color, type: 'entertainer_give', role, optional: false,
        options: ['r', 'y', 'b'], label: '选择给对手 1 个声望' })
      return
    }
    case 'SPY': {
      E.gainPrestige(state, color, 'b')
      // 可交换对手相邻一对，最多两次（可选）
      pushChoice(state, { owner: color, type: 'spy_swap', role, optional: true,
        options: adjacentSwapPairs(state, o), publicOptions: adjacentSwapPairs(state, o),
        label: '可交换对手相邻两张牌（最多2次，可跳过）', remaining: 2 })
      return
    }
    case 'GUARD':
      // 被动牌，激活无主动效果
      E.log(state, `${E.colorName(color)}方卫兵无主动能力`)
      break
    case 'GAMBLER_NONE':
      break
    default:
      break
  }
}

function pushChoice(state, choice) {
  if (!state.pendingChoices) state.pendingChoices = []
  choice.id = mkChoiceId(state)
  state.pendingChoices.push(choice)
  state.phase = 'resolving'
}

function totalOppPrestige(state, color) {
  const p = state.prestige[E.opp(color)]
  return p.r + p.y + p.b
}
function facedownPositions(state, color) {
  return E.POSITIONS.filter(pos => {
    const t = state.board[pos] && state.board[pos][color]
    return t && !t.faceUp
  })
}
// 返回所有相邻可交换的位置对 [posA, posB]
function adjacentSwapPairs(state, color) {
  const pairs = []
  for (let i = 0; i < E.POSITIONS.length - 1; i++) {
    const a = E.POSITIONS[i], b = E.POSITIONS[i + 1]
    const ta = state.board[a] && state.board[a][color]
    const tb = state.board[b] && state.board[b][color]
    if (ta && tb) pairs.push([a, b])
  }
  return pairs
}

// ── 消费玩家决策 ────────────────────────────────────
// choiceId 必须匹配队首；payload 是玩家选择内容
function resolveChoice(state, color, choiceId, payload) {
  const choice = state.pendingChoices && state.pendingChoices[0]
  if (!choice) return { ok: false, msg: '当前无待决策' }
  if (choice.id !== choiceId) return { ok: false, msg: '决策已过期' }
  if (choice.owner !== color) return { ok: false, msg: '非你的决策' }

  const o = E.opp(color)
  switch (choice.type) {
    case 'schemer_remove': {
      if (!choice.options.includes(payload.color)) return { ok: false, msg: '非法选择' }
      E.removeOppPrestige(state, color, payload.color)
      state.pendingChoices.shift()
      break
    }
    case 'noble_gain': {
      if (!['r', 'y', 'b'].includes(payload.color)) return { ok: false, msg: '非法选择' }
      E.gainPrestige(state, color, payload.color)
      state.pendingChoices.shift()
      break
    }
    case 'gambler_steal': {
      if (!E.selfColorsAvailableFromOpp(state, color).includes(payload.color)) return { ok: false, msg: '对手无该色声望' }
      E.stealPrestige(state, color, payload.color)
      choice.remaining -= 1
      const stillAvail = totalOppPrestige(state, color) > 0
      if (choice.remaining > 0 && stillAvail) {
        choice.options = E.selfColorsAvailableFromOpp(state, color)
        choice.label = `从对手夺取声望（还可${choice.remaining}次）`
      } else {
        state.pendingChoices.shift()
      }
      break
    }
    case 'princess_reveal': {
      if (payload.skip) { E.log(state, `${E.colorName(color)}方选择不翻牌`); state.pendingChoices.shift(); break }
      const downs = facedownPositions(state, color)
      if (!downs.includes(payload.pos)) return { ok: false, msg: '该位置无背面牌' }
      E.turnFaceUp(state, color, payload.pos)
      state.pendingChoices.shift()
      break
    }
    case 'pilot_swap':
    case 'spy_swap': {
      const target = choice.type === 'pilot_swap' ? color : o
      if (payload.skip) { E.log(state, `${E.colorName(color)}方结束交换`); state.pendingChoices.shift(); break }
      const valid = adjacentSwapPairs(state, target).some(p => p[0] === payload.pair[0] && p[1] === payload.pair[1])
      if (!valid) return { ok: false, msg: '非法相邻对' }
      swapTiles(state, target, payload.pair[0], payload.pair[1])
      E.log(state, `${E.colorName(color)}方交换了${E.colorName(target)}方位置${payload.pair[0]}与${payload.pair[1]}`)
      choice.remaining -= 1
      if (choice.remaining > 0) {
        choice.options = adjacentSwapPairs(state, target)
        choice.publicOptions = choice.options
        choice.label = `可继续交换（还可${choice.remaining}次，可跳过）`
      } else {
        state.pendingChoices.shift()
      }
      break
    }
    case 'entertainer_give': {
      if (!['r', 'y', 'b'].includes(payload.color)) return { ok: false, msg: '非法选择' }
      E.givePrestige(state, color, payload.color)
      state.pendingChoices.shift()
      // 接着从对手拿 1 个（若对手有）
      const avail = E.selfColorsAvailableFromOpp(state, color)
      if (avail.length > 0) {
        pushChoice(state, { owner: color, type: 'entertainer_take', role: 'ENTERTAINER', optional: false,
          options: avail, label: '从对手拿 1 个声望' })
        // 新决策已 unshift? 不，pushChoice 是 push 到队尾；此时队列应只剩它
      } else {
        E.log(state, `对手无声望可拿`)
      }
      break
    }
    case 'entertainer_take': {
      if (!E.selfColorsAvailableFromOpp(state, color).includes(payload.color)) return { ok: false, msg: '对手无该色声望' }
      E.stealPrestige(state, color, payload.color)
      state.pendingChoices.shift()
      break
    }
    default:
      return { ok: false, msg: '未知决策类型' }
  }

  // 决策消费后，继续推进激活流水线
  E.checkVictory(state)
  if (!state.winnerColor) pumpActivations(state)
  else finishActivationsSafe(state)
  return { ok: true }
}

function finishActivationsSafe(state) {
  state.pendingActivations = []
  state.pendingFaceUps = []
  state.pendingChoices = []
  state.phase = 'finished'
  state.canReposition = false
}

function swapTiles(state, color, posA, posB) {
  const tmp = state.board[posA][color]
  state.board[posA][color] = state.board[posB][color]
  state.board[posB][color] = tmp
}

module.exports = { activatePosition, pumpActivations, applyAbility, resolveChoice, adjacentSwapPairs, swapTiles, facedownPositions }
