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
    case 'rejoinRoom': return rejoinRoom(OPENID, event)
    case 'leaveRoom': return leaveRoom(OPENID, event)
    case 'setReady': return setReady(OPENID, event)
    case 'startGame': return startGame(OPENID, event)
    case 'dismissRoom': return dismissRoom(OPENID, event)
    case 'getRoomInfo': return getRoomInfo(event)
    case 'listPublicRooms': return listPublicRooms()
    case 'listMyRooms': return listMyRooms(OPENID)
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
  // 每次创建房间时，清理无人且未开始过的房间（异步，不阻塞）
  cleanStaleRooms().catch(() => {})

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
    memberOpenids: [openid],   // 曾加入过的成员（用于历史房间查询 + 重连）
    view: null,
    stateId: null,
    createdAt: now,
    lastActivityAt: now,
  }
  const addRes = await db.collection('queen_rooms').add({ data: roomData })
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
      memberOpenids: _.addToSet(openid),
      lastActivityAt: now,
    },
  })
  return { code: 0, data: { roomId: room._id, roomCode } }
}

// 重新加入：用于中途退出后通过历史房间继续游戏（房间可能处于 playing）
async function rejoinRoom(openid, event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '房间不存在' }
  const room = res.data
  if (room.status === 'dismissed') return { code: 404, msg: '房间已解散' }
  // 必须是该房间的历史成员
  const isMember = (room.memberOpenids || []).includes(openid) || room.players.some(p => p.openid === openid)
  if (!isMember) return { code: 403, msg: '你不是该房间成员' }

  const now = db.serverDate()
  const idx = room.players.findIndex(p => p.openid === openid)
  if (idx !== -1) {
    // 仍在座，刷新在线时间
    const update = {}
    update[`players.${idx}.lastSeen`] = now
    update.lastActivityAt = now
    await db.collection('queen_rooms').doc(roomId).update({ data: update })
  } else {
    // 不在座（曾离开过），且仍是历史成员 → 重新落座
    if (room.players.length >= 2) return { code: 400, msg: '房间已满' }
    const user = await getUser(openid)
    if (!user) return { code: 404, msg: '用户不存在' }
    // 颜色优先取私有视图里记录的原始颜色（游戏中已分配），否则取空缺一侧
    let myColor = null
    const privRes = await db.collection('queen_private').where({ roomId, _openid: openid }).get().catch(() => null)
    if (privRes && privRes.data && privRes.data.length > 0 && privRes.data[0].myColor) {
      myColor = privRes.data[0].myColor
    } else {
      const takenColor = room.players[0] && room.players[0].color
      myColor = takenColor === 'white' ? 'black' : 'white'
    }
    await db.collection('queen_rooms').doc(roomId).update({
      data: {
        players: _.push([{
          openid, nickname: user.nickname, avatar: user.avatar,
          color: myColor, isReady: room.status === 'playing', lastSeen: now,
        }]),
        memberOpenids: _.addToSet(openid),
        lastActivityAt: now,
      },
    })
  }

  // 返回进入所需信息：等待中回候场厅，游戏中直接进棋盘
  const fresh = await db.collection('queen_rooms').doc(roomId).get()
  const r = fresh.data
  const me = (r.players || []).find(p => p.openid === openid)
  return {
    code: 0,
    data: {
      roomId,
      roomCode: r.roomCode,
      status: r.status,
      isHost: r.hostOpenid === openid,
      myColor: me ? me.color : null,
    },
  }
}

async function leaveRoom(openid, event) {
  const { roomId } = event
  const res = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!res || !res.data) return { code: 0 }
  const room = res.data
  // 对局进行中：不解散房间，保留以便玩家通过历史房间再次加入继续游玩
  if (room.status === 'playing') {
    return { code: 0 }
  }
  // 等待中（未开始）：房主离开或任意人离开都解散这个空壳房
  await db.collection('queen_rooms').doc(roomId).update({
    data: { status: 'dismissed', lastActivityAt: db.serverDate() },
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

  // 写双方私有视图（必须显式写入 _openid，否则读权限会拦截客户端读取）
  for (const p of room.players) {
    const priv = buildPrivateView(state, p.color)
    await db.collection('queen_private').where({ roomId, _openid: p.openid }).get().then(async r => {
      const data = { _openid: p.openid, roomId, myColor: p.color, ...priv, updatedAt: db.serverDate() }
      if (r.data.length > 0) {
        await db.collection('queen_private').doc(r.data[0]._id).set({ data })
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

// 历史房间：我曾加入过、且仍未解散的房间（最近游玩）
async function listMyRooms(openid) {
  const res = await db.collection('queen_rooms')
    .where({
      memberOpenids: openid,
      status: _.in(['waiting', 'playing']),
    })
    .orderBy('lastActivityAt', 'desc')
    .limit(10)
    .get()
  const rooms = res.data.map(r => ({
    roomId: r._id,
    roomCode: r.roomCode,
    status: r.status,
    isHost: r.hostOpenid === openid,
    players: (r.players || []).map(p => ({ nickname: p.nickname, avatar: p.avatar })),
    playerCount: (r.players || []).length,
    winnerColor: r.view ? r.view.winnerColor : null,
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
    update.lastActivityAt = db.serverDate()
    await db.collection('queen_rooms').doc(roomId).update({ data: update })
  } catch (e) {}
  return { code: 0 }
}

// 房间清理（每次创建房间时调用）：
//  1) 从未开始过的房间（status=waiting）若 5 分钟内无人心跳 → 解散；
//  2) 已开始过的房间（status=playing）仅当创建超过 72 小时才解散，
//     否则保留，支持房间内玩家再次加入继续游玩。
async function cleanStaleRooms() {
  const ONLINE_MS = 5 * 60 * 1000          // 5 分钟无心跳视为无人
  const KEEP_PLAYING_MS = 72 * 60 * 60 * 1000  // 进行中房间保留 72 小时
  const now = Date.now()
  const staleWaiting = new Date(now - ONLINE_MS)
  const expirePlaying = new Date(now - KEEP_PLAYING_MS)

  // 1) 未开始过、长时间无活动的房间
  await db.collection('queen_rooms')
    .where({ status: 'waiting', lastActivityAt: _.lt(staleWaiting) })
    .update({ data: { status: 'dismissed' } })
    .catch(() => {})

  // 2) 进行中、创建超过 72 小时的房间
  await db.collection('queen_rooms')
    .where({ status: 'playing', createdAt: _.lt(expirePlaying) })
    .update({ data: { status: 'dismissed' } })
    .catch(() => {})
}

function rollSum() {
  const a = 1 + Math.floor(Math.random() * 6)
  const b = 1 + Math.floor(Math.random() * 6)
  return { a, b, sum: a + b }
}

function colorName(c) { return c === 'white' ? '白玫瑰' : '黑玫瑰' }
