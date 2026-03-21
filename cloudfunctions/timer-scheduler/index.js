// cloudfunctions/timer-scheduler/index.js
// 定时触发器：每分钟执行一次
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000  // 30分钟空置解散
const CARDS_EXPIRE_HOURS = 24
const DISCONNECT_TIMEOUT_MS = 90 * 1000       // 90秒无心跳视为掉线

exports.main = async (event, context) => {
  const now = new Date()

  await Promise.all([
    handleActionTimeouts(now),
    handleDisconnectedPlayers(now),
    dismissIdleRooms(now),
    cleanExpiredCards(now),
  ])

  return { code: 0, timestamp: now.toISOString() }
}

// 1. 操作超时自动弃牌
async function handleActionTimeouts(now) {
  try {
    const roundsRes = await db.collection('game_rounds')
      .where({
        phase: _.nin(['ended', 'showdown']),
        actionDeadline: _.lt(now),
      })
      .limit(20)
      .get()

    for (const round of roundsRes.data) {
      const seatIndex = round.currentActorSeatIndex
      if (seatIndex < 0) continue
      const ps = round.playerStates[seatIndex]
      if (!ps || ps.status !== 'active') continue

      const roomRes = await db.collection('rooms')
        .where({ currentGameRoundId: round._id })
        .get()
      if (roomRes.data.length === 0) continue
      const roomId = roomRes.data[0]._id

      await cloud.callFunction({
        name: 'game-action',
        data: {
          action: 'playerAction',
          playerAction: 'fold',
          roomId,
          gameRoundId: round._id,
          amount: 0,
          _systemCall: true,
          _openid: ps.openid,
        },
      })
    }
  } catch (e) {
    console.error('handleActionTimeouts error', e)
  }
}

// 2. 掉线玩家检测：lastSeen 超过 90s 视为掉线
//    - 游戏中掉线：若轮到该玩家操作，actionDeadline 会触发超时弃牌（上面已处理）
//    - 掉线玩家标记 pendingAction='stand'，本手结束后自动起立
async function handleDisconnectedPlayers(now) {
  try {
    const disconnectTime = new Date(now.getTime() - DISCONNECT_TIMEOUT_MS)

    const roomsRes = await db.collection('rooms')
      .where({ status: 'playing' })
      .limit(20)
      .get()

    for (const room of roomsRes.data) {
      const updates = {}
      const viewUpdates = {}
      let hasUpdate = false

      for (let i = 0; i < room.seats.length; i++) {
        const seat = room.seats[i]
        if (!seat.openid) continue
        if (seat.pendingAction === 'stand') continue  // 已标记，跳过

        // lastSeen 超时视为掉线
        if (seat.lastSeen && new Date(seat.lastSeen) < disconnectTime) {
          updates[`seats.${i}.pendingAction`] = 'stand'
          viewUpdates[`seats.${i}.pendingAction`] = 'stand'
          hasUpdate = true
          console.log(`掉线玩家 ${seat.openid} 标记起立，房间 ${room._id}`)
        }
      }

      if (hasUpdate) {
        updates.lastActivityAt = db.serverDate()
        viewUpdates.updatedAt = db.serverDate()
        await Promise.all([
          db.collection('rooms').doc(room._id).update({ data: updates }),
          db.collection('room_views').doc(room._id).update({ data: viewUpdates }),
        ])
      }
    }
  } catch (e) {
    console.error('handleDisconnectedPlayers error', e)
  }
}

// 3. 空置房间解散
async function dismissIdleRooms(now) {
  try {
    const idleTime = new Date(now.getTime() - ROOM_IDLE_TIMEOUT_MS)
    const roomsRes = await db.collection('rooms')
      .where({
        status: 'waiting',
        lastActivityAt: _.lt(idleTime),
      })
      .limit(20)
      .get()

    for (const room of roomsRes.data) {
      await db.collection('rooms').doc(room._id).update({
        data: { status: 'dismissed', dismissedAt: db.serverDate() },
      })
      await db.collection('room_views').doc(room._id).update({
        data: { phase: 'dismissed', updatedAt: db.serverDate() },
      })
    }
  } catch (e) {
    console.error('dismissIdleRooms error', e)
  }
}

// 4. 清理过期手牌
async function cleanExpiredCards(now) {
  try {
    const expireTime = new Date(now.getTime() - CARDS_EXPIRE_HOURS * 3600 * 1000)
    const cardsRes = await db.collection('my_cards')
      .where({ createdAt: _.lt(expireTime) })
      .limit(50)
      .get()

    for (const card of cardsRes.data) {
      await db.collection('my_cards').doc(card._id).remove()
    }
  } catch (e) {
    console.error('cleanExpiredCards error', e)
  }
}
