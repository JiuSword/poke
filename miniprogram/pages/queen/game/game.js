// pages/queen/game/game.js
const { queenRoom, queenGame } = require('../../../utils/cloud')
const watchManager = require('../../../utils/db-watch')
const { ROLES, PRESTIGE, VALID_MASTERS } = require('../roles')
const app = getApp()

const POSITIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const BANNED_MASTER = ['GAMBLER', 'PRINCESS', 'RECRUIT', 'GUARD']

Page({
  data: {
    statusBarHeight: 20,
    roomId: '',
    roomCode: '',
    myColor: '',
    oppColor: '',
    loaded: false,

    phase: 'await_roll',     // await_roll / resolving / reposition / finished
    isMyTurn: false,
    dice: null,
    activePosition: null,
    cells: [],               // 渲染用：每格上下两张牌
    myPrestige: { r: 0, y: 0, b: 0 },
    oppPrestige: { r: 0, y: 0, b: 0 },
    myMaster: null,
    oppMaster: null,
    log: [],
    winnerColor: null,
    resultText: '',

    // 决策弹层
    decision: null,          // { type, label, optional, colorOptions[], posOptions[], pairOptions[], id }

    // reposition 交互
    repoMode: '',            // '' | 'swap' | 'master'
    swapFirst: null,         // 选中的第一个位置
    canReposition: false,

    showRules: false,        // 规则弹层

    busy: false,
  },

  pubKey: null,
  privKey: null,
  heartbeatTimer: null,
  _pub: null,
  _priv: null,

  onLoad(options) {
    this.myOpenid = app.globalData.userInfo?._openid || ''
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      roomId: options.roomId,
      roomCode: options.roomCode,
      myColor: options.myColor || '',
      oppColor: options.myColor === 'white' ? 'black' : 'white',
    })
    // 若未携带 myColor，从房间信息补
    if (!options.myColor) {
      queenRoom('getRoomInfo', { roomId: options.roomId }).then(res => {
        const me = (res.data.players || []).find(p => p.openid === app.globalData.userInfo?._openid)
        if (me) this.setData({ myColor: me.color, oppColor: me.color === 'white' ? 'black' : 'white' })
      }).catch(() => {})
    }
    this.startWatch()
    this.startHeartbeat()
  },

  onUnload() {
    if (this._privRetry) { clearTimeout(this._privRetry); this._privRetry = null }
    if (this.pubKey) watchManager.unwatch(this.pubKey)
    if (this.privKey) watchManager.unwatch(this.privKey)
    this.stopHeartbeat()
  },

  onAppShow() {
    if (this._privRetry) { clearTimeout(this._privRetry); this._privRetry = null }
    if (this.pubKey) watchManager.unwatch(this.pubKey)
    if (this.privKey) watchManager.unwatch(this.privKey)
    this.startWatch()
  },

  startHeartbeat() {
    this.stopHeartbeat()
    const beat = () => queenRoom('heartbeat', { roomId: this.data.roomId }).catch(() => {})
    beat()
    this.heartbeatTimer = setInterval(beat, 30000)
  },
  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  },

  startWatch() {
    this.pubKey = watchManager.watchQueenRoom(this.data.roomId, doc => {
      this._pub = doc
      this.rebuild()
    }, () => {})
    this.watchPrivate()
  },

  // 私有视图订阅：需 openid，若尚未就绪则稍后重试（直连/重连进入时 userInfo 可能未加载）
  watchPrivate() {
    if (!this.myOpenid) this.myOpenid = app.globalData.userInfo?._openid || ''
    if (!this.myOpenid) {
      this._privRetry = setTimeout(() => this.watchPrivate(), 500)
      return
    }
    this.privKey = watchManager.watchQueenPrivate(this.data.roomId, this.myOpenid, doc => {
      this._priv = doc
      // 私有视图可能先于公开视图返回 myColor
      if (doc.myColor && !this.data.myColor) {
        this.setData({ myColor: doc.myColor, oppColor: doc.myColor === 'white' ? 'black' : 'white' })
      }
      this.rebuild()
    })
  },

  // 合并公开视图(对手+棋盘)与私有视图(己方真身)
  rebuild() {
    const pub = this._pub
    if (!pub || pub.status === 'dismissed') {
      if (pub && pub.status === 'dismissed') {
        wx.showToast({ title: '房间已解散', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1200)
      }
      return
    }
    const view = pub.view
    if (!view) return
    const myColor = this.data.myColor || (this._priv && this._priv.myColor)
    if (!myColor) return
    const oppColor = myColor === 'white' ? 'black' : 'white'
    const priv = this._priv

    // 构建每格上下两张牌
    const cells = POSITIONS.map(pos => {
      // 己方牌：优先私有视图真身
      let mine
      if (priv && priv.myLine && priv.myLine[pos]) {
        mine = this.tileVM(priv.myLine[pos].role, priv.myLine[pos].faceUp, true, true)
      } else {
        const t = view.board[pos] ? view.board[pos][myColor] : null
        mine = this.tileVM(t && t.role, t && t.faceUp, !!(t && t.faceUp), true)
      }
      // 对手牌：公开视图（背面 role 为 null）
      const ot = view.board[pos] ? view.board[pos][oppColor] : null
      const opp = this.tileVM(ot && ot.role, ot && ot.faceUp, !!(ot && ot.faceUp), false)
      return {
        pos,
        isPrincessPos: pos === 7,
        isActive: view.activePosition === pos,
        mine,
        opp,
      }
    })

    const isMyTurn = view.currentPlayerColor === myColor
    const myMasterReal = priv && priv.myMaster
    const myMaster = myMasterReal ? this.tileVM(myMasterReal.role, myMasterReal.faceUp, true, true) : null
    const om = view.masters ? view.masters[oppColor] : null
    const oppMaster = this.tileVM(om && om.role, om && om.faceUp, !!(om && om.faceUp), false)

    // 决策（owner 可能是非当前回合方：双方同位置正面牌都激活时）
    let decision = null
    const head = (view.pendingChoices || [])[0]
    if (head && head.owner === myColor) {
      decision = this.buildDecision(head, priv, view, oppColor)
    }

    // 胜负文案
    let resultText = ''
    if (view.winnerColor) {
      resultText = view.winnerColor === myColor ? '胜利！你统一了帮派' : '失败，对手称王'
    }

    this.setData({
      loaded: true,
      phase: view.phase,
      isMyTurn,
      dice: view.dice,
      activePosition: view.activePosition,
      cells,
      myPrestige: view.prestige[myColor],
      oppPrestige: view.prestige[oppColor],
      myMaster,
      oppMaster,
      log: (view.log || []).slice(-8).reverse(),
      winnerColor: view.winnerColor,
      resultText,
      decision,
      canReposition: view.phase === 'reposition' && isMyTurn && view.canReposition,
      oppColor,
    })
    // 切换回合/阶段时清掉 reposition 临时态
    if (view.phase !== 'reposition') {
      this.setData({ repoMode: '', swapFirst: null })
    }
  },

  tileVM(role, faceUp, known, isMine) {
    if (!role || (!known)) {
      return { back: true, faceUp: !!faceUp, isMine: !!isMine }
    }
    const r = ROLES[role] || {}
    return {
      back: false,
      faceUp: !!faceUp,
      isMine: !!isMine,
      role,
      emoji: r.emoji,
      name: r.name,
      init: r.init,
      prestige: r.prestige,
      prestigeCls: r.prestige ? PRESTIGE[r.prestige].cls : '',
      peek: isMine && !faceUp,   // 己方背面：可偷看（半透明展示真身）
    }
  },

  buildDecision(head, priv, view, oppColor) {
    const type = head.type
    const d = { id: head.id, type, label: head.label || '', optional: !!head.optional, colorOptions: [], posOptions: [], pairOptions: [] }
    if (type === 'schemer_remove' || type === 'noble_gain' || type === 'gambler_steal' ||
        type === 'entertainer_give' || type === 'entertainer_take') {
      d.colorOptions = (head.options || []).map(c => ({ c, name: PRESTIGE[c].name, label: PRESTIGE[c].label, cls: PRESTIGE[c].cls }))
    } else if (type === 'princess_reveal') {
      d.posOptions = (head.options || []).map(pos => {
        const t = priv && priv.myLine && priv.myLine[pos]
        return { pos, name: t && ROLES[t.role] ? ROLES[t.role].name : '背面牌' }
      })
    } else if (type === 'pilot_swap' || type === 'spy_swap') {
      const fromMine = type === 'pilot_swap'
      d.pairOptions = (head.options || []).map(pair => {
        let a = '?', b = '?'
        if (fromMine && priv && priv.myLine) {
          a = priv.myLine[pair[0]] ? ROLES[priv.myLine[pair[0]].role].name : pair[0]
          b = priv.myLine[pair[1]] ? ROLES[priv.myLine[pair[1]].role].name : pair[1]
        }
        return { pair, label: `${pair[0]}↔${pair[1]}`, a, b }
      })
    }
    return d
  },

  // ── 掷骰 ──
  async onRoll() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await queenGame('rollDice', { roomId: this.data.roomId })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  // ── 决策提交 ──
  async onDecideColor(e) {
    const c = e.currentTarget.dataset.c
    await this.submitChoice({ color: c })
  },
  async onDecidePos(e) {
    const pos = Number(e.currentTarget.dataset.pos)
    await this.submitChoice({ pos })
  },
  async onDecidePair(e) {
    const pair = e.currentTarget.dataset.pair
    await this.submitChoice({ pair })
  },
  async onDecideSkip() {
    await this.submitChoice({ skip: true })
  },
  async submitChoice(payload) {
    if (this.data.busy || !this.data.decision) return
    this.setData({ busy: true })
    try {
      await queenGame('resolveChoice', { roomId: this.data.roomId, choiceId: this.data.decision.id, payload })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  // ── reposition ──
  onRepoSwapMode() {
    this.setData({ repoMode: this.data.repoMode === 'swap' ? '' : 'swap', swapFirst: null })
  },
  onRepoMasterMode() {
    this.setData({ repoMode: this.data.repoMode === 'master' ? '' : 'master', swapFirst: null })
  },
  onCellTap(e) {
    if (!this.data.canReposition) return
    const pos = Number(e.currentTarget.dataset.pos)
    if (this.data.repoMode === 'swap') {
      this.handleSwapTap(pos)
    } else if (this.data.repoMode === 'master') {
      this.handleMasterTap(pos)
    }
  },
  handleSwapTap(pos) {
    const first = this.data.swapFirst
    if (first == null) {
      this.setData({ swapFirst: pos })
      return
    }
    if (first === pos) { this.setData({ swapFirst: null }); return }
    // 必须相邻
    const idxA = POSITIONS.indexOf(first), idxB = POSITIONS.indexOf(pos)
    if (Math.abs(idxA - idxB) !== 1) {
      wx.showToast({ title: '只能交换相邻两张', icon: 'none' })
      this.setData({ swapFirst: pos })
      return
    }
    const lo = Math.min(first, pos), hi = Math.max(first, pos)
    this.doReposition('swap', { pair: [lo, hi] })
  },
  async handleMasterTap(pos) {
    const cell = this.data.cells.find(c => c.pos === pos)
    if (!cell || cell.mine.back || !cell.mine.faceUp) {
      return wx.showToast({ title: '请选正面角色牌', icon: 'none' })
    }
    if (BANNED_MASTER.includes(cell.mine.role)) {
      return wx.showToast({ title: '该角色不可当主谋', icon: 'none' })
    }
    await this.doReposition('changeMaster', { pos })
  },
  async doReposition(mode, payload) {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await queenGame('reposition', { roomId: this.data.roomId, mode, payload })
      this.setData({ repoMode: '', swapFirst: null })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async onEndTurn() {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      await queenGame('endTurn', { roomId: this.data.roomId })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  onSurrender() {
    wx.showModal({
      title: '认输', content: '确定认输吗？', success: async res => {
        if (!res.confirm) return
        try { await queenGame('surrender', { roomId: this.data.roomId }) } catch (e) {}
      },
    })
  },

  onExit() {
    // 对局未结束：提示可通过历史房间继续
    if (this.data.loaded && !this.data.winnerColor) {
      wx.showModal({
        title: '退出对局',
        content: '对局进度会保留，可在大厅「历史房间」再次加入继续。确定退出？',
        confirmText: '退出',
        success: res => { if (res.confirm) wx.navigateBack() },
      })
      return
    }
    wx.navigateBack()
  },

  onShowRules() {
    this.setData({ showRules: true })
  },

  onCloseRules() {
    this.setData({ showRules: false })
  },

  noop() {},
})
