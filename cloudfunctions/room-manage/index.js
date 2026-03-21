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
    case 'sitDown': return sitDown(OPENID, event)
    case 'standUp': return standUp(OPENID, event)
    case 'cancelStandUp': return cancelStandUp(OPENID, event)
    case 'heartbeat': return heartbeat(OPENID, event)
    case 'cleanRooms': return cleanEmptyRooms().then(() => ({ code: 0 }))
    case 'getRoomInfo': return getRoomInfo(event)
    case 'listPublicRooms': return listPublicRooms()
    default: return { code: 400, msg: '未知操作' }
  }
}

async function createRoom(openid, event) {
  const { config, isPublic = true } = event
  const { smallBlind = 10, maxPlayers = 6, buyInChips = 1000, pointsPerChip = 0.01, pointsIn, chipsOut, actionTimeoutSec = 30 } = config || {}

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
    isPublic: isPublic !== false,
    config: {
      smallBlind,
      bigBlind: smallBlind * 2,
      maxPlayers,
      buyInChips,
      pointsPerChip,
      pointsIn: pointsIn || Math.round(pointsPerChip * 1000),
      chipsOut: chipsOut || 1000,
      actionTimeoutSec,
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

  // 异步清理无人空房间（不阻塞创建流程）
  cleanEmptyRooms().catch(e => console.error('cleanEmptyRooms error', e))

  return { code: 0, data: { roomId, roomCode } }
}

// 清理无人的非准备中房间
// 条件：status 为 playing/game_over/dismissed，且所有座位玩家都已掉线（lastSeen 超过5分钟）或座位为空
async function cleanEmptyRooms() {
  const STALE_MS = 5 * 60 * 1000  // 5分钟无心跳视为彻底离线
  const now = Date.now()

  const roomsRes = await db.collection('rooms')
    .where({ status: _.in(['waiting', 'playing', 'game_over', 'dismissed']) })
    .limit(50)
    .get()

  for (const room of roomsRes.data) {
    const seats = room.seats || []
    const spectators = room.spectators || []

    // 判断是否有"活跃"玩家：有 openid 且 lastSeen 在5分钟内
    const hasActivePlayer = seats.some(s => {
      if (!s.openid) return false
      if (!s.lastSeen) return true  // 没有 lastSeen 记录，保守认为还在
      return (now - new Date(s.lastSeen).getTime()) < STALE_MS
    })
    const hasSpectators = spectators.length > 0

    if (hasActivePlayer || hasSpectators) continue  // 还有活跃用户，跳过

    // 等待中超过24小时的房间强制删除（无论是否有活跃玩家）
    const isStaleWaiting = room.status === 'waiting' &&
      room.createdAt &&
      (now - new Date(room.createdAt).getTime()) > 24 * 60 * 60 * 1000

    if (isStaleWaiting) {
      await Promise.all([
        db.collection('rooms').doc(room._id).remove(),
        db.collection('room_views').doc(room._id).remove().catch(() => {}),
      ])
      continue
    }

    if (room.status === 'waiting') {
      // 等待中无人：直接删除，无需结算
      await Promise.all([
        db.collection('rooms').doc(room._id).remove(),
        db.collection('room_views').doc(room._id).remove().catch(() => {}),
      ])
    } else if (room.status === 'playing') {
      // 游戏进行中无人：先结算再删除
      try {
        await cloud.callFunction({
          name: 'settlement',
          data: { action: 'settle', roomId: room._id },
        })
      } catch (e) {
        console.error('cleanEmptyRooms settle error', room._id, e)
      }
      await Promise.all([
        db.collection('rooms').doc(room._id).remove(),
        db.collection('room_views').doc(room._id).remove().catch(() => {}),
      ])
    } else if (room.status === 'game_over') {
      // 已正常结算完毕：直接删除
      await Promise.all([
        db.collection('rooms').doc(room._id).remove(),
        db.collection('room_views').doc(room._id).remove().catch(() => {}),
      ])
    } else {
      // dismissed：直接删除
      await Promise.all([
        db.collection('rooms').doc(room._id).remove(),
        db.collection('room_views').doc(room._id).remove().catch(() => {}),
      ])
    }
  }
}

async function joinRoom(openid, event) {
  const { roomCode } = event

  // 支持 waiting 和 playing 状态加入
  const roomRes = await db.collection('rooms')
    .where({ roomCode, status: _.in(['waiting', 'playing']) })
    .get()
  if (roomRes.data.length === 0) return { code: 404, msg: '房间不存在' }
  const room = roomRes.data[0]

  // 检查是否已在座位
  if (room.seats.some(s => s.openid === openid)) {
    return { code: 0, data: { roomId: room._id, roomCode, isSpectator: false } }
  }

  // 检查是否已在观战列表
  const spectators = room.spectators || []
  if (spectators.some(s => s.openid === openid)) {
    return { code: 0, data: { roomId: room._id, roomCode, isSpectator: true } }
  }

  // 获取用户信息
  const userRes = await db.collection('users').where({ _openid: openid }).get()
  if (userRes.data.length === 0) return { code: 404, msg: '用户不存在' }
  const user = userRes.data[0]

  const now = db.serverDate()

  // 游戏进行中：加入观战
  if (room.status === 'playing') {
    const newSpectator = { openid, nickname: user.nickname, avatar: user.avatar }
    await db.collection('rooms').doc(room._id).update({
      data: { spectators: _.push(newSpectator), lastActivityAt: now },
    })
    await db.collection('room_views').doc(room._id).update({
      data: { spectators: _.push(newSpectator), updatedAt: now },
    })
    return { code: 0, data: { roomId: room._id, roomCode, isSpectator: true } }
  }

  // 等待中：找空位入座
  const emptyIndex = room.seats.findIndex(s => s.openid === null)
  if (emptyIndex === -1) return { code: 400, msg: '房间已满' }

  const requiredPoints = Math.ceil(room.config.buyInChips * room.config.pointsPerChip)
  if (user.points < requiredPoints) {
    return { code: 400, msg: `积分不足，入座需要 ${requiredPoints} 积分` }
  }

  const seatUpdate = {}
  seatUpdate[`seats.${emptyIndex}.openid`] = openid
  seatUpdate[`seats.${emptyIndex}.nickname`] = user.nickname
  seatUpdate[`seats.${emptyIndex}.avatar`] = user.avatar
  seatUpdate[`seats.${emptyIndex}.status`] = 'waiting'
  seatUpdate[`seats.${emptyIndex}.isReady`] = false
  seatUpdate[`seats.${emptyIndex}.lastSeen`] = now
  seatUpdate.lastActivityAt = now

  await db.collection('rooms').doc(room._id).update({ data: seatUpdate })

  const viewUpdate = {}
  viewUpdate[`seats.${emptyIndex}.openid`] = openid
  viewUpdate[`seats.${emptyIndex}.nickname`] = user.nickname
  viewUpdate[`seats.${emptyIndex}.avatar`] = user.avatar
  viewUpdate[`seats.${emptyIndex}.status`] = 'waiting'
  viewUpdate.updatedAt = now
  await db.collection('room_views').doc(room._id).update({ data: viewUpdate })

  return { code: 0, data: { roomId: room._id, roomCode, isSpectator: false } }
}

async function leaveRoom(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  // 检查是否为观战者
  const spectators = room.spectators || []
  const spectatorIdx = spectators.findIndex(s => s.openid === openid)
  if (spectatorIdx !== -1) {
    const now = db.serverDate()
    const newSpectators = spectators.filter(s => s.openid !== openid)
    await db.collection('rooms').doc(roomId).update({ data: { spectators: newSpectators, lastActivityAt: now } })
    await db.collection('room_views').doc(roomId).update({ data: { spectators: newSpectators, updatedAt: now } })
    return { code: 0 }
  }

  const seatIndex = room.seats.findIndex(s => s.openid === openid)
  if (seatIndex === -1) return { code: 400, msg: '您不在此房间' }

  // 游戏中不允许直接离座
  if (room.status === 'playing') {
    return { code: 400, msg: '游戏中请先点击起立，本手结束后自动离座' }
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

  // 先广播结算中状态，所有玩家立即看到遮罩
  await db.collection('room_views').doc(roomId).update({
    data: { isSettling: true, updatedAt: db.serverDate() },
  })

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

async function sitDown(openid, event) {
  const { roomId, seatIndex } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  // 校验是观战者
  const spectators = room.spectators || []
  if (!spectators.some(s => s.openid === openid)) {
    return { code: 403, msg: '您不是观战者' }
  }

  // 校验目标座位为空
  const seat = room.seats[seatIndex]
  if (!seat || seat.openid !== null) return { code: 400, msg: '该座位已有人' }

  // 校验积分
  const userRes = await db.collection('users').where({ _openid: openid }).get()
  if (userRes.data.length === 0) return { code: 404, msg: '用户不存在' }
  const user = userRes.data[0]
  const requiredPoints = Math.ceil(room.config.buyInChips * room.config.pointsPerChip)
  if (user.points < requiredPoints) {
    return { code: 400, msg: `积分不足，入座需要 ${requiredPoints} 积分` }
  }

  const now = db.serverDate()
  const spectatorData = spectators.find(s => s.openid === openid) || {}
  const newSpectators = spectators.filter(s => s.openid !== openid)

  // 恢复筹码：若观战者之前起立时保留了筹码则恢复，否则 chips=0 等 initRound 自动补充
  const restoredChips = spectatorData.chips || 0
  const restoredInitialChips = spectatorData.initialChips || 0
  const restoredRefillCost = spectatorData.totalRefillCost || 0

  const seatUpdate = {
    spectators: newSpectators,
    lastActivityAt: now,
  }
  seatUpdate[`seats.${seatIndex}.openid`] = openid
  seatUpdate[`seats.${seatIndex}.nickname`] = user.nickname
  seatUpdate[`seats.${seatIndex}.avatar`] = user.avatar
  seatUpdate[`seats.${seatIndex}.chips`] = restoredChips
  seatUpdate[`seats.${seatIndex}.initialChips`] = restoredInitialChips
  seatUpdate[`seats.${seatIndex}.totalRefillCost`] = restoredRefillCost
  seatUpdate[`seats.${seatIndex}.status`] = 'waiting'
  seatUpdate[`seats.${seatIndex}.isReady`] = false
  seatUpdate[`seats.${seatIndex}.pendingAction`] = null

  await db.collection('rooms').doc(roomId).update({ data: seatUpdate })

  const viewUpdate = { spectators: newSpectators, updatedAt: now }
  viewUpdate[`seats.${seatIndex}.openid`] = openid
  viewUpdate[`seats.${seatIndex}.nickname`] = user.nickname
  viewUpdate[`seats.${seatIndex}.avatar`] = user.avatar
  viewUpdate[`seats.${seatIndex}.chips`] = restoredChips
  viewUpdate[`seats.${seatIndex}.totalRefillCost`] = restoredRefillCost
  viewUpdate[`seats.${seatIndex}.status`] = 'waiting'
  await db.collection('room_views').doc(roomId).update({ data: viewUpdate })

  return { code: 0 }
}

async function standUp(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  const seatIndex = room.seats.findIndex(s => s.openid === openid)
  if (seatIndex === -1) return { code: 400, msg: '您未在座位上' }

  const now = db.serverDate()

  if (room.status !== 'playing') {
    // 等待中直接离座
    return leaveRoom(openid, event)
  }

  const seat = room.seats[seatIndex]

  // 坐下但未参与本手（chips=0，即 sitDown 后还没有 initRound）：直接立即起立
  if ((seat.chips || 0) === 0) {
    const spectators = room.spectators || []
    const newSpectators = [...spectators, { openid: seat.openid, nickname: seat.nickname, avatar: seat.avatar, chips: 0, initialChips: 0, totalRefillCost: 0 }]
    const clearUpdate = {
      spectators: newSpectators,
      lastActivityAt: now,
    }
    clearUpdate[`seats.${seatIndex}.openid`] = null
    clearUpdate[`seats.${seatIndex}.nickname`] = null
    clearUpdate[`seats.${seatIndex}.avatar`] = null
    clearUpdate[`seats.${seatIndex}.chips`] = 0
    clearUpdate[`seats.${seatIndex}.initialChips`] = 0
    clearUpdate[`seats.${seatIndex}.totalRefillCost`] = 0
    clearUpdate[`seats.${seatIndex}.status`] = 'waiting'
    clearUpdate[`seats.${seatIndex}.isReady`] = false
    clearUpdate[`seats.${seatIndex}.pendingAction`] = null
    await db.collection('rooms').doc(roomId).update({ data: clearUpdate })

    const viewClear = { spectators: newSpectators, updatedAt: now }
    viewClear[`seats.${seatIndex}.openid`] = null
    viewClear[`seats.${seatIndex}.nickname`] = null
    viewClear[`seats.${seatIndex}.avatar`] = null
    viewClear[`seats.${seatIndex}.chips`] = 0
    viewClear[`seats.${seatIndex}.status`] = 'empty'
    viewClear[`seats.${seatIndex}.pendingAction`] = null
    await db.collection('room_views').doc(roomId).update({ data: viewClear })
    return { code: 0 }
  }

  // 游戏中且已参与本手：标记 pendingAction = 'stand'，本手结束后处理
  const update = {}
  update[`seats.${seatIndex}.pendingAction`] = 'stand'
  update.lastActivityAt = now
  await db.collection('rooms').doc(roomId).update({ data: update })

  const viewUpdate = {}
  viewUpdate[`seats.${seatIndex}.pendingAction`] = 'stand'
  viewUpdate.updatedAt = now
  await db.collection('room_views').doc(roomId).update({ data: viewUpdate })

  return { code: 0 }
}

async function heartbeat(openid, event) {
  const { roomId } = event
  try {
    const roomRes = await db.collection('rooms').doc(roomId).get()
    const room = roomRes.data
    if (!room) return { code: 0 }
    const seatIndex = room.seats.findIndex(s => s.openid === openid)
    if (seatIndex === -1) return { code: 0 }
    const update = {}
    update[`seats.${seatIndex}.lastSeen`] = db.serverDate()
    await db.collection('rooms').doc(roomId).update({ data: update })
  } catch (e) {}
  return { code: 0 }
}

async function cancelStandUp(openid, event) {
  const { roomId } = event
  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  const seatIndex = room.seats.findIndex(s => s.openid === openid)
  if (seatIndex === -1) return { code: 400, msg: '您未在座位上' }

  const now = db.serverDate()
  const update = {}
  update[`seats.${seatIndex}.pendingAction`] = null
  update.lastActivityAt = now
  await db.collection('rooms').doc(roomId).update({ data: update })

  const viewUpdate = {}
  viewUpdate[`seats.${seatIndex}.pendingAction`] = null
  viewUpdate.updatedAt = now
  await db.collection('room_views').doc(roomId).update({ data: viewUpdate })

  return { code: 0 }
}

async function listPublicRooms() {
  const res = await db.collection('rooms')
    .where({ status: _.in(['waiting', 'playing']), isPublic: true })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()

  const rooms = res.data
    .filter(room => room.seats.some(s => s.openid))
    .map(room => ({
      roomId: room._id,
      roomCode: room.roomCode,
      status: room.status,
      config: {
        smallBlind: room.config.smallBlind,
        buyInChips: room.config.buyInChips,
        maxPlayers: room.config.maxPlayers,
      },
      seats: room.seats.map(s => ({
        seatIndex: s.seatIndex,
        openid: s.openid,
        nickname: s.nickname,
        avatar: s.avatar,
        status: s.status,
      })),
      createdAt: room.createdAt,
    }))

  return { code: 0, data: rooms }
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
