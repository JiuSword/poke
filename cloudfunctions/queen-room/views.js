// views.js —— 三集合视图构建（queen-room 与 queen-game 共用，两目录各保留一份副本）
// 输入：state（完整真相，存于 queen_states）
// 输出：公开视图（脱敏，写入 queen_rooms.view）、私有视图（写入 queen_private）

const POSITIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const COLORS = ['white', 'black']

// 脱敏单张牌：背面则隐藏 role
function sanitizeTile(tile) {
  if (!tile) return null
  return { role: tile.faceUp ? tile.role : null, faceUp: tile.faceUp }
}

// 构建公开棋局视图（双方都可见，背面牌身份一律 null）
function buildPublicView(state) {
  const board = {}
  for (const pos of POSITIONS) {
    const cell = state.board[pos] || {}
    board[pos] = {
      white: sanitizeTile(cell.white),
      black: sanitizeTile(cell.black),
    }
  }
  const masters = {
    white: sanitizeTile(state.masters.white),
    black: sanitizeTile(state.masters.black),
  }
  // 待决策只暴露当前队首（owner + 类型 + 公开候选项），不泄露隐藏身份
  const pending = (state.pendingChoices || []).map(c => ({
    id: c.id,
    owner: c.owner,
    type: c.type,
    role: c.role,
    options: c.publicOptions || c.options || null,
    optional: !!c.optional,
    label: c.label || '',
  }))
  return {
    phase: state.phase,
    currentPlayerColor: state.currentPlayerColor,
    dice: state.dice || null,
    activePosition: state.activePosition != null ? state.activePosition : null,
    board,
    masters,
    prestige: state.prestige,
    pendingChoices: pending,
    canReposition: !!state.canReposition,
    log: (state.log || []).slice(-30),
    winnerColor: state.winnerColor || null,
    starterColor: state.starterColor,
    turnCount: state.turnCount || 0,
  }
}

// 构建某一方的私有视图（自己所有牌真身，含背面）
function buildPrivateView(state, color) {
  const myLine = {}
  for (const pos of POSITIONS) {
    const cell = state.board[pos] || {}
    const tile = cell[color]
    myLine[pos] = tile ? { role: tile.role, faceUp: tile.faceUp } : null
  }
  const m = state.masters[color]
  return {
    myColor: color,
    myLine,
    myMaster: m ? { role: m.role, faceUp: m.faceUp } : null,
  }
}

module.exports = { POSITIONS, COLORS, sanitizeTile, buildPublicView, buildPrivateView }
