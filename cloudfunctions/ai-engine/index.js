// cloudfunctions/ai-engine/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const { newShuffledDeck, deal, createDeck, shuffle } = require('./shared/deck')
const { evaluateBestHand, calculateSidePots, distributePots, compareHandResults } = require('./shared/poker-logic')

const BUY_IN = 10000
const SMALL_BLIND = 100
const BIG_BLIND = 200

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  // event.action 可能被玩家操作字段（fold/call等）覆盖，用 routeAction 兜底
  const routeAction = event.routeAction || event.action
  switch (routeAction) {
    case 'startSession': return startSession(OPENID, event)
    case 'playerAction': return playerAction(OPENID, event)
    case 'newRound': return newRound(OPENID, event)
    case 'endSession': return endSession(OPENID, event)
    default: return { code: 400, msg: '未知操作: ' + routeAction }
  }
}

// ─── 初始化一手牌 ────────────────────────────────────────────────────────────

function initRound(playerCount, difficulty, existingChips) {
  // existingChips: 上一手结束后各玩家筹码，首次为 null
  const chips = existingChips || Array(playerCount).fill(BUY_IN)

  let deck = newShuffledDeck()
  const playerStates = []

  for (let i = 0; i < playerCount; i++) {
    const { cards, remaining } = deal(deck, 2)
    deck = remaining
    playerStates.push({
      id: i === 0 ? 'player' : `ai_${i - 1}`,
      isAI: i !== 0,
      holeCards: cards,
      chips: chips[i],
      betInPhase: 0,
      betTotal: 0,
      status: 'active',
      hasActed: false,
    })
  }

  // 庄家轮换（简化：dealer 固定在最后一位，SB=0, BB=1, 首先行动=2 或 0）
  // 2人时：dealer=0(SB), BB=1, 首先行动=0
  // 多人时：SB=0, BB=1, 首先行动=2
  const sbIdx = 0
  const bbIdx = 1 % playerCount
  const firstActor = playerCount === 2 ? 0 : (2 % playerCount)

  const sbAmt = Math.min(SMALL_BLIND, playerStates[sbIdx].chips)
  playerStates[sbIdx].chips -= sbAmt
  playerStates[sbIdx].betInPhase = sbAmt
  playerStates[sbIdx].betTotal = sbAmt

  const bbAmt = Math.min(BIG_BLIND, playerStates[bbIdx].chips)
  playerStates[bbIdx].chips -= bbAmt
  playerStates[bbIdx].betInPhase = bbAmt
  playerStates[bbIdx].betTotal = bbAmt

  return {
    phase: 'preflop',
    deck,
    communityCards: [],
    pot: sbAmt + bbAmt,
    playerStates,
    currentBet: bbAmt,
    minRaise: BIG_BLIND,
    currentActorIndex: firstActor,
    dealerIndex: playerCount - 1,
    sbIdx,
    bbIdx,
    winners: [],
  }
}

// ─── 开始新会话 ───────────────────────────────────────────────────────────────

async function startSession(openid, event) {
  const { difficulty = 'beginner', aiCount = 1 } = event
  const playerCount = aiCount + 1
  const round = initRound(playerCount, difficulty, null)

  const sessionData = {
    _openid: openid,
    status: 'active',
    difficulty,
    aiCount,
    playerCount,
    ...round,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  }

  const res = await db.collection('ai_sessions').add({ data: sessionData })
  return { code: 0, data: { sessionId: res._id, state: sanitize(sessionData) } }
}

// ─── 玩家操作 ─────────────────────────────────────────────────────────────────

async function playerAction(openid, event) {
  const { sessionId, amount } = event
  // playerOp 是实际操作（fold/check/call/raise/allin），避免与路由 action 冲突
  const action = event.playerOp || event.action

  const sessionRes = await db.collection('ai_sessions').doc(sessionId).get()
  let state = sessionRes.data
  if (!state || state._openid !== openid) return { code: 403, msg: '无权操作' }
  if (state.status !== 'active') return { code: 400, msg: '会话已结束' }
  if (state.currentActorIndex !== 0) return { code: 400, msg: '不是您的回合' }

  state = deepCopy(state)

  // 执行玩家操作
  state = applyAction(state, 0, action, amount)

  // 判断是否只剩一人
  if (isRoundOver(state)) {
    state = endRound(state)
    await save(sessionId, state)
    return { code: 0, data: { state: sanitize(state), roundEnded: true } }
  }

  // 全员 allin 直接结束
  if (isAllAllin(state)) {
    state = fillCommunityCards(state)
    state = endRound(state)
    await save(sessionId, state)
    return { code: 0, data: { state: sanitize(state), roundEnded: true } }
  }

  // 阶段结束则推进
  if (isPhaseComplete(state)) {
    state = advancePhase(state)
    if (state.phase === 'showdown') {
      state = endRound(state)
      await save(sessionId, state)
      return { code: 0, data: { state: sanitize(state), roundEnded: true } }
    }
  }

  // AI 轮流行动，直到轮回玩家或阶段结束
  state = runAI(state)

  // AI 行动后再检查
  if (isRoundOver(state)) {
    state = endRound(state)
  } else if (isAllAllin(state)) {
    state = fillCommunityCards(state)
    state = endRound(state)
  } else if (isPhaseComplete(state)) {
    state = advancePhase(state)
    if (state.phase === 'showdown') {
      state = endRound(state)
    } else {
      // 新阶段 AI 可能先行动
      state = runAI(state)
    }
  }

  const roundEnded = state.phase === 'ended'
  await save(sessionId, state)
  return { code: 0, data: { state: sanitize(state), roundEnded } }
}

// ─── 开始下一手 ───────────────────────────────────────────────────────────────

async function newRound(openid, event) {
  const { sessionId } = event
  const sessionRes = await db.collection('ai_sessions').doc(sessionId).get()
  const session = sessionRes.data
  if (!session || session._openid !== openid) return { code: 403, msg: '无权操作' }

  // 取上一手结束后的筹码
  const chips = session.playerStates.map(p => p.chips)
  const round = initRound(session.playerCount, session.difficulty, chips)

  const newState = { ...session, ...round, status: 'active' }
  await save(sessionId, newState)
  return { code: 0, data: { state: sanitize(newState) } }
}

async function endSession(openid, event) {
  const { sessionId } = event
  const sessionRes = await db.collection('ai_sessions').doc(sessionId).get()
  const session = sessionRes.data

  if (session && session.playerStates) {
    // 计算本次对战结果：玩家筹码 vs 初始筹码
    const BUY_IN = 10000
    const playerPs = session.playerStates[0]
    const finalChips = playerPs ? (playerPs.chips || 0) : 0
    const chipsWon = finalChips - BUY_IN  // 正=赢，负=输
    const isWin = chipsWon > 0

    // 更新 users.aiStats（累计数据）
    const _ = db.command
    await db.collection('users').where({ _openid: openid }).update({
      data: {
        'aiStats.totalGames': _.inc(1),
        'aiStats.totalWins': _.inc(isWin ? 1 : 0),
        'aiStats.totalChipsWon': _.inc(chipsWon),
        'aiStats.updatedAt': db.serverDate(),
      },
    })
  }

  await db.collection('ai_sessions').doc(sessionId).update({
    data: { status: 'ended', updatedAt: db.serverDate() },
  })
  return { code: 0 }
}

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────────

function applyAction(state, actorIndex, action, amount) {
  const ps = state.playerStates[actorIndex]

  switch (action) {
    case 'fold':
      ps.status = 'folded'
      ps.hasActed = true
      break

    case 'check':
      ps.hasActed = true
      break

    case 'call': {
      const callAmt = Math.min(state.currentBet - ps.betInPhase, ps.chips)
      ps.chips -= callAmt
      ps.betInPhase += callAmt
      ps.betTotal += callAmt
      state.pot += callAmt
      if (ps.chips === 0) ps.status = 'allin'
      ps.hasActed = true
      break
    }

    case 'raise': {
      const callAmt = state.currentBet - ps.betInPhase
      const raiseAmt = Number(amount) || state.minRaise
      const total = Math.min(callAmt + raiseAmt, ps.chips)
      ps.chips -= total
      ps.betInPhase += total
      ps.betTotal += total
      state.pot += total
      const raise = ps.betInPhase - state.currentBet
      state.minRaise = Math.max(raise, state.minRaise)
      state.currentBet = ps.betInPhase
      if (ps.chips === 0) ps.status = 'allin'
      ps.hasActed = true
      state.playerStates.forEach((p, i) => {
        if (i !== actorIndex && p.status === 'active') p.hasActed = false
      })
      break
    }

    case 'allin': {
      const allIn = ps.chips
      ps.betInPhase += allIn
      ps.betTotal += allIn
      state.pot += allIn
      ps.chips = 0
      ps.status = 'allin'
      if (ps.betInPhase > state.currentBet) {
        const raise = ps.betInPhase - state.currentBet
        state.minRaise = Math.max(raise, state.minRaise)
        state.currentBet = ps.betInPhase
        state.playerStates.forEach((p, i) => {
          if (i !== actorIndex && p.status === 'active') p.hasActed = false
        })
      }
      ps.hasActed = true
      break
    }
  }

  // 找下一个 active 玩家
  const total = state.playerStates.length
  let nextFound = false
  for (let i = 1; i <= total; i++) {
    const idx = (actorIndex + i) % total
    if (state.playerStates[idx].status === 'active') {
      state.currentActorIndex = idx
      nextFound = true
      break
    }
  }
  if (!nextFound) state.currentActorIndex = -1

  return state
}

function runAI(state) {
  let s = state
  // 安全计数：每个玩家最多行动 playerCount 次（应对加注后重新行动的情况）
  const playerCount = s.playerStates.filter(p => p.status !== 'folded' && p.status !== 'out').length
  let safety = playerCount * playerCount * 3

  while (s.currentActorIndex !== 0 && s.currentActorIndex !== -1 && safety-- > 0) {
    if (isRoundOver(s) || isPhaseComplete(s) || isAllAllin(s)) break
    const aiDecision = decideAI(s, s.currentActorIndex)
    s = applyAction(s, s.currentActorIndex, aiDecision.action, aiDecision.amount)
  }
  return s
}

function advancePhase(state) {
  const order = ['preflop', 'flop', 'turn', 'river', 'showdown']
  const next = order[order.indexOf(state.phase) + 1] || 'showdown'

  let newCards = 0
  if (next === 'flop') newCards = 3
  else if (next === 'turn' || next === 'river') newCards = 1

  const { cards, remaining } = deal(state.deck, newCards)
  state.deck = remaining
  state.communityCards = [...state.communityCards, ...cards]
  state.phase = next
  state.currentBet = 0
  state.minRaise = BIG_BLIND
  state.playerStates = state.playerStates.map(p =>
    p ? { ...p, betInPhase: 0, hasActed: p.status !== 'active' } : p
  )

  // 首个行动者：从庄家左手边第一个 active 玩家
  const total = state.playerStates.length
  let firstActor = -1
  for (let i = 1; i <= total; i++) {
    const idx = (state.dealerIndex + i) % total
    if (state.playerStates[idx].status === 'active') {
      firstActor = idx
      break
    }
  }
  state.currentActorIndex = firstActor
  return state
}

function fillCommunityCards(state) {
  const needed = 5 - state.communityCards.length
  if (needed <= 0) return state
  const { cards, remaining } = deal(state.deck, needed)
  state.deck = remaining
  state.communityCards = [...state.communityCards, ...cards]
  return state
}

function endRound(state) {
  const notFolded = state.playerStates.filter(p => p.status !== 'folded')

  if (notFolded.length === 1) {
    notFolded[0].chips += state.pot
    state.winners = [{
      id: notFolded[0].id,
      potShare: state.pot,
      handRank: '其他人弃牌',
    }]
  } else {
    // 补齐公共牌
    if (state.communityCards.length < 5) {
      state = fillCommunityCards(state)
    }

    const handResults = {}
    for (const p of notFolded) {
      const all = [...p.holeCards, ...state.communityCards]
      handResults[p.id] = all.length >= 5
        ? evaluateBestHand(all)
        : { rank: 1, name: '高牌', tiebreakers: [0] }
    }

    const sidePots = calculateSidePots(
      state.playerStates.filter(Boolean).map(p => ({
        openid: p.id, betTotal: p.betTotal, status: p.status,
      }))
    )
    const mainPot = { amount: state.pot, eligibleOpenids: notFolded.map(p => p.id) }
    const pots = sidePots.length > 0
      ? sidePots.map(sp => ({ ...sp, eligibleOpenids: sp.eligibleOpenids }))
      : [mainPot]

    // distributePots 用 openid 字段，这里 id 就是 openid
    const winnings = distributePots(pots, handResults)

    for (const p of state.playerStates) {
      if (winnings[p.id]) p.chips += winnings[p.id]
    }

    state.winners = Object.entries(winnings).map(([id, share]) => ({
      id,
      potShare: share,
      handRank: handResults[id]?.name || '',
      bestCards: handResults[id]?.cards || [],
    }))
  }

  state.phase = 'ended'
  return state
}

// ─── AI 决策 ──────────────────────────────────────────────────────────────────

function decideAI(state, actorIndex) {
  const ps = state.playerStates[actorIndex]
  const callAmount = state.currentBet - ps.betInPhase
  const difficulty = state.difficulty || 'beginner'

  if (difficulty === 'beginner') {
    const r = Math.random()
    if (callAmount <= 0) return r < 0.7 ? { action: 'check' } : { action: 'raise', amount: state.minRaise }
    if (r < 0.3) return { action: 'fold' }
    if (r < 0.8) return { action: 'call' }
    return { action: 'raise', amount: state.minRaise }
  }

  if (difficulty === 'advanced') {
    const strength = estimateHandStrength(ps.holeCards)
    if (callAmount <= 0) return strength > 0.6 ? { action: 'raise', amount: state.minRaise } : { action: 'check' }
    if (strength < 0.3) return { action: 'fold' }
    if (strength < 0.6) return { action: 'call' }
    return { action: 'raise', amount: state.minRaise * 2 }
  }

  // expert
  const winRate = simulateWinRate(ps.holeCards, state.communityCards, state.playerStates.length - 1, 150)
  if (callAmount <= 0) return winRate > 0.5 ? { action: 'raise', amount: state.minRaise } : { action: 'check' }
  if (winRate < 0.3) return { action: 'fold' }
  if (winRate < 0.5) return { action: 'call' }
  return { action: 'raise', amount: Math.max(state.minRaise, Math.floor(state.pot * winRate * 0.5)) }
}

function estimateHandStrength(holeCards) {
  const RV = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 }
  const v1 = RV[holeCards[0]?.[0]] || 2
  const v2 = RV[holeCards[1]?.[0]] || 2
  let score = (v1 + v2) / 28
  if (holeCards[0]?.[1] === holeCards[1]?.[1]) score += 0.1
  if (holeCards[0]?.[0] === holeCards[1]?.[0]) score += 0.2
  return Math.min(score, 1)
}

function simulateWinRate(holeCards, communityCards, opponents, iterations) {
  const used = new Set([...holeCards, ...communityCards])
  const remaining = newShuffledDeck().filter(c => !used.has(c))
  let wins = 0
  const needed = 5 - communityCards.length
  for (let i = 0; i < iterations; i++) {
    const d = shuffle([...remaining])
    const board = [...communityCards, ...d.slice(0, needed)]
    const myBest = evaluateBestHand([...holeCards, ...board])
    let win = true
    for (let j = 0; j < opponents; j++) {
      const opp = d.slice(needed + j * 2, needed + j * 2 + 2)
      if (opp.length < 2) break
      const oppBest = evaluateBestHand([...opp, ...board])
      if (compareHandResults(oppBest, myBest) > 0) { win = false; break }
    }
    if (win) wins++
  }
  return wins / iterations
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function isRoundOver(state) {
  return state.playerStates.filter(p => p.status !== 'folded' && p.status !== 'out').length <= 1
}

function isAllAllin(state) {
  const notFolded = state.playerStates.filter(p => p.status !== 'folded' && p.status !== 'out')
  return notFolded.length > 1 && notFolded.every(p => p.status === 'allin')
}

function isPhaseComplete(state) {
  const active = state.playerStates.filter(p => p.status === 'active')
  return active.length === 0 || active.every(p => p.hasActed && p.betInPhase === state.currentBet)
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj))
}

async function save(sessionId, state) {
  const { _id, _openid, createdAt, ...rest } = state
  await db.collection('ai_sessions').doc(sessionId).update({
    data: { ...rest, updatedAt: db.serverDate() },
  })
}

function sanitize(state) {
  return {
    ...state,
    deck: undefined,
    playerStates: (state.playerStates || []).map((p, i) => ({
      ...p,
      holeCards: (i === 0 || state.phase === 'ended') ? p.holeCards : ['??', '??'],
    })),
  }
}
