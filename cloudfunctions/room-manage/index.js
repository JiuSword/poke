// cloudfunctions/room-manage/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  switch (action) {
    case 'createRoom': return createRoom(OPENID, event)
    case 'joinRoom': return joinRoom(OPENID, event)
    case 'leaveRoom': return leaveRoom(OPENID, event)
    case 'kickPlayer': return kickPlayer(OPENID, event)
    case 'dismissRoom': return dismissRoom(OPENID, event)
    case 'setReady': return setReady(OPENID, event)
    case 'startGame': return startGame(OPENID, event)
    case 'endGame': return endGame(OPENID, event)
    case 'pauseGame': return pauseGame(OPENID, event)
    case 'resumeGame': return resumeGame(OPENID, event)
    case 'getRoomInfo': return getRoomInfo(event)
    default: return { code: 400, msg: '未知操作' }
  }
}

async function createRoom(openid, event) {
  const { config } = event
  const { smallBlind = 10, maxPlayers = 6, buyInChips = 1000, pointsPerChip = 0.01 } = config || {}

  // 校验积分是否够入座一局
  const userRes = await db.collection('users').where({ _openid: openid }).get()
  if (userRes.data.length === 0) return { code: 404, msg: '用户不存在' }
  const user = userRes.data[0]
  const requiredPoints = Math.ceil(buyInChips * pointsPerChip)
  if (user.points < requiredPoints) {
    return { code: 400, msg: `积分不足，入座需要 ${requiredPoints} 积分` }
  }

  // 生成唯一6位房间号
  let roomCode, exists = true
  while (exists) {
    roomCode = String(Math.floor(100000 + Math.random() * 900000))
    const check = await db.collection('rooms').where({ roomCode, status: _.neq('dismissed') }).count()
    exists = check.total > 0
  }

  const now = db.serverDate()
  const seats = Array(maxPlayers).fill(null).map((_, i) => ({
    seatIndex: i,
    openid: i === 0 ? openid : null,
    nickname: i === 0 ? user.nickname : null,
    avatar: i === 0 ? user.avatar : null,
    chips: 0,
    status: 'waiting',
    isReady: false,
    lastSeen: i === 0 ? now : null,
  }))

  const roomData = {
    roomCode,
    hostOpenid: openid,
    status: 'waiting',
    config: {
      smallBlind,
      bigBlind: smallBlind * 2,
      maxPlayers,
      buyInChips,
      pointsPerChip,
    },
    seats,
    currentGameRoundId: null,
    roundNumber: 0,
    createdAt: now,
    lastActivityAt: now,
    dismissedAt: null,
  }

  const addRes = await db.collection('rooms').add({ data: roomData })
  const roomId = addRes._id

  // 初始化 room_views
  await db.collection('room_views').add({
    data: {
      _id: roomId,
      roomId,
      gameRoundId: null,
      phase: 'waiting',
      communityCards: [],
      pot: 0,
      sidePots: [],
      currentActorSeatIndex: -1,
      actionDeadline: null,
      currentBet: 0,
      minRaise: smallBlind * 2,
      seats: seats.map(s => ({
        seatIndex: s.seatIndex,
        openid: s.openid,
        nickname: s.nickname,
        avatar: s.avatar,
        chips: 0,
        betInPhase: 0,
        status: s.status,
        hasCards: false,
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        isCurrentActor: false,
      })),
      actionHistory: [],
      winners: [],
      updatedAt: now,
    },
  })

  return { code: 0, data: { roomId, roomCode } }
}

async function joinRoom(openid, event) {
  const { roomCode } = event

  const roomRes = await db.collection('rooms')
    .where({ roomCode, status: 'waiting' })
    .get()
  if (roomRes.data.length === 0) return { code: 404, msg: '房间不存在或已开始游戏' }
  const room = roomRes.data[0]

  // 检查是否已在房间
  if (room.seats.some(s => s.openid === openid)) {
    return { code: 0, data: { roomId: room._id, roomCode } }
  }

  // 找空位
  const emptyIndex = room.seats.findIndex(s => s.openid === null)
  if (emptyIndex === -1) return { code: 400, msg: '房间已满' }

  // 校验积分
  const userRes = await db.collection('users').where({ _openid: openid }).get()
  if (userRes.data.length === 0) return { code: 404, msg: '用户不存在' }
  const user = userRes.data[0]
  const requiredPoints = Math.ceil(room.config.buyInChips * room.config.pointsPerChip)
  if (user.points < requiredPoints) {
    return { code: 400, msg: `积分不足，入座需要 ${requiredPoints} 积分` }
  }

  const now = db.serverDate()
  const seatUpdate = {}
  seatUpdate[`seats.${emptyIndex}.openid`] = openid
  seatUpdate[`seats.${emptyIndex}.nickname`] = user.nickname
  seatUpdate[`seats.${emptyIndex}.avatar`] = user.avatar
  seatUpdate[`seats.${emptyIndex}.status`] = 'waiting'
  seatUpdate[`seats.${emptyIndex}.isReady`] = false
  seatUpdate[`seats.${emptyIndex}.lastSeen`] = now
  seatUpdate.lastActivityAt = now

  await db.collection('rooms').doc(room._id).update({ data: seatUpdate })

  // 同步 room_views
  const viewUpdate = {}
  viewUpdate[`seats.${emptyIndex}.openid`] = openid
  viewUpdate[`seats.${emptyIndex}.nickname`] = user.nickname
  viewUpdate[`seats.${emptyIndex}.avatar`] = user.avatar
  viewUpdate[`seats.${emptyIndex}.status`] = 'waiting'
  viewUpdate.updatedAt = now
  await db.collection('room_views').doc(room._id).update({ data: viewUpdate })

  return { code: 0, data: { roomId: room._id, roomCode } }
}

async function leaveRoom(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  const seatIndex = room.seats.findIndex(s => s.openid === openid)
  if (seatIndex === -1) return { code: 400, msg: '您不在此房间' }

  // 若游戏中，需要先结算（简化：直接按当前筹码结算）
  if (room.status === 'playing') {
    // 触发即时结算逻辑（调用 game-action 的 fold + 离桌处理）
    // 简化处理：在 game-action 中处理离桌
    return { code: 400, msg: '游戏中请先弃牌再离桌' }
  }

  const now = db.serverDate()
  const seatClear = {}
  seatClear[`seats.${seatIndex}.openid`] = null
  seatClear[`seats.${seatIndex}.nickname`] = null
  seatClear[`seats.${seatIndex}.avatar`] = null
  seatClear[`seats.${seatIndex}.status`] = 'waiting'
  seatClear[`seats.${seatIndex}.isReady`] = false
  seatClear[`seats.${seatIndex}.chips`] = 0
  seatClear[`seats.${seatIndex}.lastSeen`] = null
  seatClear.lastActivityAt = now

  await db.collection('rooms').doc(roomId).update({ data: seatClear })

  const viewClear = {}
  viewClear[`seats.${seatIndex}.openid`] = null
  viewClear[`seats.${seatIndex}.nickname`] = null
  viewClear[`seats.${seatIndex}.avatar`] = null
  viewClear[`seats.${seatIndex}.status`] = 'waiting'
  viewClear[`seats.${seatIndex}.chips`] = 0
  viewClear.updatedAt = now
  await db.collection('room_views').doc(roomId).update({ data: viewClear })

  return { code: 0 }
}

async function kickPlayer(openid, event) {
  const { roomId, targetOpenid } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }
  if (room.hostOpenid !== openid) return { code: 403, msg: '只有房主可以踢人' }
  if (room.status === 'playing') return { code: 400, msg: '游戏中无法踢人' }

  return leaveRoom(targetOpenid, { roomId })
}

async function dismissRoom(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }
  if (room.hostOpenid !== openid) return { code: 403, msg: '只有房主可以解散房间' }

  const now = db.serverDate()
  await db.collection('rooms').doc(roomId).update({
    data: { status: 'dismissed', dismissedAt: now, lastActivityAt: now },
  })
  await db.collection('room_views').doc(roomId).update({
    data: { phase: 'dismissed', updatedAt: now },
  })

  return { code: 0 }
}

async function setReady(openid, event) {
  const { roomId, isReady } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  const seatIndex = room.seats.findIndex(s => s.openid === openid)
  if (seatIndex === -1) return { code: 400, msg: '您不在此房间' }

  const now = db.serverDate()
  const update = {}
  update[`seats.${seatIndex}.isReady`] = isReady !== false
  update.lastActivityAt = now

  await db.collection('rooms').doc(roomId).update({ data: update })

  // 同步更新 room_views 座位准备状态
  const viewUpdate = {}
  viewUpdate[`seats.${seatIndex}.status`] = isReady !== false ? 'ready' : 'waiting'
  viewUpdate.updatedAt = now
  await db.collection('room_views').doc(roomId).update({ data: viewUpdate })

  return { code: 0 }
}

async function startGame(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }
  if (room.hostOpenid !== openid) return { code: 403, msg: '只有房主可以开始游戏' }
  if (room.status !== 'waiting') return { code: 400, msg: '房间状态不正确' }

  const activePlayers = room.seats.filter(s => s.openid !== null)
  if (activePlayers.length < 2) return { code: 400, msg: '至少需要2名玩家' }

  const notReady = activePlayers.filter(s => !s.isReady && s.openid !== openid)
  if (notReady.length > 0) return { code: 400, msg: '还有玩家未准备' }

  // 游戏开始前把 buyInChips 写入所有座位，作为本局初始筹码基准
  const { buyInChips } = room.config
  const now = db.serverDate()
  const chipsInit = {}
  room.seats.forEach((seat, i) => {
    if (seat.openid) {
      chipsInit[`seats.${i}.chips`] = buyInChips
      chipsInit[`seats.${i}.initialChips`] = buyInChips
    }
  })
  await db.collection('rooms').doc(roomId).update({ data: { ...chipsInit, lastActivityAt: now } })

  // 调用 game-engine 初始化牌局
  const result = await cloud.callFunction({
    name: 'game-engine',
    data: { action: 'initRound', roomId },
  })

  return result.result
}

async function endGame(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }
  if (room.hostOpenid !== openid) return { code: 403, msg: '只有房主可以结束游戏' }

  // 调用 settlement 做积分换算并标记房间结束
  const result = await cloud.callFunction({
    name: 'settlement',
    data: { action: 'settle', roomId },
  })
  return result.result
}

async function pauseGame(openid, event) {
  const { roomId } = event

  // 读取当前 actionDeadline，计算并保存剩余秒数
  const viewRes = await db.collection('room_views').doc(roomId).get()
  const view = viewRes.data
  if (!view) return { code: 404, msg: '房间不存在' }

  let pausedRemaining = null
  if (view.actionDeadline) {
    const remaining = Math.max(0, Math.ceil((new Date(view.actionDeadline).getTime() - Date.now()) / 1000))
    pausedRemaining = remaining
  }

  await db.collection('room_views').doc(roomId).update({
    data: { isPaused: true, pausedBy: openid, pausedRemaining, updatedAt: db.serverDate() },
  })
  return { code: 0 }
}

async function resumeGame(openid, event) {
  const { roomId } = event
  const viewRes = await db.collection('room_views').doc(roomId).get()
  const view = viewRes.data
  if (!view) return { code: 404, msg: '房间不存在' }
  if (view.pausedBy && view.pausedBy !== openid) {
    return { code: 403, msg: '只有发起暂停的玩家可以解除' }
  }

  const updates = { isPaused: false, pausedBy: null, pausedRemaining: null, updatedAt: db.serverDate() }

  // 用暂停时保存的剩余秒数重新设置 deadline（基于服务端当前时间）
  if (view.pausedRemaining != null && view.pausedRemaining > 0 && view.gameRoundId) {
    try {
      const newDeadline = new Date(Date.now() + view.pausedRemaining * 1000)
      const roundRes = await db.collection('game_rounds').doc(view.gameRoundId).get()
      const round = roundRes.data
      if (round && round.phase !== 'ended') {
        await db.collection('game_rounds').doc(view.gameRoundId).update({
          data: { actionDeadline: newDeadline },
        })
        updates.actionDeadline = newDeadline
      }
    } catch (e) {
      console.error('恢复 actionDeadline 失败', e)
    }
  }

  await db.collection('room_views').doc(roomId).update({ data: updates })
  return { code: 0 }
}

async function getRoomInfo(event) {
  const { roomId, roomCode } = event
  try {
    let query
    if (roomId) {
      query = db.collection('rooms').doc(roomId).get()
    } else {
      query = db.collection('rooms').where({ roomCode }).get()
    }
    const res = await query
    const room = roomId ? res.data : res.data[0]
    if (!room) return { code: 404, msg: '房间不存在' }
    return { code: 0, data: room }
  } catch (e) {
    return { code: 500, msg: e.message }
  }
}
