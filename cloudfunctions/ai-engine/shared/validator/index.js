// shared/validator/index.js
// 操作合法性校验

/**
 * 校验玩家操作是否合法
 * @param {Object} gameRound 当前牌局文档
 * @param {string} openid 操作者 openid
 * @param {string} action fold|check|call|raise|allin
 * @param {number} amount 操作金额
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAction(gameRound, openid, action, amount) {
  const { phase, currentActorSeatIndex, playerStates, currentBet, minRaise } = gameRound

  if (phase === 'ended' || phase === 'showdown') {
    return { valid: false, error: '牌局已结束' }
  }

  const actorState = playerStates[currentActorSeatIndex]
  if (!actorState || actorState.openid !== openid) {
    return { valid: false, error: '不是您的操作回合' }
  }

  if (actorState.status === 'folded' || actorState.status === 'allin') {
    return { valid: false, error: '您已弃牌或全押' }
  }

  const playerChips = actorState.chips
  const playerBetInPhase = actorState.betInPhase

  switch (action) {
    case 'fold':
      return { valid: true }

    case 'check':
      if (currentBet > playerBetInPhase) {
        return { valid: false, error: `需要跟注 ${currentBet - playerBetInPhase} 筹码，不能过牌` }
      }
      return { valid: true }

    case 'call': {
      const callAmount = currentBet - playerBetInPhase
      if (callAmount <= 0) {
        return { valid: false, error: '无需跟注，请选择过牌' }
      }
      if (playerChips <= 0) {
        return { valid: false, error: '筹码不足' }
      }
      return { valid: true }
    }

    case 'raise': {
      const callAmount = currentBet - playerBetInPhase
      const totalNeeded = callAmount + (amount || 0)
      if (!amount || amount < minRaise) {
        return { valid: false, error: `加注额不能少于 ${minRaise}` }
      }
      if (totalNeeded > playerChips) {
        return { valid: false, error: '筹码不足，请选择全押' }
      }
      return { valid: true }
    }

    case 'allin':
      if (playerChips <= 0) {
        return { valid: false, error: '筹码为0，无法全押' }
      }
      return { valid: true }

    default:
      return { valid: false, error: `未知操作: ${action}` }
  }
}

/**
 * 检查当前阶段是否所有玩家行动完毕（可以进入下一阶段）
 */
function isPhaseComplete(playerStates, currentBet) {
  const activePlayers = playerStates.filter(
    p => p.status === 'active'
  )
  if (activePlayers.length === 0) return true

  // 所有 active 玩家的 betInPhase 都等于 currentBet，且都行动过（hasActed）
  return activePlayers.every(p => p.betInPhase === currentBet && p.hasActed)
}

/**
 * 检查牌局是否结束（只剩一人未弃牌，或所有人行动完且到了showdown）
 */
function isRoundOver(playerStates) {
  const notFolded = playerStates.filter(
    p => p.status !== 'folded' && p.status !== 'out'
  )
  return notFolded.length <= 1
}

/**
 * 获取下一个需要行动的座位索引
 */
function getNextActorIndex(playerStates, currentIndex) {
  const total = playerStates.length
  for (let i = 1; i < total; i++) {
    const idx = (currentIndex + i) % total
    const p = playerStates[idx]
    if (p && p.status === 'active') {
      return idx
    }
  }
  return -1 // 没有其他人需要行动
}

module.exports = { validateAction, isPhaseComplete, isRoundOver, getNextActorIndex }
