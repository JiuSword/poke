// cloudfunctions/game-action/index.js
// 玩家操作的唯一入口
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { validateAction, isPhaseComplete, isRoundOver, getNextActorIndex } = require('./shared/validator')

const DEFAULT_TIMEOUT_SEC = 30

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  // 系统调用（timer-scheduler）时用 _openid 参数，客户端调用用 OPENID
  const openid = event._systemCall ? event._openid : OPENID
  if (event.playerAction || event.action === 'playerAction') {
    return playerAction(openid, event)
  }
  return { code: 400, msg: '未知操作' }
}

async function playerAction(openid, event) {
  // playerAction 字段存放具体操作（fold/check/call/raise/allin），避免与路由 action 字段冲突
  const { roomId, gameRoundId, amount } = event
  const action = event.playerAction || event.action

  // 读取牌局
  const roundRes = await db.collection('game_rounds').doc(gameRoundId).get()
  const round = roundRes.data
  if (!round) return { code: 404, msg: '牌局不存在' }

  // 校验 gameRoundId 与 room 一致
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room || room.currentGameRoundId !== gameRoundId) {
    return { code: 400, msg: '牌局信息不匹配' }
  }

  // 校验操作合法性
  const validation = validateAction(round, openid, action, amount)
  if (!validation.valid) return { code: 400, msg: validation.error }

  const seatIndex = round.currentActorSeatIndex
  const playerStates = round.playerStates.map(p => p ? { ...p } : null)
  const ps = playerStates[seatIndex]

  let pot = round.pot
  let currentBet = round.currentBet
  let minRaise = round.minRaise

  // 执行操作
  switch (action) {
    case 'fold':
      ps.status = 'folded'
      ps.hasActed = true
      break

    case 'check':
      ps.hasActed = true
      break

    case 'call': {
      const callAmount = Math.min(currentBet - ps.betInPhase, ps.chips)
      ps.chips -= callAmount
      ps.betInPhase += callAmount
      ps.betTotal += callAmount
      pot += callAmount
      if (ps.chips === 0) ps.status = 'allin'
      ps.hasActed = true
      break
    }

    case 'raise': {
      const callAmount = currentBet - ps.betInPhase
      const raiseAmount = Number(amount)
      const totalBet = callAmount + raiseAmount
      const actualBet = Math.min(totalBet, ps.chips)
      ps.chips -= actualBet
      ps.betInPhase += actualBet
      ps.betTotal += actualBet
      pot += actualBet
      currentBet = ps.betInPhase
      minRaise = raiseAmount
      if (ps.chips === 0) ps.status = 'allin'
      ps.hasActed = true
      ps.isLastAggressor = true
      // 重置其他玩家的 hasActed（需要重新行动）
      playerStates.forEach((p, i) => {
        if (p && i !== seatIndex && p.status === 'active') p.hasActed = false
      })
      break
    }

    case 'allin': {
      const allInAmount = ps.chips
      ps.betInPhase += allInAmount
      ps.betTotal += allInAmount
      pot += allInAmount
      ps.chips = 0
      ps.status = 'allin'
      if (ps.betInPhase > currentBet) {
        const raise = ps.betInPhase - currentBet  // 先算 raise 再更新 currentBet
        minRaise = Math.max(raise, minRaise)
        currentBet = ps.betInPhase
        playerStates.forEach((p, i) => {
          if (p && i !== seatIndex && p.status === 'active') p.hasActed = false
        })
      }
      ps.hasActed = true
      break
    }
  }

  const now = db.serverDate()
  const actionRecord = {
    seatIndex,
    openid,
    action,
    amount: amount || 0,
    phase: round.phase,
    timestamp: now,
  }
  const actionHistory = [...(round.actionHistory || []), actionRecord]

  // 判断是否只剩一人未弃牌
  if (isRoundOver(playerStates.filter(Boolean))) {
    // 先同步 actionHistory 到 room_views，让其他玩家听到最后一次操作音效
    await db.collection('room_views').doc(roomId).update({
      data: { actionHistory: actionHistory.slice(-20), updatedAt: db.serverDate() },
    })
    await db.collection('game_rounds').doc(gameRoundId).update({
      data: { playerStates, pot, currentBet, minRaise, actionHistory },
    })
    const result = await cloud.callFunction({
      name: 'game-engine',
      data: { action: 'endRound', roomId, gameRoundId },
    })
    return result.result
  }

  // 判断阶段是否结束
  const activePlayers = playerStates.filter(p => p && p.status === 'active')
  const allinPlayers = playerStates.filter(p => p && p.status === 'allin')
  const phaseComplete = activePlayers.length === 0 ||
    activePlayers.every(p => p.hasActed && p.betInPhase === currentBet)

  if (phaseComplete) {
    // 先同步 actionHistory 到 room_views，让其他玩家听到最后一次操作音效
    await db.collection('room_views').doc(roomId).update({
      data: { actionHistory: actionHistory.slice(-20), updatedAt: db.serverDate() },
    })
    await db.collection('game_rounds').doc(gameRoundId).update({
      data: { playerStates, pot, currentBet, minRaise, actionHistory },
    })

    // 所有未弃牌玩家都 allin，无人需要继续行动，直接结束牌局（翻牌由 endRound 处理展示）
    const notFolded = playerStates.filter(p => p && p.status !== 'folded' && p.status !== 'out')
    const allAllin = notFolded.length > 0 && notFolded.every(p => p.status === 'allin')

    if (allAllin) {
      const result = await cloud.callFunction({
        name: 'game-engine',
        data: { action: 'endRound', roomId, gameRoundId },
      })
      return result.result
    }

    const result = await cloud.callFunction({
      name: 'game-engine',
      data: { action: 'advancePhase', roomId, gameRoundId },
    })
    return result.result
  }

  // 找下一个行动者
  const nextActor = getNextActorIndex(playerStates, seatIndex)
  const timeoutSec = room.config?.actionTimeoutSec === 0 ? 86400 : (room.config?.actionTimeoutSec || DEFAULT_TIMEOUT_SEC)
  const actionDeadline = new Date(Date.now() + timeoutSec * 1000)

  // 顺带检查掉线玩家（事件驱动，不依赖定时器）
  await checkDisconnectedPlayers(room, roomId)

  await db.collection('game_rounds').doc(gameRoundId).update({
    data: {
      playerStates,
      pot,
      currentBet,
      minRaise,
      actionHistory,
      currentActorSeatIndex: nextActor,
      actionDeadline,
    },
  })

  // 同步 room_views
  await syncRoomViewPartial(roomId, gameRoundId, {
    playerStates,
    pot,
    currentBet,
    minRaise,
    actionHistory: actionHistory.slice(-20),
    currentActorSeatIndex: nextActor,
    actionDeadline,
    room,
    round,
  })

  return { code: 0 }
}

async function syncRoomViewPartial(roomId, gameRoundId, data) {
  const { playerStates, pot, currentBet, minRaise, actionHistory, currentActorSeatIndex, actionDeadline, room, round } = data

  const viewSeats = (room.seats || []).map((seat, i) => {
    const ps = playerStates[i]
    return {
      seatIndex: i,
      openid: seat.openid,
      nickname: seat.nickname,
      avatar: seat.avatar,
      chips: ps ? ps.chips : 0,
      betInPhase: ps ? ps.betInPhase : 0,
      status: ps ? ps.status : (seat.openid ? 'waiting' : 'empty'),
      hasCards: ps ? ps.holeCards && ps.holeCards.length > 0 : false,
      isDealer: i === round.dealerSeatIndex,
      isSmallBlind: i === round.smallBlindSeatIndex,
      isBigBlind: i === round.bigBlindSeatIndex,
      isCurrentActor: i === currentActorSeatIndex,
      totalRefillCost: seat.totalRefillCost || 0,
      pendingAction: seat.pendingAction || null,
    }
  })

  await db.collection('room_views').doc(roomId).update({
    data: {
      seats: viewSeats,
      pot,
      currentBet,
      minRaise,
      actionHistory,
      currentActorSeatIndex,
      actionDeadline,
      updatedAt: db.serverDate(),
    },
  })
}

// 检查掉线玩家：lastSeen 超过 90s 标记 pendingAction='stand'
// 在每次操作后顺带执行，事件驱动，不依赖定时器
const DISCONNECT_TIMEOUT_MS = 90 * 1000

async function checkDisconnectedPlayers(room, roomId) {
  const now = Date.now()
  const updates = {}
  const viewUpdates = {}
  let hasUpdate = false

  for (let i = 0; i < room.seats.length; i++) {
    const seat = room.seats[i]
    if (!seat.openid) continue
    if (seat.pendingAction === 'stand') continue
    if (!seat.lastSeen) continue

    const lastSeenMs = new Date(seat.lastSeen).getTime()
    if (now - lastSeenMs > DISCONNECT_TIMEOUT_MS) {
      updates[`seats.${i}.pendingAction`] = 'stand'
      viewUpdates[`seats.${i}.pendingAction`] = 'stand'
      hasUpdate = true
      console.log(`掉线玩家 ${seat.openid} 标记起立`)
    }
  }

  if (hasUpdate) {
    updates.lastActivityAt = db.serverDate()
    viewUpdates.updatedAt = db.serverDate()
    await Promise.all([
      db.collection('rooms').doc(roomId).update({ data: updates }),
      db.collection('room_views').doc(roomId).update({ data: viewUpdates }),
    ])
  }
}
