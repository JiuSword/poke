// cloudfunctions/queen-game/index.js
// 《女王万岁》对战引擎入口
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const E = require('./lib/engine')
const A = require('./lib/abilities')
const { buildPublicView, buildPrivateView } = require('./views')

exports.main = async (event) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()
  switch (action) {
    case 'rollDice': return rollDice(OPENID, event)
    case 'resolveChoice': return resolveChoice(OPENID, event)
    case 'reposition': return reposition(OPENID, event)
    case 'endTurn': return endTurn(OPENID, event)
    case 'surrender': return surrender(OPENID, event)
    default: return { code: 400, msg: '未知操作' }
  }
}

// 加载房间 + 状态，并校验调用者颜色与回合
async function load(openid, roomId, requireCurrent) {
  const roomRes = await db.collection('queen_rooms').doc(roomId).get().catch(() => null)
  if (!roomRes || !roomRes.data) return { err: { code: 404, msg: '房间不存在' } }
  const room = roomRes.data
  if (room.status !== 'playing') return { err: { code: 400, msg: '对局未进行' } }
  const me = room.players.find(p => p.openid === openid)
  if (!me) return { err: { code: 403, msg: '你不在该对局' } }
  const stateRes = await db.collection('queen_states').doc(room.stateId).get().catch(() => null)
  if (!stateRes || !stateRes.data) return { err: { code: 404, msg: '棋局状态不存在' } }
  const state = stateRes.data
  if (requireCurrent && state.currentPlayerColor !== me.color) {
    return { err: { code: 400, msg: '现在不是你的回合' } }
  }
  return { room, me, state }
}

// 把更新后的 state 写回三集合
async function persist(room, state) {
  state.updatedAt = db.serverDate()
  // 用 set 整体替换状态文档，避免 update 的点路径深度合并在 null/缺失父字段上建子字段报错
  await db.collection('queen_states').doc(room.stateId).set({
    data: stripSystem(state),
  })
  // view 用 _.set 整体替换（而非深度合并），否则 dice/activePosition 变回 null 时再次写子字段会报错
  await db.collection('queen_rooms').doc(room._id).update({
    data: {
      view: _.set(buildPublicView(state)),
      status: state.winnerColor ? 'finished' : 'playing',
      lastActivityAt: db.serverDate(),
    },
  })
  // 重写双方私有视图（位置可能因 reposition/spy 变化），用 set 整体替换
  // 必须显式写入 _openid，否则 queen_private 的读权限(auth.openid==doc._openid)会拦截客户端读取
  for (const p of room.players) {
    const priv = buildPrivateView(state, p.color)
    const r = await db.collection('queen_private').where({ roomId: room._id, _openid: p.openid }).get()
    const data = { _openid: p.openid, roomId: room._id, myColor: p.color, ...priv, updatedAt: db.serverDate() }
    if (r.data.length > 0) {
      await db.collection('queen_private').doc(r.data[0]._id).set({ data })
    } else {
      await db.collection('queen_private').add({ data })
    }
  }
}

// 移除运行期临时字段不写库（pendingActivations/pendingFaceUps 需保留以支持跨调用决策）
function stripSystem(state) {
  const s = { ...state }
  delete s._id
  return s
}

async function rollDice(openid, event) {
  const { roomId } = event
  const ld = await load(openid, roomId, true)
  if (ld.err) return ld.err
  const { room, state } = ld
  if (state.phase !== 'await_roll') return { code: 400, msg: '当前不能掷骰' }

  const a = 1 + Math.floor(Math.random() * 6)
  const b = 1 + Math.floor(Math.random() * 6)
  const sum = a + b
  state.dice = { a, b, sum }
  E.log(state, `${E.colorName(state.currentPlayerColor)}方掷出 ${a}+${b}=${sum}，激活位置 ${sum}`)
  state.phase = 'resolving'
  state.pendingChoices = []
  state._choiceSeq = 0

  A.activatePosition(state, sum)

  await persist(room, state)
  return { code: 0, data: { dice: state.dice } }
}

async function resolveChoice(openid, event) {
  const { roomId, choiceId, payload } = event
  // 决策的 owner 可能是非当前回合方（case B：双方同位置正面牌都激活），故不强制当前回合
  const ld = await load(openid, roomId, false)
  if (ld.err) return ld.err
  const { room, me, state } = ld
  const res = A.resolveChoice(state, me.color, choiceId, payload || {})
  if (!res.ok) return { code: 400, msg: res.msg }
  await persist(room, state)
  return { code: 0 }
}

async function reposition(openid, event) {
  const { roomId, mode, payload } = event
  const ld = await load(openid, roomId, true)
  if (ld.err) return ld.err
  const { room, me, state } = ld
  if (state.phase !== 'reposition') return { code: 400, msg: '当前不是布置阶段' }
  if (!state.canReposition) return { code: 400, msg: '先手首回合不可布置' }
  const color = me.color

  if (mode === 'swap') {
    const valid = A.adjacentSwapPairs(state, color).some(p => p[0] === payload.pair[0] && p[1] === payload.pair[1])
    if (!valid) return { code: 400, msg: '非法相邻对' }
    A.swapTiles(state, color, payload.pair[0], payload.pair[1])
    E.log(state, `${E.colorName(color)}方布置：交换位置${payload.pair[0]}与${payload.pair[1]}`)
  } else if (mode === 'changeMaster') {
    const pos = payload.pos
    const tile = state.board[pos] && state.board[pos][color]
    if (!tile || !tile.faceUp) return { code: 400, msg: '该位置无正面牌' }
    const banned = ['GAMBLER', 'PRINCESS', 'RECRUIT', 'GUARD']
    if (banned.includes(tile.role)) return { code: 400, msg: '该角色不可担任主谋' }
    const oldMaster = state.masters[color]
    // 旧主谋正面放入新主谋原位置；新牌成为主谋（背面放置）
    state.board[pos][color] = { role: oldMaster.role, faceUp: true }
    state.masters[color] = { role: tile.role, faceUp: false }
    E.log(state, `${E.colorName(color)}方更换主谋为${E.CHARACTERS[tile.role].name}`)
  } else {
    return { code: 400, msg: '未知布置方式' }
  }

  state.canReposition = false // 每回合仅一次布置
  await persist(room, state)
  return { code: 0 }
}

async function endTurn(openid, event) {
  const { roomId } = event
  const ld = await load(openid, roomId, true)
  if (ld.err) return ld.err
  const { room, state } = ld
  if (state.phase !== 'reposition') return { code: 400, msg: '当前不能结束回合' }

  // 标记先手首回合已过
  if (state.currentPlayerColor === state.starterColor) state.firstTurnDone = true

  state.currentPlayerColor = E.opp(state.currentPlayerColor)
  state.turnCount = (state.turnCount || 1) + 1
  state.phase = 'await_roll'
  state.dice = null
  state.activePosition = null
  state.pendingChoices = []
  state.canReposition = false
  E.log(state, `轮到${E.colorName(state.currentPlayerColor)}方`)

  await persist(room, state)
  return { code: 0 }
}

async function surrender(openid, event) {
  const { roomId } = event
  const ld = await load(openid, roomId, false)
  if (ld.err) return ld.err
  const { room, me, state } = ld
  if (state.winnerColor) return { code: 0 }
  state.winnerColor = E.opp(me.color)
  state.phase = 'finished'
  E.log(state, `${E.colorName(me.color)}方认输，${E.colorName(state.winnerColor)}方获胜`)
  await persist(room, state)
  return { code: 0 }
}
