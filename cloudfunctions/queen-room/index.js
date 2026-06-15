// cloudfunctions/queen-room/index.js
// 《女王万岁》双人桌游 —— 房间管理
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const { dealForColor } = require('./rules')
const { buildPublicView, buildPrivateView, COLORS } = require('./views')

exports.main = async (event) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  switch (action) {
    case 'createRoom': return createRoom(OPENID)
    case 'joinRoom': return joinRoom(OPENID, event)
    case 'leaveRoom': return leaveRoom(OPENID, event)
    case 'setReady': return setReady(OPENID, event)
    case 'startGame': return startGame(OPENID, event)
    case 'dismissRoom': return dismissRoom(OPENID, event)
    case 'getRoomInfo': return getRoomInfo(event)
    case 'listPublicRooms': return listPublicRooms()
    case 'heartbeat': return heartbeat(OPENID, event)
    default: return { code: 400, msg: '未知操作' }
  }
}

async function getUser(openid) {
  const res = await db.collection('users').where({ _openid: openid }).get()
  return res.data[0] || null
}

async function createRoom(openid) {
  const user = await getUser(openid)
  if (!user) return { code: 404, msg: '用户不存在' }

  // 生成唯一 6 位房间号
  let roomCode, exists = true
  while (exists) {
    roomCode = String(Math.floor(100000 + Math.random() * 900000))
    const check = await db.collection('queen_rooms').where({ roomCode, status: _.neq('dismissed') }).count()
    exists = check.total > 0
  }

  const now = db.serverDate()
  // 房主随机分到 white/black
  const hostColor = Math.random() < 0.5 ? 'white' : 'black'
  const roomData = {
    roomCode,
    hostOpenid: openid,
    status: 'waiting',
    isPublic: true,
    players: [
      {
        openid,
        nickname: user.nickname,
        avatar: user.avatar,
        color: hostColor,
        isReady: true,   // 房主默认已准备
        lastSeen: now,
      },
    ],
    view: null,
    stateId: null,
    createdAt: now,
    lastActivityAt: now,
  }
  const addRes = await db.collection('queen_rooms').add({ data: roomData })
  cleanEmptyRooms().catch(() => {})
  return { code: 0, data: { roomId: addRes._id, roomCode } }
}

async function joinRoom(openid, event) {
  const { roomCode } = event
  const user = await getUser(openid)
  if (!user) return { code: 404, msg: '用户不存在' }

  const res = await db.collection('queen_rooms').where({ roomCode, status: 'waiting' }).get()
  if (res.data.length === 0) return { code: 404, msg: '房间不存在或已开始' }
  const room = res.data[0]

  // 已在房内则直接返回
  if (room.players.some(p => p.openid === openid)) {
    return { code: 0, data: { roomId: room._id, roomCode } }
  }
  if (room.players.length >= 2) return { code: 400, msg: '房间已满' }

  const hostColor = room.players[0].color
  const myColor = hostColor === 'white' ? 'black' : 'white'
  const now = db.serverDate()
  await db.collection('queen_rooms').doc(room._id).update({
    data: {
      players: _.push([{
        openid,
        nickname: user.nickname,
        avatar: user.avatar,
        color: myColor,
        isReady: false,
        lastSeen: now,
      }]),
      lastActivityAt: now,
    },
  })
  return { code: 0, data: { roomId: room._id, roomCode } }
}

async function leaveRoom(openid, event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 0 }
  const room = res.data
  // 房主离开或对局未开始 → 解散
  if (room.hostOpenid === openid || room.status === 'waiting') {
    await db.collection('queen_rooms').doc(roomId).update({
      data: { status: 'dismissed', lastActivityAt: db.serverDate() },
    })
    return { code: 0 }
  }
  // 非房主、非等待中（理论上不会到这）
  await db.collection('queen_rooms').doc(roomId).update({
    data: { players: room.players.filter(p => p.openid !== openid), lastActivityAt: db.serverDate() },
  })
  return { code: 0 }
}

async function dismissRoom(openid, event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 0 }
  if (res.data.hostOpenid !== openid) return { code: 403, msg: '只有房主可解散' }
  await db.collection('queen_rooms').doc(roomId).update({
    data: { status: 'dismissed', lastActivityAt: db.serverDate() },
  })
  return { code: 0 }
}

async function setReady(openid, event) {
  const { roomId, isReady } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '房间不存在' }
  const room = res.data
  const idx = room.players.findIndex(p => p.openid === openid)
  if (idx === -1) return { code: 400, msg: '您不在房间内' }
  const update = {}
  update[`players.${idx}.isReady`] = !!isReady
  update.lastActivityAt = db.serverDate()
  await db.collection('queen_rooms').doc(roomId).update({ data: update })
  return { code: 0 }
}

async function startGame(openid, event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '房间不存在' }
  const room = res.data
  if (room.hostOpenid !== openid) return { code: 403, msg: '只有房主可开始' }
  if (room.status !== 'waiting') return { code: 400, msg: '对局已开始' }
  if (room.players.length < 2) return { code: 400, msg: '需要两名玩家' }
  if (!room.players.every(p => p.isReady)) return { code: 400, msg: '双方都准备后才能开始' }

  // 发牌：双方各自生成棋盘行
  const dealWhite = dealForColor()
  const dealBlack = dealForColor()
  const board = {}
  for (const pos of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    board[pos] = { white: dealWhite.line[pos], black: dealBlack.line[pos] }
  }
  // 掷骰定先手
  const rollW = rollSum()
  const rollB = rollSum()
  let starterColor = rollW.sum >= rollB.sum ? 'white' : 'black'
  if (rollW.sum === rollB.sum) starterColor = Math.random() < 0.5 ? 'white' : 'black'

  const state = {
    roomId,
    board,
    masters: { white: dealWhite.master, black: dealBlack.master },
    prestige: { white: { r: 0, y: 0, b: 0 }, black: { r: 0, y: 0, b: 0 } },
    currentPlayerColor: starterColor,
    starterColor,
    phase: 'await_roll',       // await_roll → resolving(待决策) → reposition → (传骰)
    dice: null,
    activePosition: null,
    pendingChoices: [],
    canReposition: false,
    log: [`对局开始，${colorName(starterColor)}方先手`],
    winnerColor: null,
    turnCount: 1,
    firstTurnDone: false,      // 先手首回合禁止 reposition
    updatedAt: db.serverDate(),
  }

  const stateAdd = await db.collection('queen_states').add({ data: state })
  const stateId = stateAdd._id

  // 写公开视图到 queen_rooms.view，并落 stateId、置 playing
  // view 用 _.set 整体写入，避免点路径深度合并往 null 父字段建子字段报错
  await db.collection('queen_rooms').doc(roomId).update({
    data: { status: 'playing', stateId, view: _.set(buildPublicView(state)), lastActivityAt: db.serverDate() },
  })

  // 写双方私有视图
  for (const p of room.players) {
    const priv = buildPrivateView(state, p.color)
    await db.collection('queen_private').where({ roomId, _openid: p.openid }).get().then(async r => {
      const data = { roomId, myColor: p.color, ...priv, updatedAt: db.serverDate() }
      if (r.data.length > 0) {
        await db.collection('queen_private').doc(r.data[0]._id).set({ data: { ...data, _openid: p.openid } })
      } else {
        await db.collection('queen_private').add({ data })
      }
    })
  }

  return { code: 0, data: { stateId } }
}

async function getRoomInfo(event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '房间不存在' }
  const r = res.data
  return {
    code: 0,
    data: {
      roomCode: r.roomCode,
      hostOpenid: r.hostOpenid,
      status: r.status,
      players: r.players,
      stateId: r.stateId,
    },
  }
}

async function listPublicRooms() {
  const res = await db.collection('queen_rooms')
    .where({ status: 'waiting', isPublic: true })
    .orderBy('lastActivityAt', 'desc')
    .limit(20)
    .get()
  const rooms = res.data.map(r => ({
    roomId: r._id,
    roomCode: r.roomCode,
    players: r.players.map(p => ({ nickname: p.nickname, avatar: p.avatar })),
    playerCount: r.players.length,
  }))
  return { code: 0, data: rooms }
}

async function heartbeat(openid, event) {
  const { roomId } = event
  try {
    const res = await db.collection('queen_rooms').doc(roomId).get()
    const room = res.data
    if (!room) return { code: 0 }
    const idx = room.players.findIndex(p => p.openid === openid)
    if (idx === -1) return { code: 0 }
    const update = {}
    update[`players.${idx}.lastSeen`] = db.serverDate()
    await db.collection('queen_rooms').doc(roomId).update({ data: update })
  } catch (e) {}
  return { code: 0 }
}

// 清理 1 小时无活动的等待中空房 / 已解散房
async function cleanEmptyRooms() {
  const STALE = new Date(Date.now() - 60 * 60 * 1000)
  await db.collection('queen_rooms')
    .where({ status: 'waiting', lastActivityAt: _.lt(STALE) })
    .update({ data: { status: 'dismissed' } })
    .catch(() => {})
}

function rollSum() {
  const a = 1 + Math.floor(Math.random() * 6)
  const b = 1 + Math.floor(Math.random() * 6)
  return { a, b, sum: a + b }
}

function colorName(c) { return c === 'white' ? '白玫瑰' : '黑玫瑰' }
