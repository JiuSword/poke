// shared/poker-logic/index.js
// 德州扑克牌型计算、比较、边池计算

// 牌型等级（越大越强）
const HAND_RANKS = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
}

const HAND_NAMES = {
  1: '高牌',
  2: '一对',
  3: '两对',
  4: '三条',
  5: '顺子',
  6: '同花',
  7: '葫芦',
  8: '四条',
  9: '同花顺',
  10: '皇家同花顺',
}

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
}

/**
 * 解析牌面字符串
 * "As" -> { rank: 'A', suit: 's', value: 14 }
 */
function parseCard(card) {
  return {
    rank: card[0],
    suit: card[1],
    value: RANK_VALUES[card[0]],
  }
}

/**
 * 从 7 张牌中找出最优 5 张组合
 * @param {string[]} cards 7张牌（2张手牌 + 5张公牌）
 * @returns {{ rank: number, name: string, cards: string[], tiebreakers: number[] }}
 */
function evaluateBestHand(cards) {
  const parsed = cards.map(parseCard)
  const combos = getCombinations(parsed, 5)
  let best = null
  for (const combo of combos) {
    const result = evaluateFiveCards(combo)
    if (!best || compareHandResults(result, best) > 0) {
      best = result
    }
  }
  return best
}

/**
 * 评估5张牌的牌型
 */
function evaluateFiveCards(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value)
  const values = sorted.map(c => c.value)
  const suits = sorted.map(c => c.suit)

  const isFlush = suits.every(s => s === suits[0])
  const isStraight = checkStraight(values)
  const counts = getCounts(values)
  const countValues = Object.values(counts).sort((a, b) => b - a)

  let rank, tiebreakers

  if (isFlush && isStraight) {
    if (values[0] === 14 && values[1] === 13) {
      rank = HAND_RANKS.ROYAL_FLUSH
      tiebreakers = [values[0]]
    } else {
      rank = HAND_RANKS.STRAIGHT_FLUSH
      tiebreakers = [isStraight] // 最高牌值
    }
  } else if (countValues[0] === 4) {
    rank = HAND_RANKS.FOUR_OF_A_KIND
    const quad = getGroupByCount(counts, 4)
    const kicker = getGroupByCount(counts, 1)
    tiebreakers = [quad, kicker]
  } else if (countValues[0] === 3 && countValues[1] === 2) {
    rank = HAND_RANKS.FULL_HOUSE
    const triple = getGroupByCount(counts, 3)
    const pair = getGroupByCount(counts, 2)
    tiebreakers = [triple, pair]
  } else if (isFlush) {
    rank = HAND_RANKS.FLUSH
    tiebreakers = values
  } else if (isStraight) {
    rank = HAND_RANKS.STRAIGHT
    tiebreakers = [isStraight]
  } else if (countValues[0] === 3) {
    rank = HAND_RANKS.THREE_OF_A_KIND
    const triple = getGroupByCount(counts, 3)
    const kickers = getKickers(counts, 1, 2)
    tiebreakers = [triple, ...kickers]
  } else if (countValues[0] === 2 && countValues[1] === 2) {
    rank = HAND_RANKS.TWO_PAIR
    const pairs = getGroupsByCount(counts, 2).sort((a, b) => b - a)
    const kicker = getGroupByCount(counts, 1)
    tiebreakers = [...pairs, kicker]
  } else if (countValues[0] === 2) {
    rank = HAND_RANKS.ONE_PAIR
    const pair = getGroupByCount(counts, 2)
    const kickers = getKickers(counts, 1, 3)
    tiebreakers = [pair, ...kickers]
  } else {
    rank = HAND_RANKS.HIGH_CARD
    tiebreakers = values
  }

  return {
    rank,
    name: HAND_NAMES[rank],
    cards: sorted.map(c => c.rank + c.suit),
    tiebreakers,
  }
}

/**
 * 检查是否为顺子，返回最高牌值（或 A-2-3-4-5 的5），否则返回 false
 */
function checkStraight(sortedValues) {
  // A-2-3-4-5 特殊顺子
  if (sortedValues[0] === 14) {
    const low = [5, 4, 3, 2, 1]
    const lowVals = [14, 5, 4, 3, 2]
    if (lowVals.every((v, i) => v === sortedValues[i])) return 5
  }
  for (let i = 0; i < sortedValues.length - 1; i++) {
    if (sortedValues[i] - sortedValues[i + 1] !== 1) return false
  }
  return sortedValues[0]
}

function getCounts(values) {
  const counts = {}
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1
  }
  return counts
}

function getGroupByCount(counts, n) {
  return parseInt(Object.keys(counts).find(k => counts[k] === n))
}

function getGroupsByCount(counts, n) {
  return Object.keys(counts).filter(k => counts[k] === n).map(Number)
}

function getKickers(counts, n, howMany) {
  return Object.keys(counts)
    .filter(k => counts[k] === n)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, howMany)
}

/**
 * 比较两个手牌结果
 * @returns 正数: a > b, 负数: a < b, 0: 平局
 */
function compareHandResults(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank
  for (let i = 0; i < Math.min(a.tiebreakers.length, b.tiebreakers.length); i++) {
    if (a.tiebreakers[i] !== b.tiebreakers[i]) {
      return a.tiebreakers[i] - b.tiebreakers[i]
    }
  }
  return 0
}

/**
 * 从数组中取所有 k 元素组合
 */
function getCombinations(arr, k) {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [first, ...rest] = arr
  const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c])
  const withoutFirst = getCombinations(rest, k)
  return [...withFirst, ...withoutFirst]
}

/**
 * 计算边池
 * @param {Array} playerStates [{ openid, betTotal, status }]
 * @returns {Array} [{ amount, eligibleOpenids }]
 */
function calculateSidePots(playerStates) {
  const active = playerStates.filter(p => p.status !== 'out' && p.betTotal > 0)
  if (active.length === 0) return []

  const pots = []
  const betAmounts = [...new Set(active.map(p => p.betTotal))].sort((a, b) => a - b)

  let prevBet = 0
  for (const bet of betAmounts) {
    const level = bet - prevBet
    const eligible = active.filter(p => p.betTotal >= bet && p.status !== 'folded')
    const contributors = active.filter(p => p.betTotal >= bet)
    const amount = level * contributors.length
    if (amount > 0) {
      pots.push({
        amount,
        eligibleOpenids: eligible.map(p => p.openid),
      })
    }
    prevBet = bet
  }

  return pots
}

/**
 * 分配底池给获胜者
 * @param {Array} pots [{ amount, eligibleOpenids }]
 * @param {Object} handResults { openid: { rank, tiebreakers } }
 * @returns {Object} { openid: chipsWon }
 */
function distributePots(pots, handResults) {
  const winnings = {}

  for (const pot of pots) {
    const eligible = pot.eligibleOpenids.filter(id => handResults[id])
    if (eligible.length === 0) continue

    // 找出最强手牌
    let bestResult = null
    let winners = []
    for (const openid of eligible) {
      const result = handResults[openid]
      if (!bestResult || compareHandResults(result, bestResult) > 0) {
        bestResult = result
        winners = [openid]
      } else if (compareHandResults(result, bestResult) === 0) {
        winners.push(openid)
      }
    }

    // 平分底池（余数给第一个赢家）
    const share = Math.floor(pot.amount / winners.length)
    const remainder = pot.amount % winners.length
    for (let i = 0; i < winners.length; i++) {
      winnings[winners[i]] = (winnings[winners[i]] || 0) + share + (i === 0 ? remainder : 0)
    }
  }

  return winnings
}

module.exports = {
  evaluateBestHand,
  compareHandResults,
  calculateSidePots,
  distributePots,
  HAND_NAMES,
  HAND_RANKS,
}
