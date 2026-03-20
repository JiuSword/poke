// cloudfunctions/timer-scheduler/index.js
// 定时触发器：每分钟执行一次
// 1. 超时玩家自动 Fold
// 2. 空置房间自动解散
// 3. 清理过期 my_cards
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000  // 30分钟
const CARDS_EXPIRE_HOURS = 24

exports.main = async (event, context) => {
  const now = new Date()

  await Promise.all([
    handleActionTimeouts(now),
    dismissIdleRooms(now),
    cleanExpiredCards(now),
  ])

  return { code: 0, timestamp: now.toISOString() }
}

// 处理操作超时：找到 actionDeadline < now 且 phase 非 ended 的牌局
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

      // 获取 roomId
      const roomRes = await db.collection('rooms')
        .where({ currentGameRoundId: round._id })
        .get()
      if (roomRes.data.length === 0) continue
      const roomId = roomRes.data[0]._id

      // 执行自动 Fold
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

// 解散空置超时的等待中房间
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

// 清理过期手牌记录
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
