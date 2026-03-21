// pages/ai-practice/ai-practice.js
const { aiEngine, userAuth } = require('../../utils/cloud')
const { formatCard } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    difficulty: 'beginner',
    difficultyIndex: 0,
    aiCount: 1,
    difficultyOptions: ['新手', '进阶', '高手'],
    difficultyValues: ['beginner', 'advanced', 'expert'],
    aiCountOptions: ['1个', '2个', '3个', '4个', '5个'],

    sessionId: null,
    started: false,
    loading: false,
    acting: false,

    // 游戏状态
    phase: '',
    pot: 0,
    currentBet: 0,
    myChips: 0,
    myCards: [],
    communityCards: [],
    isMyTurn: false,
    winners: [],
    playerStates: [],
    myBestHand: '',

    // 操作
    raiseAmount: 0,
    showRaiseInput: false,
    sliderMin: 1,
    sliderMax: 10000,
    isAllinMode: false,
    callIsAllin: false,
    callAmount: 0,
    canRaise: true,
    smallBlind: 100,
    prevCardCount: 0,
    safeAreaBottom: 16,
    rankingList: [],
    rankingLoading: false,
  },

  onLoad() {
    this.setData({ safeAreaBottom: app.globalData.safeAreaBottom || 16 })
    this.loadRanking()
  },

  async loadRanking() {
    this.setData({ rankingLoading: true })
    try {
      const res = await userAuth('getAiRanking')
      this.setData({ rankingList: res.data.list })
    } catch (e) {} finally {
      this.setData({ rankingLoading: false })
    }
  },

  onDifficultyChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      difficultyIndex: idx,
      difficulty: ['beginner', 'advanced', 'expert'][idx],
    })
  },

  onAiCountChange(e) {
    this.setData({ aiCount: Number(e.detail.value) + 1 })
  },

  async onStart() {
    this.setData({ loading: true })
    try {
      const res = await aiEngine('startSession', {
        difficulty: this.data.difficulty,
        aiCount: this.data.aiCount,
      })
      this.setData({ sessionId: res.data.sessionId, started: true })
      this.applyState(res.data.state)
    } catch (e) {
      wx.showToast({ title: e.message || '启动失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  applyState(state) {
    if (!state) return
    const myPs = state.playerStates?.[0]
    const myChips = myPs?.chips || 0
    const currentBet = state.currentBet || 0
    const myBetInPhase = myPs?.betInPhase || 0
    const callAmount = Math.max(0, currentBet - myBetInPhase)
    const callIsAllin = callAmount > 0 && myChips <= callAmount
    const canRaise = myChips > callAmount

    // 计算最优牌型
    const myRawCards = (myPs?.holeCards || []).filter(c => c !== '??' && c !== '?')
    const communityRaw = state.communityCards || []
    const myBestHand = this.evaluateHandDisplay(myRawCards, communityRaw)

    const newMinRaise = state.minRaise || 1
    const initRaise = Math.min(Math.max(newMinRaise, newMinRaise), myChips || 1)

    // AI 操作音效：对比上一次 playerStates 检测 AI 的操作变化
    const prevStates = this.data.playerStates || []
    const newStates = state.playerStates || []
    for (let i = 1; i < newStates.length; i++) {
      const prev = prevStates[i]
      const curr = newStates[i]
      if (!prev || !curr || !curr.isAI) continue
      // 检测弃牌
      if (prev.status !== 'folded' && curr.status === 'folded') {
        this._playFold(); break
      }
      // 检测下注/加注（betTotal 增加）
      if ((curr.betTotal || 0) > (prev.betTotal || 0)) {
        if (curr.status === 'allin') { this._playAllin(); break }
        else { this._playBet(); break }
      }
      // 检测过牌（betTotal 不变，hasActed 变为 true）
      if (!prev.hasActed && curr.hasActed && (curr.betTotal || 0) === (prev.betTotal || 0)) {
        this._playCheck(); break
      }
    }

    // 翻牌动画：记录上一次公共牌数量
    const prevCardCount = this.data.communityCards.length
    const newCommunityCards = communityRaw.map(formatCard)
    const newCount = newCommunityCards.length - prevCardCount

    // 翻牌音效
    if (newCount > 0) {
      for (let i = 0; i < newCount; i++) {
        setTimeout(() => this._playCard(), i * 150)
      }
    }

    this.setData({
      phase: state.phase,
      pot: state.pot || 0,
      currentBet,
      myChips,
      myCards: (myPs?.holeCards || []).map(formatCard),
      communityCards: newCommunityCards,
      prevCardCount,
      isMyTurn: state.currentActorIndex === 0 && state.phase !== 'ended',
      winners: state.winners || [],
      playerStates: state.playerStates || [],
      showRaiseInput: false,
      callIsAllin,
      callAmount,
      canRaise,
      myBestHand,
      sliderMin: newMinRaise,
      sliderMax: myChips || 1,
    })
    this.setRaiseAmount(initRaise)
  },

  // 统一设置加注额，同步 isAllinMode
  setRaiseAmount(amount) {
    const myChips = this.data.myChips || 1
    const isAllinMode = amount >= myChips
    this.setData({ raiseAmount: amount, isAllinMode })
  },

  // 简化版牌型评估（前端展示用）
  evaluateHandDisplay(holeCards, communityCards) {
    const all = [...holeCards, ...communityCards]
    if (all.length < 2) return ''
    const RV = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14}
    const cards = all.map(c => ({ v: RV[c[0]] || 0, s: c[1] }))
    const vals = cards.map(c => c.v).sort((a,b) => b-a)
    const suits = cards.map(c => c.s)
    const countMap = {}
    vals.forEach(v => countMap[v] = (countMap[v]||0)+1)
    const counts = Object.values(countMap).sort((a,b)=>b-a)
    const isFlush = suits.length >= 5 && suits.filter(s=>s===suits[0]).length >= 5
    const uv = [...new Set(vals)].sort((a,b)=>b-a)
    let isStraight = false
    if (uv.length >= 5) {
      for (let i=0;i<=uv.length-5;i++) if(uv[i]-uv[i+4]===4){isStraight=true;break}
      if (!isStraight && uv.includes(14)&&uv.includes(2)&&uv.includes(3)&&uv.includes(4)&&uv.includes(5)) isStraight=true
    }
    if (all.length >= 5) {
      if (isFlush && isStraight) return vals[0]===14&&vals[1]===13?'皇家同花顺':'同花顺'
      if (counts[0]===4) return '四条'
      if (counts[0]===3&&counts[1]===2) return '葫芦'
      if (isFlush) return '同花'
      if (isStraight) return '顺子'
      if (counts[0]===3) return '三条'
      if (counts[0]===2&&counts[1]===2) return '两对'
      if (counts[0]===2) return '一对'
      return '高牌'
    }
    if (counts[0]===2) return '一对'
    const rn = {'14':'A','13':'K','12':'Q','11':'J','10':'T'}
    return `${rn[vals[0]]||vals[0]}${rn[vals[1]]||vals[1]} 高牌`
  },

  async doAction(action, amount) {
    if (this.data.acting || !this.data.isMyTurn) return
    this.setData({ acting: true, showRaiseInput: false })
    // 自己操作音效
    if (action === 'allin') this._playAllin()
    else if (action === 'call' || action === 'raise') this._playBet()
    else if (action === 'fold') this._playFold()
    else if (action === 'check') this._playCheck()
    try {
      const res = await aiEngine('playerAction', {
        sessionId: this.data.sessionId,
        playerOp: action,
        amount,
      })
      this.applyState(res.data.state)
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ acting: false })
    }
  },

  onFold() { this.doAction('fold', 0) },

  onCheckCall() {
    const { currentBet, myChips, callIsAllin } = this.data
    const myBetInPhase = this.data.playerStates[0]?.betInPhase || 0
    const callAmt = currentBet - myBetInPhase
    if (callAmt <= 0) this.doAction('check', 0)
    else if (callIsAllin) this.doAction('allin', myChips)
    else this.doAction('call', callAmt)
  },

  onToggleRaise() {
    if (this.data.showRaiseInput) {
      // 已展开：二次点击确认加注
      this.onRaise()
    } else {
      const minRaise = this.data.sliderMin || 1
      const myChips = this.data.myChips || 1
      const initAmount = Math.min(Math.max(this.data.raiseAmount || minRaise, minRaise), myChips)
      this.setData({ showRaiseInput: true })
      this.setRaiseAmount(initAmount)
    }
  },

  onRaiseInput(e) {
    this.setRaiseAmount(Number(e.detail.value) || this.data.sliderMin)
  },

  onSliderChange(e) {
    this.setRaiseAmount(e.detail.value)
  },

  onRaiseStep(e) {
    const dir = Number(e.currentTarget.dataset.dir)
    const step = this.data.smallBlind || 100
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
    const minRaise = this.data.sliderMin || 1
    const clamped = Math.min(Math.max(amount, minRaise), myChips)
    this.setRaiseAmount(clamped)
  },

  onRaise() {
    const { myChips, sliderMin } = this.data
    const safeAmount = Math.min(Math.max(this.data.raiseAmount || sliderMin, sliderMin), myChips)
    if (safeAmount >= myChips) this.doAction('allin', myChips)
    else this.doAction('raise', safeAmount)
  },

  async onNewRound() {
    this.setData({ loading: true })
    try {
      const res = await aiEngine('newRound', { sessionId: this.data.sessionId })
      this.applyState(res.data.state)
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onExit() {
    wx.showModal({
      title: '退出练习',
      content: '确定退出？',
      success: async res => {
        if (!res.confirm) return
        this._destroyAudios()
        try { await aiEngine('endSession', { sessionId: this.data.sessionId }) } catch (e) {}
        this.setData({ started: false, sessionId: null })
        this.loadRanking()
      },
    })
  },

  _playBet() {
    if (!this._betAudio) { this._betAudio = wx.createInnerAudioContext(); this._betAudio.src = '/audios/bet.mp3'; this._betAudio.volume = 0.8 }
    this._betAudio.stop(); this._betAudio.play()
  },
  _playAllin() {
    if (!this._allinAudio) { this._allinAudio = wx.createInnerAudioContext(); this._allinAudio.src = '/audios/All in.mp3'; this._allinAudio.volume = 1.0 }
    this._allinAudio.stop(); this._allinAudio.play()
  },
  _playFold() {
    if (!this._foldAudio) { this._foldAudio = wx.createInnerAudioContext(); this._foldAudio.src = '/audios/flod.mp3'; this._foldAudio.volume = 0.4 }
    this._foldAudio.stop(); this._foldAudio.play()
  },
  _playCheck() {
    if (!this._checkAudio) { this._checkAudio = wx.createInnerAudioContext(); this._checkAudio.src = '/audios/check.mp3'; this._checkAudio.volume = 1.0 }
    this._checkAudio.stop(); this._checkAudio.play()
  },
  _playCard() {
    const audio = wx.createInnerAudioContext()
    audio.src = '/audios/card.mp3'
    audio.volume = 0.8
    audio.play()
    audio.onEnded(() => audio.destroy())
    audio.onError(() => audio.destroy())
  },

  _destroyAudios() {
    ['_betAudio', '_allinAudio', '_foldAudio', '_checkAudio'].forEach(key => {
      if (this[key]) { try { this[key].destroy() } catch (e) {} this[key] = null }
    })
  },
})
