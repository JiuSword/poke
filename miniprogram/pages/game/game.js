// pages/game/game.js
const { gameAction } = require('../../utils/cloud')
const watchManager = require('../../utils/db-watch')
const { formatCard, formatCountdown, resolveAvatars } = require('../../utils/format')
const app = getApp()

// 前端简化版牌型评估（用于实时展示）
function evaluateHandDisplay(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards]
  if (all.length < 2) return ''

  const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14}
  const cards = all.map(c => ({ rank: c[0], suit: c[1], val: RANK_VAL[c[0]] || 0 }))
  const vals = cards.map(c => c.val).sort((a,b) => b-a)
  const suits = cards.map(c => c.suit)

  // 统计
  const countMap = {}
  vals.forEach(v => countMap[v] = (countMap[v]||0)+1)
  const counts = Object.values(countMap).sort((a,b)=>b-a)

  const isFlush = suits.length >= 5 && suits.filter(s=>s===suits[0]).length >= 5
  const uniqueVals = [...new Set(vals)].sort((a,b)=>b-a)
  let isStraight = false
  if (uniqueVals.length >= 5) {
    for (let i=0; i<=uniqueVals.length-5; i++) {
      if (uniqueVals[i]-uniqueVals[i+4]===4) { isStraight=true; break }
    }
    // A-2-3-4-5
    if (!isStraight && uniqueVals.includes(14) && uniqueVals.includes(2) && uniqueVals.includes(3) && uniqueVals.includes(4) && uniqueVals.includes(5)) isStraight=true
  }

  if (all.length >= 5) {
    if (isFlush && isStraight) return vals[0]===14&&vals[1]===13 ? '皇家同花顺' : '同花顺'
    if (counts[0]===4) return '四条'
    if (counts[0]===3&&counts[1]===2) return '葫芦'
    if (isFlush) return '同花'
    if (isStraight) return '顺子'
    if (counts[0]===3) return '三条'
    if (counts[0]===2&&counts[1]===2) return '两对'
    if (counts[0]===2) return '一对'
    return '高牌'
  }
  // 不足5张时只显示手牌信息
  if (counts[0]===2) return '一对'
  const topRankName = {'14':'A','13':'K','12':'Q','11':'J','10':'T'}
  const r1 = topRankName[vals[0]]||String(vals[0])
  const r2 = topRankName[vals[1]]||String(vals[1])
  return `${r1}${r2} 高牌`
}

Page({
  data: {
    roomId: '',
    roomCode: '',
    gameRoundId: '',
    myOpenid: '',
    // 牌桌状态
    seats: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: 0,
    phase: '',
    // 我的手牌
    myCards: [],
    myCardsParsed: [],
    // 最优牌型展示
    myBestHand: '',
    // 我的座位
    mySeatIndex: -1,
    myChips: 0,
    isMyTurn: false,
    // 倒计时
    countdown: 30,
    countdownTimer: null,
    // 操作面板
    raiseAmount: 0,
    showRaiseInput: false,
    sliderMin: 1,
    sliderMax: 10000,
    isAllinMode: false,
    callIsAllin: false,
    callAmount: 0,
    canRaise: true,
    smallBlind: 10,
    sliderStep: 10,
    raisePanelPinned: false,
    // 操作中
    acting: false,
    // 本手结算
    showHandResult: false,
    handWinners: [],
    handResultCountdown: 5,
    // 是否房主
    isHost: false,
    // 安全区
    statusBarHeight: 20,
    safeAreaBottom: 0,
    // 暂停
    pausedBy: null,
    // 结算中
    isSettling: false,
    // 观战
    isSpectator: false,
    spectators: [],
    availableSeats: [],
    myPendingStand: false,
    // 补充筹码消耗积分
    myRefillCost: 0,
    // 暂停
    isPaused: false,
    // 公共牌翻开动画：上一次已显示的牌数
    prevCardCount: 0,
    // 牌型说明浮窗
    showHandGuide: false,
  },

  watchKeys: [],
  countdownInterval: null,
  heartbeatInterval: null,
  handResultTimer: null,

  onLoad(options) {
    const myOpenid = app.globalData.userInfo?._openid || ''
    const statusBarHeight = app.globalData.statusBarHeight || 20
    const safeAreaBottom = app.globalData.safeAreaBottom || 16
    this.setData({
      roomId: options.roomId,
      roomCode: options.roomCode || '',
      gameRoundId: options.gameRoundId || '',
      myOpenid,
      isHost: options.isHost === '1',
      isSpectator: options.isSpectator === '1',
      statusBarHeight,
      safeAreaBottom,
    })
    this.startWatch()
    this.loadRoomConfig(options.roomId)
    this.startHeartbeat(options.roomId)
  },

  startHeartbeat(roomId) {
    this.stopHeartbeat()
    const sendBeat = () => {
      const { myOpenid } = this.data
      if (!myOpenid || !roomId) return
      // 更新 rooms.seats 里自己的 lastSeen
      wx.cloud.callFunction({
        name: 'room-manage',
        data: { action: 'heartbeat', roomId, openid: myOpenid },
      }).catch(() => {})
    }
    sendBeat()
    this.heartbeatInterval = setInterval(sendBeat, 30000)
  },

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  },

  async loadRoomConfig(roomId) {
    try {
      const { roomManage } = require('../../utils/cloud')
      const res = await roomManage('getRoomInfo', { roomId })
      const sb = res.data?.config?.smallBlind || 10
      this.setData({ smallBlind: sb, sliderStep: sb })
    } catch (e) {}
  },

  onUnload() {
    if (this._betAudio) { this._betAudio.destroy(); this._betAudio = null }
    if (this._allinAudio) { this._allinAudio.destroy(); this._allinAudio = null }
    if (this._foldAudio) { this._foldAudio.destroy(); this._foldAudio = null }
    if (this._checkAudio) { this._checkAudio.destroy(); this._checkAudio = null }
    this.stopHeartbeat()
    this.clearCountdown()
    this.watchKeys.forEach(k => watchManager.unwatch(k))
  },

  onAppShow() {
    this.watchKeys.forEach(k => watchManager.unwatch(k))
    this.watchKeys = []
    this.startWatch()
  },

  startWatch() {
    const k1 = watchManager.watchRoom(
      this.data.roomId,
      roomView => this.onRoomViewChange(roomView),
      () => wx.showToast({ title: '连接断开，重连中...', icon: 'none' })
    )
    const k2 = watchManager.watchMyCards(
      this.data.gameRoundId,
      cards => {
        const parsed = (cards || []).map(formatCard)
        const myBestHand = evaluateHandDisplay(cards || [], this.data.communityCards.map(c => c.raw || (c.rank === '10' ? 'T' : c.rank) + c.suit))
        this.setData({ myCards: cards || [], myCardsParsed: parsed, myBestHand })
      }
    )
    this.watchKeys = [k1, k2]
  },

  async onRoomViewChange(roomView) {
    const { myOpenid } = this.data
    let seats = roomView.seats || []

    // 解析 cloud:// 头像为可展示的 HTTPS URL
    const cloudAvatars = seats.map(s => s.avatar).filter(a => a && a.startsWith('cloud://'))
    if (cloudAvatars.length > 0) {
      const urlMap = await resolveAvatars(cloudAvatars)
      seats = seats.map(s => ({ ...s, avatar: urlMap[s.avatar] || s.avatar }))
    }

    const mySeat = seats.find(s => s.openid === myOpenid)
    const mySeatIndex = mySeat ? mySeat.seatIndex : -1
    const isMyTurn = mySeat ? mySeat.isCurrentActor : false

    // 解析公共牌，同时记录上一次已显示牌数以触发动画
    const prevCardCount = this.data.communityCards.length
    const newCommunityCards = (roomView.communityCards || []).map(formatCard)

    // 新翻牌时依次播放音效（每张间隔 150ms 对应翻牌动画）
    const newCount = newCommunityCards.length - prevCardCount
    if (newCount > 0) {
      for (let i = 0; i < newCount; i++) {
        setTimeout(() => this._playCard(), i * 150)
      }
    }

    // 检测对手操作音效：对比 actionHistory 最新一条
    const newHistory = roomView.actionHistory || []
    const oldHistory = this.data._lastActionHistory || []
    if (newHistory.length > oldHistory.length) {
      const latest = newHistory[newHistory.length - 1]
      // 只播放对手操作（自己操作已在 doAction 里播放）
      if (latest && latest.openid !== myOpenid && latest.action !== 'blind') {
        if (latest.action === 'allin') {
          this._playAllin()
        } else if (latest.action === 'call' || latest.action === 'raise') {
          this._playBet()
        } else if (latest.action === 'fold') {
          this._playFold()
        } else if (latest.action === 'check') {
          this._playCheck()
        }
      }
    }
    this.data._lastActionHistory = newHistory

    // 计算最优牌型
    const rawCommunity = roomView.communityCards || []
    const myBestHand = evaluateHandDisplay(this.data.myCards, rawCommunity)

    // 同步暂停状态
    const isPaused = !!roomView.isPaused
    const pausedBy = roomView.pausedBy || null

    // 同步结算中状态（非房主玩家通过此感知）
    if (roomView.isSettling && !this.data.isSettling) {
      this.setData({ isSettling: true })
    }

    // 观战者：同步 gameRoundId（观战者进入时可能没有 gameRoundId）
    if (this.data.isSpectator && roomView.gameRoundId && !this.data.gameRoundId) {
      this.setData({ gameRoundId: roomView.gameRoundId })
    }

    // 同步观战者列表和空座位列表
    const spectators = roomView.spectators || []
    const availableSeats = (roomView.seats || []).filter(s => s.openid === null || s.openid === undefined || s.openid === '')
    // isSpectator：以服务端 spectators 列表为准；若列表为空（旧文档）则保留 onLoad 设置的值
    const isSpectatorFromList = spectators.some(s => s.openid === myOpenid)
    // 只有在 seats 里找不到自己、且在 spectators 里才算观战者
    const inSeat = seats.some(s => s.openid === myOpenid)
    const isSpectator = !inSeat && (isSpectatorFromList || (spectators.length === 0 && this.data.isSpectator))
    const becameSpectator = isSpectator && !this.data.isSpectator
    const spectatorUpdate = becameSpectator ? { myCards: [], myCardsParsed: [], myBestHand: '' } : {}
    this.setData({ spectators, availableSeats, isSpectator, ...spectatorUpdate })

    // 计算跟注/加注状态
    const myChips = mySeat ? mySeat.chips : 0
    const currentBet = roomView.currentBet || 0
    const myBetInPhase = mySeat ? (mySeat.betInPhase || 0) : 0
    const callAmount = Math.max(0, currentBet - myBetInPhase)
    // 剩余筹码不足以跟注，跟注按钮变 Allin
    const callIsAllin = callAmount > 0 && myChips <= callAmount
    // 剩余筹码不足以加注（跟注后没有多余筹码），加注按钮置灰
    const canRaise = myChips > callAmount

    // 检测是否标记了待起立（仅用于 UI 提示，不影响本手操作）
    const myPendingStand = mySeat && mySeat.pendingAction === 'stand'

    this.setData({
      seats,
      communityCards: newCommunityCards,
      prevCardCount,
      pot: roomView.pot || 0,
      currentBet,
      minRaise: roomView.minRaise || 0,
      phase: roomView.phase,
      mySeatIndex,
      myChips,
      myRefillCost: mySeat ? (mySeat.totalRefillCost || 0) : 0,
      isMyTurn,
      callIsAllin,
      callAmount,
      canRaise,
      myBestHand,
      myPendingStand,
      isPaused,
      pausedBy,
    })

    // 重置加注默认值：clamp 到 [minRaise, myChips]，同步更新 isAllinMode
    const newMinRaise = roomView.minRaise || 0
    if (newMinRaise > 0 && myChips > 0) {
      const callAmt = Math.max(0, (roomView.currentBet || 0) - (mySeat?.betInPhase || 0))
      const maxRaise = Math.max(myChips - callAmt, newMinRaise)
      this.setRaiseAmount(Math.min(newMinRaise, myChips))
      // 常驻时同步刷新 slider 范围
      if (this.data.raisePanelPinned) {
        this.setData({ sliderMin: newMinRaise, sliderMax: maxRaise })
      }
    }

    // 暂停时停止倒计时
    if (isPaused) {
      this.clearCountdown()
      return
    }

    // 更新倒计时
    if (isMyTurn && roomView.actionDeadline) {
      this.startCountdown(new Date(roomView.actionDeadline).getTime())
    } else if (!isMyTurn) {
      this.clearCountdown()
    }

    // 本手结算：短暂展示赢家，3秒后 settlement 云函数自动开下一手
    if (roomView.phase === 'hand_settled') {
      this.clearCountdown()
      const winners = roomView.winners || []
      // 弃牌获胜时：赢家是自己 = 对手弃牌，需要播放音效
      //             赢家不是自己 = 自己弃牌，doAction 里已播过，不重复播
      const isFoldWin = winners.length > 0 && winners[0].handRank === '其他人弃牌'
      if (isFoldWin && winners[0].openid === this.data.myOpenid) {
        this._playFold()
      }
      this.setData({ showHandResult: true, handWinners: winners, handResultCountdown: 5 })
      if (this.handResultTimer) clearInterval(this.handResultTimer)
      this.handResultTimer = setInterval(() => {
        const next = this.data.handResultCountdown - 1
        this.setData({ handResultCountdown: next })
        if (next <= 0) {
          clearInterval(this.handResultTimer)
          this.handResultTimer = null
        }
      }, 1000)
      return
    }

    // 新手开始：隐藏上手结果，更新 gameRoundId
    if (roomView.gameRoundId && roomView.gameRoundId !== this.data.gameRoundId) {
      if (this.handResultTimer) { clearInterval(this.handResultTimer); this.handResultTimer = null }
      this.setData({ showHandResult: false, handWinners: [], handResultCountdown: 5, gameRoundId: roomView.gameRoundId })
      // 重新订阅新手的手牌
      if (this.watchKeys[1]) watchManager.unwatch(this.watchKeys[1])
      const k2 = watchManager.watchMyCards(roomView.gameRoundId, cards => {
        const parsed = (cards || []).map(formatCard)
        const myBestHand = evaluateHandDisplay(cards || [], roomView.communityCards || [])
        this.setData({ myCards: cards || [], myCardsParsed: parsed, myBestHand })
      })
      this.watchKeys[1] = k2
    }

    // 玩家不足（如全部起立），回到等待厅
    if (roomView.phase === 'waiting') {
      this.clearCountdown()
      this.watchKeys.forEach(k => watchManager.unwatch(k))
      wx.showToast({ title: '玩家不足，回到等待厅', icon: 'none' })
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/room/lobby/lobby?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}&isHost=${this.data.isHost ? '1' : '0'}`,
        })
      }, 1500)
      return
    }

    // 房主结束游戏：把结算数据存到全局，跳转结算页
    if (roomView.phase === 'game_over') {
      this.clearCountdown()
      this.watchKeys.forEach(k => watchManager.unwatch(k))
      const app = getApp()
      app.globalData.finalSettlements = roomView.finalSettlements || []
      wx.redirectTo({
        url: `/pages/settlement/settlement?roomId=${this.data.roomId}`,
      })
      return
    }

    // 房间解散
    if (roomView.phase === 'dismissed') {
      this.clearCountdown()
      wx.showToast({ title: '房间已解散', icon: 'none' })
      setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 1500)
    }
  },

  startCountdown(deadlineMs) {
    this.clearCountdown()
    let autoFolded = false
    const update = () => {
      const remaining = formatCountdown(deadlineMs)
      this.setData({ countdown: remaining })
      if (remaining <= 0) {
        this.clearCountdown()
        // 超时自动 Fold（只执行一次，且仍是我的回合）
        if (!autoFolded && this.data.isMyTurn) {
          autoFolded = true
          this.doAction('fold', 0)
        }
      }
    }
    update()
    this.countdownInterval = setInterval(update, 1000)
  },

  clearCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval)
      this.countdownInterval = null
    }
  },

  // 牌型说明浮窗
  onToggleHandGuide() {
    this.setData({ showHandGuide: !this.data.showHandGuide })
  },

  // 暂停/继续（服务端驱动，所有玩家同步感知）
  async onTogglePause() {
    const { isPaused, pausedBy, myOpenid, roomId } = this.data
    // 已暂停且不是自己发起的，不允许操作
    if (isPaused && pausedBy && pausedBy !== myOpenid) {
      wx.showToast({ title: '只有发起暂停的玩家可以解除', icon: 'none' })
      return
    }
    try {
      const { roomManage } = require('../../utils/cloud')
      if (isPaused) {
        await roomManage('resumeGame', { roomId })
      } else {
        await roomManage('pauseGame', { roomId })
      }
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' })
    }
  },

  // 退出或结束（统一入口，由 wxml 调用）
  onExitOrEnd() {
    if (this.data.isHost) {
      this.onEndGame()
    } else {
      this.onLeaveGame()
    }
  },

  // 操作：弃牌
  async onFold() {
    await this.doAction('fold', 0)
  },

  // 操作：过牌/跟注/Allin（筹码不足时自动变 Allin）
  async onCheckCall() {
    const { currentBet, mySeatIndex, seats, myChips, callIsAllin } = this.data
    const mySeat = seats[mySeatIndex]
    if (!mySeat) return
    const callAmount = currentBet - (mySeat.betInPhase || 0)
    if (callAmount <= 0) {
      await this.doAction('check', 0)
    } else if (callIsAllin) {
      await this.doAction('allin', myChips)
    } else {
      await this.doAction('call', callAmount)
    }
  },

  // 操作：加注输入
  onRaiseAmountInput(e) {
    const val = Number(e.detail.value) || this.data.minRaise
    this.setRaiseAmount(val)
  },

  setRaiseAmount(amount) {
    const myChips = this.data.myChips || 1
    const callAmount = this.data.callAmount || 0
    // 加注上限 = 全押时的加注额（myChips - callAmount）
    const maxRaise = Math.max(myChips - callAmount, 0)
    const isAllinMode = amount >= maxRaise
    this.setData({ raiseAmount: amount, isAllinMode })
  },

  onToggleRaisePin() {
    const pinned = !this.data.raisePanelPinned
    this.setData({ raisePanelPinned: pinned })
    if (pinned && !this.data.showRaiseInput) {
      // 常驻时自动展开
      const minRaise = this.data.minRaise || 1
      const myChips = this.data.myChips || 1
      const callAmount = this.data.callAmount || 0
      const maxRaise = Math.max(myChips - callAmount, minRaise)
      const initAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), maxRaise)
      this.setData({ showRaiseInput: true, sliderMin: minRaise, sliderMax: maxRaise })
      this.setRaiseAmount(initAmount)
    } else if (!pinned) {
      // 取消常驻时收起
      this.setData({ showRaiseInput: false })
    }
  },

  onToggleRaiseInput() {
    const { showRaiseInput, raisePanelPinned } = this.data
    // 面板已展开（不管是手动还是常驻）：点击 = 确认加注
    if (showRaiseInput || raisePanelPinned) {
      this.onRaise()
    } else {
      // 展开面板
      const minRaise = this.data.minRaise || 1
      const myChips = this.data.myChips || 1
      const callAmount = this.data.callAmount || 0
      const maxRaise = Math.max(myChips - callAmount, minRaise)
      const initAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), maxRaise)
      this.setData({
        showRaiseInput: true,
        sliderMin: minRaise,
        sliderMax: maxRaise,
      })
      this.setRaiseAmount(initAmount)
    }
  },

  onSliderChange(e) {
    this.setRaiseAmount(e.detail.value)
  },

  onRaiseStep(e) {
    const dir = Number(e.currentTarget.dataset.dir)
    const step = this.data.smallBlind || 1
    const myChips = this.data.myChips || 1
    const callAmount = this.data.callAmount || 0
    const minRaise = this.data.sliderMin || 1
    const maxRaise = Math.max(myChips - callAmount, minRaise)
    const newAmount = Math.min(Math.max((this.data.raiseAmount || minRaise) + dir * step, minRaise), maxRaise)
    this.setRaiseAmount(newAmount)
  },

  onQuickRaise(e) {
    const amount = Number(e.currentTarget.dataset.amount)
    const myChips = this.data.myChips || 1
    const minRaise = this.data.minRaise || 1
    const callAmount = this.data.callAmount || 0
    const maxRaise = Math.max(myChips - callAmount, minRaise)
    const clamped = Math.min(Math.max(amount, minRaise), maxRaise)
    this.setRaiseAmount(clamped)
  },

  async onRaise() {
    const { myChips, minRaise, callAmount } = this.data
    const maxRaise = Math.max(myChips - (callAmount || 0), 0)
    const safeAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), maxRaise)
    // 加注额达到上限时走 allin
    if (safeAmount >= maxRaise) {
      await this.doAction('allin', myChips)
    } else {
      await this.doAction('raise', safeAmount)
    }
  },

  onAllin() {
    wx.showModal({
      title: '确认全押',
      content: `押上全部 ${this.data.myChips} 筹码？`,
      confirmText: '全押',
      confirmColor: '#e91e63',
      success: res => {
        if (res.confirm) this.doAction('allin', this.data.myChips)
      },
    })
  },

  async onSitDown(e) {
    const seatIndex = Number(e.currentTarget.dataset.seatIndex)
    try {
      const { roomManage } = require('../../utils/cloud')
      await roomManage('sitDown', { roomId: this.data.roomId, seatIndex })
      this.setData({ isSpectator: false })
      wx.showToast({ title: '下一手将参与游戏', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: err.message || '坐下失败', icon: 'none' })
    }
  },

  async onStandUp() {
    const { myPendingStand } = this.data
    wx.showModal({
      title: myPendingStand ? '取消起立' : '起立',
      content: myPendingStand ? '取消起立，继续参与下一手？' : '本手结束后将退出座位成为观战者，确定吗？',
      confirmText: myPendingStand ? '取消起立' : '确定',
      success: async res => {
        if (!res.confirm) return
        try {
          const { roomManage } = require('../../utils/cloud')
          if (myPendingStand) {
            // 取消起立：清除 pendingAction
            await roomManage('cancelStandUp', { roomId: this.data.roomId })
            wx.showToast({ title: '已取消起立', icon: 'none' })
          } else {
            await roomManage('standUp', { roomId: this.data.roomId })
            wx.showToast({ title: '本手结束后将起立', icon: 'none' })
          }
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      },
    })
  },

  async onLeaveGame() {
    const { isSpectator, phase } = this.data
    const inGame = !isSpectator && phase !== 'ended' && phase !== 'dismissed' && phase !== 'game_over'

    wx.showModal({
      title: '退出房间',
      content: isSpectator ? '确定退出观战吗？' : (inGame ? '退出后本手自动弃牌，本手结束后自动起立，确定退出吗？' : '确定退出房间吗？'),
      success: async res => {
        if (!res.confirm) return
        const { roomManage } = require('../../utils/cloud')
        if (inGame) {
          // 服务端统一处理：弃牌（如轮到自己）+ 标记起立
          try {
            await roomManage('leaveInGame', { roomId: this.data.roomId })
          } catch (e) {}
          // 前端直接跳回首页
          this.watchKeys.forEach(k => watchManager.unwatch(k))
          this.clearCountdown()
          wx.reLaunch({ url: '/pages/home/home' })
          return
        }
        // 观战者或等待中：直接离开
        try {
          await roomManage('leaveRoom', { roomId: this.data.roomId })
        } catch (e) {}
        this.watchKeys.forEach(k => watchManager.unwatch(k))
        wx.reLaunch({ url: '/pages/home/home' })
      },
    })
  },

  async onEndGame() {
    wx.showModal({
      title: '结束游戏',
      content: '确定结束本局游戏并结算积分吗？',
      success: async res => {
        if (!res.confirm) return
        // 立即显示全屏结算遮罩
        this.setData({ isSettling: true })
        try {
          const { roomManage } = require('../../utils/cloud')
          await roomManage('endGame', { roomId: this.data.roomId })
        } catch (e) {
          this.setData({ isSettling: false })
          wx.showToast({ title: e.message || '操作失败', icon: 'none' })
        }
        // 成功后由 watch 感知 game_over 跳转
      },
    })
  },

  async doAction(action, amount) {
    if (this.data.acting || !this.data.isMyTurn) return
    // 常驻时保持面板展开，非常驻时关闭
    this.setData({ acting: true, showRaiseInput: this.data.raisePanelPinned ? true : false })
    // 操作音效
    if (action === 'allin') {
      this._playAllin()
    } else if (action === 'call' || action === 'raise') {
      this._playBet()
    } else if (action === 'fold') {
      this._playFold()
    } else if (action === 'check') {
      this._playCheck()
    }
    try {
      await gameAction('playerAction', {
        roomId: this.data.roomId,
        gameRoundId: this.data.gameRoundId,
        playerAction: action,
        amount,
      })
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ acting: false })
    }
  },

  _playBet() {
    if (!this._betAudio) {
      this._betAudio = wx.createInnerAudioContext()
      this._betAudio.src = '/audios/bet.mp3'
      this._betAudio.volume = 0.9
    }
    this._betAudio.stop()
    this._betAudio.play()
  },

  _playAllin() {
    if (!this._allinAudio) {
      this._allinAudio = wx.createInnerAudioContext()
      this._allinAudio.src = '/audios/All in.mp3'
      this._allinAudio.volume = 1.0
    }
    this._allinAudio.stop()
    this._allinAudio.play()
  },

  _playFold() {
    if (!this._foldAudio) {
      this._foldAudio = wx.createInnerAudioContext()
      this._foldAudio.src = '/audios/flod.mp3'
      this._foldAudio.volume = 0.4
    }
    this._foldAudio.stop()
    this._foldAudio.play()
  },

  _playCheck() {
    if (!this._checkAudio) {
      this._checkAudio = wx.createInnerAudioContext()
      this._checkAudio.src = '/audios/check.mp3'
      this._checkAudio.volume = 1.0
    }
    this._checkAudio.stop()
    this._checkAudio.play()
  },

  _playCard() {
    // 每次创建新实例，避免多张牌快速翻出时互相打断
    const audio = wx.createInnerAudioContext()
    audio.src = '/audios/card.mp3'
    audio.volume = 0.8
    audio.play()
    audio.onEnded(() => audio.destroy())
    audio.onError(() => audio.destroy())
  },

  // 计算按钮文字
  getCheckCallText() {
    const { currentBet, mySeatIndex, seats } = this.data
    if (mySeatIndex < 0 || !seats[mySeatIndex]) return '过牌'
    const callAmount = currentBet - (seats[mySeatIndex].betInPhase || 0)
    return callAmount > 0 ? `跟注 ${callAmount}` : '过牌'
  },
})
