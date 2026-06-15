// cloudfunctions/queen-room/rules.js
// 《女王万岁》开局规则常量（与 queen-game/lib/engine.js 保持一致）

// 数字条位置 2~12，位置 7 为公主初始位
const POSITIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const PRINCESS_POSITION = 7
const NON_PRINCESS_POSITIONS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]

// 每位玩家 12 张角色牌
const ROSTER = [
  'SNIPER', 'ASSASSIN', 'SCHEMER', 'NOBLE', 'GAMBLER', 'PRINCESS',
  'PILOT', 'ENTERTAINER', 'SPY', 'RECRUIT', 'RECRUIT', 'GUARD',
]

// 可被指定为主谋（Master）的角色：含红/黄/蓝声望图标的角色
const VALID_MASTERS = ['SNIPER', 'ASSASSIN', 'SCHEMER', 'NOBLE', 'PILOT', 'ENTERTAINER', 'SPY']

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 为某一方发牌：返回 { master, line: { pos: {role, faceUp} } }
function dealForColor() {
  const master = VALID_MASTERS[Math.floor(Math.random() * VALID_MASTERS.length)]
  // 从牌库移除 1 张主谋牌和公主牌，剩 10 张铺到非公主位
  const remaining = []
  let masterRemoved = false
  for (const role of ROSTER) {
    if (role === 'PRINCESS') continue
    if (role === master && !masterRemoved) { masterRemoved = true; continue }
    remaining.push(role)
  }
  const shuffled = shuffle(remaining)
  const line = {}
  line[PRINCESS_POSITION] = { role: 'PRINCESS', faceUp: true }
  NON_PRINCESS_POSITIONS.forEach((pos, i) => {
    line[pos] = { role: shuffled[i], faceUp: false }
  })
  return { master: { role: master, faceUp: false }, line }
}

module.exports = { POSITIONS, PRINCESS_POSITION, NON_PRINCESS_POSITIONS, ROSTER, VALID_MASTERS, shuffle, dealForColor }
