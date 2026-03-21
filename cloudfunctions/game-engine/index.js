// cloudfunctions/game-engine/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { newShuffledDeck, deal } = require('./shared/deck')
const { evaluateBestHand, calculateSidePots, distributePots } = require('./shared/poker-logic')
const { getNextActorIndex } = require('./shared/validator')

const DEFAULT_TIMEOUT_SEC = 30

exports.main = async (event, context) => {
  const { action } = event
  switch (action) {
    case 'initRound': return initRound(event)
    case 'advancePhase': return advancePhase(event)
    case 'endRound': return endRound(event)
    default: return { code: 400, msg: '未知操作' }
  }
}

async function initRound(event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  // 处理 pendingAction：stand=离座成观战者，sit=已在座位无需额外处理
  const spectators = room.spectators || []
  const pendingUpdates = {}
  let newSpectators = [...spectators]

  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i]
    if (!seat.openid) continue
    if (seat.pendingAction === 'stand') {
      // 将玩家移入观战者列表，保留筹码和积分信息
      newSpectators.push({
        openid: seat.openid,
        nickname: seat.nickname,
        avatar: seat.avatar,
        chips: seat.chips || 0,               // 保留筹码
        initialChips: seat.initialChips || 0,  // 保留基准
        totalRefillCost: seat.totalRefillCost || 0,
      })
      pendingUpdates[`seats.${i}.openid`] = null
      pendingUpdates[`seats.${i}.nickname`] = null
      pendingUpdates[`seats.${i}.avatar`] = null
      pendingUpdates[`seats.${i}.chips`] = 0
      pendingUpdates[`seats.${i}.initialChips`] = 0
      pendingUpdates[`seats.${i}.totalRefillCost`] = 0
      pendingUpdates[`seats.${i}.status`] = 'waiting'
      pendingUpdates[`seats.${i}.isReady`] = false
      pendingUpdates[`seats.${i}.pendingAction`] = null
      room.seats[i] = { ...seat, openid: null, nickname: null, avatar: null, chips: 0, pendingAction: null }
    } else if (seat.pendingAction) {
      // 清除其他 pendingAction
      pendingUpdates[`seats.${i}.pendingAction`] = null
      room.seats[i] = { ...seat, pendingAction: null }
    }
  }

  if (Object.keys(pendingUpdates).length > 0) {
    pendingUpdates.spectators = newSpectators
    await db.collection('rooms').doc(roomId).update({ data: pendingUpdates })
    room.spectators = newSpectators
    await db.collection('room_views').doc(roomId).update({
      data: { spectators: newSpectators, updatedAt: db.serverDate() },
    })
  }

  const activePlayers = room.seats.filter(s => s.openid !== null)
  if (activePlayers.length < 2) return { code: 400, msg: '玩家不足' }

  const { config, roundNumber } = room
  // 0 表示不限制，给一个很大的值
  const timeoutSec = config.actionTimeoutSec === 0 ? 86400 : (config.actionTimeoutSec || DEFAULT_TIMEOUT_SEC)
  const gameRoundId = `round_${roomId}_${Date.now()}`

  let deck = newShuffledDeck()

  // 庄家位轮换
  const dealerIndex = roundNumber % activePlayers.length
  const dealerSeatIndex = activePlayers[dealerIndex].seatIndex
  const sbIndex = getNextActiveIndex(room.seats, dealerSeatIndex)
  const bbIndex = getNextActiveIndex(room.seats, sbIndex)
  const firstActorIndex = getNextActiveIndex(room.seats, bbIndex)

  // 筹码归零的玩家自动用积分补充，并扣除积分、更新 initialChips
  const refillUpdates = {}
  const refillMap = {}  // openid -> costPoints，供 room_views 展示
  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i]
    if (!seat.openid) continue
    if ((seat.chips || 0) === 0) {
      const costPoints = Math.ceil(config.buyInChips * config.pointsPerChip)
      const prevInitial = seat.initialChips || 0
      // 首次参与（prevInitial=0）：设基准，不算"损失"，totalRefillCost 不增加
      // 后续补充（prevInitial>0）：筹码清零补充，才算损失
      const isFirstJoin = prevInitial === 0
      const newInitialChips = isFirstJoin ? config.buyInChips : prevInitial + config.buyInChips
      const newRefillCost = isFirstJoin ? (seat.totalRefillCost || 0) : (seat.totalRefillCost || 0) + costPoints

      refillUpdates[`seats.${i}.chips`] = config.buyInChips
      refillUpdates[`seats.${i}.initialChips`] = newInitialChips
      refillUpdates[`seats.${i}.totalRefillCost`] = newRefillCost
      refillMap[seat.openid] = costPoints
      room.seats[i] = {
        ...seat,
        chips: config.buyInChips,
        initialChips: newInitialChips,
        totalRefillCost: newRefillCost,
      }
    }
  }

  if (Object.keys(refillUpdates).length > 0) {
    await Promise.all([
      db.collection('rooms').doc(roomId).update({ data: refillUpdates }),
      // 扣除积分
      ...Object.entries(refillMap).map(([openid, cost]) =>
        db.collection('users').where({ _openid: openid }).update({ data: { points: db.command.inc(-cost) } })
      ),
    ])
  }

  // 从 room.seats 读取当前筹码（持续累计）
  const playerStates = room.seats.map(seat => {
    if (!seat.openid) return null
    return {
      openid: seat.openid,
      holeCards: [],
      chips: seat.chips || config.buyInChips,
      betInPhase: 0,
      betTotal: 0,
      status: 'active',
      hasActed: false,
      isLastAggressor: false,
    }
  })

  // 发手牌
  const myCardsData = []
  for (const seat of room.seats) {
    if (!seat.openid) continue
    const { cards, remaining } = deal(deck, 2)
    deck = remaining
    playerStates[seat.seatIndex].holeCards = cards
    myCardsData.push({
      _openid: seat.openid,
      gameRoundId,
      roomId,
      holeCards: cards,
      createdAt: db.serverDate(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    })
  }

  // 强制盲注
  const sbSeat = room.seats[sbIndex]
  const bbSeat = room.seats[bbIndex]
  if (sbSeat?.openid) {
    const sbAmount = Math.min(config.smallBlind, playerStates[sbIndex].chips)
    playerStates[sbIndex].chips -= sbAmount
    playerStates[sbIndex].betInPhase = sbAmount
    playerStates[sbIndex].betTotal = sbAmount
  }
  if (bbSeat?.openid) {
    const bbAmount = Math.min(config.bigBlind, playerStates[bbIndex].chips)
    playerStates[bbIndex].chips -= bbAmount
    playerStates[bbIndex].betInPhase = bbAmount
    playerStates[bbIndex].betTotal = bbAmount
  }

  const pot = (playerStates[sbIndex]?.betTotal || 0) + (playerStates[bbIndex]?.betTotal || 0)
  const actionDeadline = new Date(Date.now() + timeoutSec * 1000)
  const now = db.serverDate()

  const roundData = {
    _id: gameRoundId,
    roomId,
    roundNumber: roundNumber + 1,
    phase: 'preflop',
    deck,
    communityCards: [],
    pot,
    sidePots: [],
    dealerSeatIndex,
    smallBlindSeatIndex: sbIndex,
    bigBlindSeatIndex: bbIndex,
    currentActorSeatIndex: firstActorIndex,
    actionDeadline,
    playerStates,
    currentBet: config.bigBlind,
    minRaise: config.bigBlind,
    actionHistory: [
      { seatIndex: sbIndex, openid: sbSeat?.openid, action: 'blind', amount: config.smallBlind, phase: 'preflop', timestamp: now },
      { seatIndex: bbIndex, openid: bbSeat?.openid, action: 'blind', amount: config.bigBlind, phase: 'preflop', timestamp: now },
    ],
    winners: [],
    startedAt: now,
    endedAt: null,
  }

  await Promise.all([
    db.collection('game_rounds').add({ data: roundData }),
    ...myCardsData.map(c => db.collection('my_cards').add({ data: c })),
    db.collection('rooms').doc(roomId).update({
      data: { status: 'playing', currentGameRoundId: gameRoundId, roundNumber: roundNumber + 1, lastActivityAt: now },
    }),
    syncRoomView(roomId, gameRoundId, roundData, room),
  ])

  return { code: 0, data: { gameRoundId } }
}

async function advancePhase(event) {
  const { roomId, gameRoundId } = event
  const [roundRes, roomRes] = await Promise.all([
    db.collection('game_rounds').doc(gameRoundId).get(),
    db.collection('rooms').doc(roomId).get(),
  ])
  const round = roundRes.data
  const room = roomRes.data
  if (!round || round.phase === 'ended') return { code: 400, msg: '牌局状态错误' }

  const phaseOrder = ['preflop', 'flop', 'turn', 'river', 'showdown']
  const nextPhase = phaseOrder[phaseOrder.indexOf(round.phase) + 1]

  if (!nextPhase || nextPhase === 'showdown') {
    return endRound({ roomId, gameRoundId })
  }

  let { deck, communityCards } = round
  const newCardCount = nextPhase === 'flop' ? 3 : 1
  const { cards, remaining } = deal(deck, newCardCount)
  deck = remaining
  communityCards = [...communityCards, ...cards]

  const playerStates = round.playerStates.map(p => p ? { ...p, betInPhase: 0, hasActed: false } : null)
  const firstActor = getNextActiveIndex(room.seats, round.dealerSeatIndex, playerStates)
  const phaseSec = room.config.actionTimeoutSec === 0 ? 86400 : (room.config.actionTimeoutSec || DEFAULT_TIMEOUT_SEC)
  const actionDeadline = new Date(Date.now() + phaseSec * 1000)

  const updated = { ...round, phase: nextPhase, communityCards, playerStates, currentActorSeatIndex: firstActor, currentBet: 0, minRaise: room.config.bigBlind, actionDeadline }

  await Promise.all([
    db.collection('game_rounds').doc(gameRoundId).update({
      data: { phase: nextPhase, deck, communityCards, playerStates, currentActorSeatIndex: firstActor, currentBet: 0, minRaise: room.config.bigBlind, actionDeadline },
    }),
    syncRoomView(roomId, gameRoundId, updated, room),
  ])

  return { code: 0 }
}

async function endRound(event) {
  const { roomId, gameRoundId } = event
  const [roundRes, roomRes] = await Promise.all([
    db.collection('game_rounds').doc(gameRoundId).get(),
    db.collection('rooms').doc(roomId).get(),
  ])
  let round = roundRes.data
  const room = roomRes.data
  if (!round) return { code: 404, msg: '牌局不存在' }

  // 全员 allin 时逐阶段翻牌，每阶段间隔 1.2s，翻完后再等 1.5s 展示结果
  // 只剩一人（其他人弃牌）时不翻牌，直接结算
  let communityCards = round.communityCards || []
  let deck = round.deck || []

  const remainingPlayers = round.playerStates.filter(p => p && p.status !== 'folded' && p.status !== 'out')
  const needReveal = remainingPlayers.length > 1 && communityCards.length < 5

  if (needReveal) {
    // 按 flop(3张) → turn(1张) → river(1张) 逐步翻出
    const revealSteps = []
    if (communityCards.length < 3) revealSteps.push(3 - communityCards.length, 1, 1)
    else if (communityCards.length < 4) revealSteps.push(1, 1)
    else if (communityCards.length < 5) revealSteps.push(1)

    for (const count of revealSteps) {
      const { cards, remaining } = deal(deck, count)
      deck = remaining
      communityCards = [...communityCards, ...cards]
      // 每步先更新 room_views 展示新翻的牌
      await db.collection('room_views').doc(roomId).update({
        data: { communityCards, updatedAt: db.serverDate() },
      })
      // 等待客户端看到翻牌动画
      await new Promise(resolve => setTimeout(resolve, 1200))
    }

    // 更新 game_rounds 里的公共牌
    await db.collection('game_rounds').doc(round._id).update({
      data: { communityCards, deck },
    })
    round = { ...round, communityCards, deck }

    // 所有牌翻完后再等 1.5s 才展示结果
    await new Promise(resolve => setTimeout(resolve, 1500))
  }

  // 所有未弃牌玩家
  const activePlayers = round.playerStates.filter(p => p && p.status !== 'folded' && p.status !== 'out')

  let winnings = {}

  if (activePlayers.length === 1) {
    // 只剩一人：直接赢得全部底池
    winnings[activePlayers[0].openid] = round.pot
  } else {
    // 摊牌：计算牌型后分配（用补齐后的 communityCards）
    const handResults = {}
    for (const p of activePlayers) {
      const allCards = [...p.holeCards, ...communityCards]
      handResults[p.openid] = allCards.length >= 5
        ? evaluateBestHand(allCards)
        : { rank: 1, name: '高牌', tiebreakers: [0] }
    }
    const sidePots = calculateSidePots(round.playerStates.filter(Boolean))
    const mainPot = { amount: round.pot, eligibleOpenids: activePlayers.map(p => p.openid) }
    const potsToDistribute = sidePots.length > 0 ? sidePots : [mainPot]
    winnings = distributePots(potsToDistribute, handResults)
  }

  // 每位玩家本手最终筹码 = 手牌中剩余筹码 + 赢得筹码
  const finalChipsMap = {}
  for (const ps of round.playerStates) {
    if (!ps) continue
    finalChipsMap[ps.openid] = ps.chips + (winnings[ps.openid] || 0)
  }

  // 生成 winners（带昵称）
  const winners = Object.entries(winnings).map(([openid, potShare]) => {
    const seat = room.seats.find(s => s.openid === openid)
    const handResults = {}
    const p = round.playerStates.find(ps => ps && ps.openid === openid)
    if (p && communityCards.length > 0) {
      const allCards = [...p.holeCards, ...communityCards]
      if (allCards.length >= 5) handResults[openid] = evaluateBestHand(allCards)
    }
    return {
      openid,
      nickname: seat?.nickname || openid,
      potShare,
      handRank: handResults[openid]?.name || (activePlayers.length === 1 ? '其他人弃牌' : ''),
      bestCards: handResults[openid]?.cards || [],
    }
  })

  const now = db.serverDate()

  // 把本手最终筹码写回 rooms.seats（持续累计）
  const seatChipsUpdate = {}
  for (const ps of round.playerStates) {
    if (!ps) continue
    const seatIdx = room.seats.findIndex(s => s.openid === ps.openid)
    if (seatIdx >= 0) {
      seatChipsUpdate[`seats.${seatIdx}.chips`] = finalChipsMap[ps.openid]
    }
  }
  seatChipsUpdate.lastActivityAt = now

  await Promise.all([
    db.collection('game_rounds').doc(gameRoundId).update({ data: { phase: 'ended', winners, endedAt: now } }),
    db.collection('rooms').doc(roomId).update({ data: seatChipsUpdate }),
  ])

  // 更新 room_views 展示本手结果
  const settledWinners = winners.map(w => ({
    ...w,
    chipsAfter: finalChipsMap[w.openid],
  }))

  await db.collection('room_views').doc(roomId).update({
    data: {
      phase: 'hand_settled',
      communityCards,        // 展示补齐后的公共牌
      winners: settledWinners,
      pot: 0,
      currentActorSeatIndex: -1,
      actionDeadline: null,
      updatedAt: now,
    },
  })

  // 3秒后自动开始下一手
  await new Promise(resolve => setTimeout(resolve, 5000))

  const roomCheck = await db.collection('rooms').doc(roomId).get()
  if (!roomCheck.data || roomCheck.data.status === 'dismissed' || roomCheck.data.status === 'game_over') {
    return { code: 0 }
  }

  const nextRoundResult = await cloud.callFunction({ name: 'game-engine', data: { action: 'initRound', roomId } })
  const nextResult = nextRoundResult.result

  // initRound 失败（玩家不足，如所有人都起立）：回到等待状态
  if (nextResult && nextResult.code !== 0) {
    const nowTs = db.serverDate()
    await db.collection('rooms').doc(roomId).update({
      data: { status: 'waiting', currentGameRoundId: null, lastActivityAt: nowTs },
    })
    await db.collection('room_views').doc(roomId).update({
      data: { phase: 'waiting', gameRoundId: null, updatedAt: nowTs },
    })
  }

  return { code: 0 }
}

function getNextActiveIndex(seats, fromIndex, playerStates) {
  const total = seats.length
  for (let i = 1; i <= total; i++) {
    const idx = (fromIndex + i) % total
    const seat = seats[idx]
    if (!seat || !seat.openid) continue
    if (playerStates) {
      const ps = playerStates[idx]
      if (!ps || ps.status !== 'active') continue
    }
    return idx
  }
  return -1
}

async function syncRoomView(roomId, gameRoundId, round, room) {
  const viewSeats = room.seats.map((seat, i) => {
    const ps = round.playerStates ? round.playerStates[i] : null
    return {
      seatIndex: i,
      openid: seat.openid,
      nickname: seat.nickname,
      avatar: seat.avatar,
      chips: ps ? ps.chips : (seat.chips || 0),
      betInPhase: ps ? ps.betInPhase : 0,
      status: ps ? ps.status : (seat.openid ? 'waiting' : 'empty'),
      hasCards: ps ? (ps.holeCards && ps.holeCards.length > 0) : false,
      isDealer: i === round.dealerSeatIndex,
      isSmallBlind: i === round.smallBlindSeatIndex,
      isBigBlind: i === round.bigBlindSeatIndex,
      isCurrentActor: i === round.currentActorSeatIndex,
      pendingAction: seat.pendingAction || null,
      totalRefillCost: seat.totalRefillCost || 0,  // 累计补充消耗积分
    }
  })

  const viewData = {
    roomId, gameRoundId,
    phase: round.phase,
    communityCards: round.communityCards || [],
    pot: round.pot || 0,
    sidePots: round.sidePots || [],
    currentActorSeatIndex: round.currentActorSeatIndex,
    actionDeadline: round.actionDeadline,
    currentBet: round.currentBet || 0,
    minRaise: round.minRaise || 0,
    seats: viewSeats,
    actionHistory: (round.actionHistory || []).slice(-20),
    winners: round.winners || [],
    updatedAt: db.serverDate(),
  }

  try {
    await db.collection('room_views').doc(roomId).update({ data: viewData })
  } catch (e) {
    await db.collection('room_views').add({ data: { _id: roomId, ...viewData } })
  }
}
