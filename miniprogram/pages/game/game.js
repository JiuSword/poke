// pages/game/game.js
const { gameAction } = require('../../utils/cloud')
const watchManager = require('../../utils/db-watch')
const { formatCard, formatCountdown } = require('../../utils/format')
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
    canRaise: true,
    // 操作中
    acting: false,
    // 本手结算
    showHandResult: false,
    handWinners: [],
    // 是否房主
    isHost: false,
    // 安全区
    statusBarHeight: 20,
    safeAreaBottom: 0,
    // 暂停
    pausedBy: null,
    // 结算中
    isSettling: false,
    // 补充筹码消耗积分
    myRefillCost: 0,
    // 暂停
    isPaused: false,
    // 公共牌翻开动画：上一次已显示的牌数
    prevCardCount: 0,
  },

  watchKeys: [],
  countdownInterval: null,

  onLoad(options) {
    const myOpenid = app.globalData.userInfo?._openid || ''
    const statusBarHeight = app.globalData.statusBarHeight || 20
    const safeAreaBottom = app.globalData.safeAreaBottom || 0
    this.setData({
      roomId: options.roomId,
      roomCode: options.roomCode || '',
      gameRoundId: options.gameRoundId,
      myOpenid,
      isHost: options.isHost === '1',
      statusBarHeight,
      safeAreaBottom,
    })
    this.startWatch()
  },

  onUnload() {
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

  onRoomViewChange(roomView) {
    const { myOpenid } = this.data
    const seats = roomView.seats || []
    const mySeat = seats.find(s => s.openid === myOpenid)
    const mySeatIndex = mySeat ? mySeat.seatIndex : -1
    const isMyTurn = mySeat ? mySeat.isCurrentActor : false

    // 解析公共牌，同时记录上一次已显示牌数以触发动画
    const prevCardCount = this.data.communityCards.length
    const newCommunityCards = (roomView.communityCards || []).map(formatCard)

    // 计算最优牌型
    const rawCommunity = roomView.communityCards || []
    const myBestHand = evaluateHandDisplay(this.data.myCards, rawCommunity)

    // 同步暂停状态
    const isPaused = !!roomView.isPaused
    const pausedBy = roomView.pausedBy || null

    // 计算跟注/加注状态
    const myChips = mySeat ? mySeat.chips : 0
    const currentBet = roomView.currentBet || 0
    const myBetInPhase = mySeat ? (mySeat.betInPhase || 0) : 0
    const callAmount = Math.max(0, currentBet - myBetInPhase)
    // 剩余筹码不足以跟注，跟注按钮变 Allin
    const callIsAllin = callAmount > 0 && myChips <= callAmount
    // 剩余筹码不足以加注（跟注后没有多余筹码），加注按钮置灰
    const canRaise = myChips > callAmount

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
      canRaise,
      myBestHand,
      isPaused,
      pausedBy,
    })

    // 重置加注默认值：clamp 到 [minRaise, myChips]，同步更新 isAllinMode
    const newMinRaise = roomView.minRaise || 0
    if (newMinRaise > 0 && myChips > 0) {
      this.setRaiseAmount(Math.min(newMinRaise, myChips))
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
      this.setData({ showHandResult: true, handWinners: roomView.winners || [] })
      return
    }

    // 新手开始：隐藏上手结果，更新 gameRoundId
    if (roomView.gameRoundId && roomView.gameRoundId !== this.data.gameRoundId) {
      this.setData({ showHandResult: false, handWinners: [], gameRoundId: roomView.gameRoundId })
      // 重新订阅新手的手牌
      if (this.watchKeys[1]) watchManager.unwatch(this.watchKeys[1])
      const k2 = watchManager.watchMyCards(roomView.gameRoundId, cards => {
        const parsed = (cards || []).map(formatCard)
        const myBestHand = evaluateHandDisplay(cards || [], roomView.communityCards || [])
        this.setData({ myCards: cards || [], myCardsParsed: parsed, myBestHand })
      })
      this.watchKeys[1] = k2
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
    const isAllinMode = amount >= myChips
    this.setData({ raiseAmount: amount, isAllinMode })
  },

  onToggleRaiseInput() {
    if (this.data.showRaiseInput) {
      // 面板已展开：第二次点击 = 确认加注
      this.onRaise()
    } else {
      // 展开面板，初始化滑动条
      const minRaise = this.data.minRaise || 1
      const myChips = this.data.myChips || 1
      // 默认值：优先用已设置的 raiseAmount，但不能超过 myChips，也不能低于 minRaise
      const initAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), myChips)
      this.setData({ showRaiseInput: true, sliderMin: minRaise, sliderMax: myChips })
      this.setRaiseAmount(initAmount)
    }
  },

  onSliderChange(e) {
    this.setRaiseAmount(e.detail.value)
  },

  onQuickRaise(e) {
    const amount = Number(e.currentTarget.dataset.amount)
    const myChips = this.data.myChips || 1
    const minRaise = this.data.minRaise || 1
    const clamped = Math.min(Math.max(amount, minRaise), myChips)
    this.setRaiseAmount(clamped)
  },

  async onRaise() {
    const { myChips, minRaise } = this.data
    // 确保 raiseAmount 在合法范围内
    const safeAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), myChips)
    if (safeAmount >= myChips) {
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

  async onLeaveGame() {
    wx.showModal({
      title: '退出房间',
      content: '退出后将自动弃牌，确定退出吗？',
      success: async res => {
        if (!res.confirm) return
        try {
          // 若轮到自己先弃牌
          if (this.data.isMyTurn) {
            await this.doAction('fold', 0)
          }
          const { roomManage } = require('../../utils/cloud')
          await roomManage('leaveRoom', { roomId: this.data.roomId })
        } catch (e) {
          // 忽略错误，直接跳回首页
        }
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
    this.setData({ acting: true, showRaiseInput: false })
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

  // 计算按钮文字
  getCheckCallText() {
    const { currentBet, mySeatIndex, seats } = this.data
    if (mySeatIndex < 0 || !seats[mySeatIndex]) return '过牌'
    const callAmount = currentBet - (seats[mySeatIndex].betInPhase || 0)
    return callAmount > 0 ? `跟注 ${callAmount}` : '过牌'
  },
})
