// cloudfunctions/settlement/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { action } = event
  if (action === 'settle') return settle(event)
  return { code: 400, msg: '未知操作' }
}

async function settle(event) {
  const { roomId } = event

  const roomRes = await db.collection('rooms').doc(roomId).get()
  const room = roomRes.data
  if (!room) return { code: 404, msg: '房间不存在' }

  const { pointsPerChip, buyInChips } = room.config
  const players = room.seats.filter(s => s.openid)
  if (players.length === 0) return { code: 0, data: { settlements: [] } }

  // 每人基准筹码 = initialChips（首次 buyInChips，每次补充时累加）
  // chipsDelta = finalChips - initialChips
  // 零和校验：sum(finalChips) 应等于 sum(initialChips)
  const totalInitial = players.reduce((sum, s) => sum + (s.initialChips || buyInChips), 0)
  const totalFinal = players.reduce((sum, s) => sum + (s.chips || 0), 0)

  if (totalFinal !== totalInitial) {
    console.warn(`筹码不守恒: totalInitial=${totalInitial}, totalFinal=${totalFinal}, diff=${totalFinal - totalInitial}`)
  }

  // 计算每人筹码盈亏
  const rawSettlements = players.map(seat => {
    const finalChips = seat.chips || 0
    const initialChips = seat.initialChips || buyInChips
    const chipsDelta = finalChips - initialChips
    return { openid: seat.openid, nickname: seat.nickname, avatar: seat.avatar || '', finalChips, initialChips, chipsDelta }
  })

  // 零和修正：若总 chipsDelta 不为 0，把误差加到赢最多的人身上
  const totalDelta = rawSettlements.reduce((sum, s) => sum + s.chipsDelta, 0)
  if (totalDelta !== 0) {
    const winner = rawSettlements.reduce((a, b) => a.chipsDelta > b.chipsDelta ? a : b)
    winner.chipsDelta -= totalDelta
    winner.finalChips -= totalDelta
    console.warn(`零和修正: ${totalDelta} 从 ${winner.openid} 调整`)
  }

  // 换算积分
  const playerSettlements = rawSettlements.map(s => ({
    ...s,
    pointsDelta: Math.round(s.chipsDelta * pointsPerChip),
  }))

  // 积分零和修正（Math.round 可能引入±1误差）
  const totalPoints = playerSettlements.reduce((sum, s) => sum + s.pointsDelta, 0)
  if (totalPoints !== 0) {
    const winner = playerSettlements.reduce((a, b) => a.pointsDelta > b.pointsDelta ? a : b)
    winner.pointsDelta -= totalPoints
  }

  // 读取用户积分
  const openids = playerSettlements.map(p => p.openid)
  const usersRes = await db.collection('users').where({ _openid: _.in(openids) }).get()
  const usersMap = {}
  for (const u of usersRes.data) usersMap[u._openid] = u

  const now = db.serverDate()

  try {
    await db.runTransaction(async t => {
      for (const s of playerSettlements) {
        const user = usersMap[s.openid]
        if (!user) continue
        const pointsBefore = user.points
        // 积分不足时：扣到0为止，但赢家仍然拿到完整积分（由其他人补足）
        const pointsAfter = Math.max(0, pointsBefore + s.pointsDelta)
        const actualDelta = pointsAfter - pointsBefore

        await t.collection('users').where({ _openid: s.openid }).update({
          data: {
            points: pointsAfter,
            totalGames: _.inc(1),
            updatedAt: now,
            ...(s.pointsDelta > 0 ? { totalWins: _.inc(1) } : {}),
            ...(s.finalChips > (user.maxPotWon || 0) ? { maxPotWon: s.finalChips } : {}),
          },
        })

        await t.collection('point_records').add({
          data: {
            _openid: s.openid,
            roomId,
            roomCode: room.roomCode || '',
            gameRoundId: room.currentGameRoundId || '',
            userId: s.openid,
            chipsStart: s.initialChips,
            chipsEnd: s.finalChips,
            chipsDelta: s.chipsDelta,
            pointsDelta: actualDelta,
            pointsBefore,
            pointsAfter,
            isWinner: s.pointsDelta > 0,
            opponents: playerSettlements
              .filter(o => o.openid !== s.openid)
              .map(o => ({ openid: o.openid, nickname: o.nickname, chipsDelta: o.chipsDelta, pointsDelta: o.pointsDelta })),
            settledAt: now,
            roomConfig: { smallBlind: room.config.smallBlind, buyInChips, pointsPerChip },
          },
        })
      }
    })
  } catch (e) {
    console.error('结算事务失败', e)
    return { code: 500, msg: '结算失败: ' + e.message }
  }

  await Promise.all([
    db.collection('rooms').doc(roomId).update({ data: { status: 'game_over', lastActivityAt: now } }),
    db.collection('room_views').doc(roomId).update({
      data: {
        phase: 'game_over',
        finalSettlements: playerSettlements,  // 供前端直接展示
        updatedAt: now,
      },
    }),
  ])

  return { code: 0, data: { settlements: playerSettlements } }
}
