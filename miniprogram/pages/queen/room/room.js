// pages/queen/room/room.js
const { queenRoom } = require('../../../utils/cloud')
const watchManager = require('../../../utils/db-watch')
const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    roomId: '',
    roomCode: '',
    isHost: false,
    myOpenid: '',
    players: [],       // 已规整：含 me/ready 标记
    bothReady: false,
    iAmReady: false,
    starting: false,
  },

  watchKey: null,
  heartbeatTimer: null,

  onLoad(options) {
    const myOpenid = app.globalData.userInfo?._openid || ''
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      roomId: options.roomId,
      roomCode: options.roomCode,
      isHost: options.isHost === '1',
      myOpenid,
    })
    this.startWatch()
    this.startHeartbeat()
  },

  onUnload() {
    if (this.watchKey) watchManager.unwatch(this.watchKey)
    this.stopHeartbeat()
  },

  onAppShow() {
    if (this.watchKey) watchManager.unwatch(this.watchKey)
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
    this.watchKey = watchManager.watchQueenRoom(
      this.data.roomId,
      doc => this.onRoomChange(doc),
      () => {}
    )
  },

  onRoomChange(room) {
    if (!room) return
    if (room.status === 'dismissed') {
      wx.showToast({ title: '房间已解散', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    if (room.status === 'playing') {
      // 进入棋盘
      if (this.watchKey) watchManager.unwatch(this.watchKey)
      const myColor = (room.players.find(p => p.openid === this.data.myOpenid) || {}).color || ''
      wx.redirectTo({
        url: `/pages/queen/game/game?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}&myColor=${myColor}`,
      })
      return
    }
    const players = (room.players || []).map(p => ({
      ...p,
      isMe: p.openid === this.data.myOpenid,
      colorName: p.color === 'white' ? '白玫瑰' : '黑玫瑰',
    }))
    const me = players.find(p => p.isMe)
    const bothReady = players.length === 2 && players.every(p => p.isReady)
    this.setData({
      players,
      iAmReady: me ? !!me.isReady : false,
      bothReady,
    })
  },

  async onToggleReady() {
    try {
      await queenRoom('setReady', { roomId: this.data.roomId, isReady: !this.data.iAmReady })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  async onStart() {
    if (this.data.starting) return
    if (this.data.players.length < 2) return wx.showToast({ title: '等待对手加入', icon: 'none' })
    if (!this.data.bothReady) return wx.showToast({ title: '双方准备后才能开始', icon: 'none' })
    this.setData({ starting: true })
    try {
      await queenRoom('startGame', { roomId: this.data.roomId })
      // watch 回调会跳转
    } catch (e) {
      wx.showToast({ title: e.message || '开始失败', icon: 'none' })
      this.setData({ starting: false })
    }
  },

  onCopyCode() {
    wx.setClipboardData({ data: this.data.roomCode, success: () => wx.showToast({ title: '房间号已复制', icon: 'none' }) })
  },

  onLeave() {
    wx.showModal({
      title: this.data.isHost ? '解散房间' : '离开房间',
      content: this.data.isHost ? '确定解散房间吗？' : '确定离开吗？',
      success: async res => {
        if (!res.confirm) return
        try {
          await queenRoom(this.data.isHost ? 'dismissRoom' : 'leaveRoom', { roomId: this.data.roomId })
        } catch (e) {}
        wx.navigateBack()
      },
    })
  },

  onBack() { this.onLeave() },

  onShareAppMessage() {
    return {
      title: `来一局《女王万岁》，房间号：${this.data.roomCode}`,
      path: `/pages/queen/lobby/lobby?roomCode=${this.data.roomCode}`,
    }
  },
})
