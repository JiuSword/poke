// pages/room/lobby/lobby.js
const { roomManage } = require('../../../utils/cloud')
const watchManager = require('../../../utils/db-watch')
const app = getApp()

Page({
  data: {
    roomId: '',
    roomCode: '',
    isHost: false,
    seats: [],
    phase: 'waiting',
    loading: false,
    isReady: false,
    myOpenid: '',
  },

  watchKey: null,

  onLoad(options) {
    const myOpenid = app.globalData.userInfo?._openid || ''
    this.setData({
      roomId: options.roomId,
      roomCode: options.roomCode,
      isHost: options.isHost === '1',
      myOpenid,
    })
    this.startWatch()
  },

  onUnload() {
    if (this.watchKey) watchManager.unwatch(this.watchKey)
  },

  onAppShow() {
    // 断线重连
    if (this.watchKey) watchManager.unwatch(this.watchKey)
    this.startWatch()
  },

  startWatch() {
    this.watchKey = watchManager.watchRoom(
      this.data.roomId,
      roomView => {
        if (roomView.phase === 'preflop' || roomView.phase === 'flop' ||
            roomView.phase === 'turn' || roomView.phase === 'river') {
          // 游戏开始，跳转 game 页
          watchManager.unwatch(this.watchKey)
          wx.redirectTo({
            url: `/pages/game/game?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}&gameRoundId=${roomView.gameRoundId}&isHost=${this.data.isHost ? '1' : '0'}`,
          })
          return
        }
        if (roomView.phase === 'dismissed') {
          wx.showToast({ title: '房间已解散', icon: 'none' })
          setTimeout(() => wx.navigateBack(), 1500)
          return
        }
        const seats = roomView.seats || []
        // 从 seats 里读取自己的 ready 状态
        const { myOpenid } = this.data
        const mySeat = seats.find(s => s.openid === myOpenid)
        const isReady = mySeat ? mySeat.status === 'ready' : false
        this.setData({ seats, phase: roomView.phase, isReady })
      },
      err => wx.showToast({ title: '连接断开，重连中...', icon: 'none' })
    )
  },

  async onReady() {
    this.setData({ loading: false })
  },

  async onSetReady() {
    const { isReady, roomId } = this.data
    const newReady = !isReady
    console.log('onSetReady roomId:', roomId, 'newReady:', newReady)
    try {
      const res = await roomManage('setReady', { roomId, isReady: newReady })
      console.log('setReady result:', res)
      // 乐观更新，watch 回调会再次同步
      this.setData({ isReady: newReady })
    } catch (e) {
      console.error('setReady error:', e)
      wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  async onStartGame() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      await roomManage('startGame', { roomId: this.data.roomId })
    } catch (e) {
      wx.showToast({ title: e.message || '开始失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  async onLeave() {
    wx.showModal({
      title: '离开房间',
      content: '确定要离开吗？',
      success: async res => {
        if (!res.confirm) return
        try {
          await roomManage('leaveRoom', { roomId: this.data.roomId })
          wx.navigateBack()
        } catch (e) {
          wx.showToast({ title: e.message, icon: 'none' })
        }
      },
    })
  },

  async onDismiss() {
    wx.showModal({
      title: '解散房间',
      content: '确定要解散房间吗？',
      success: async res => {
        if (!res.confirm) return
        try {
          await roomManage('dismissRoom', { roomId: this.data.roomId })
          wx.navigateBack()
        } catch (e) {
          wx.showToast({ title: e.message, icon: 'none' })
        }
      },
    })
  },

  onShareAppMessage() {
    return {
      title: `邀请你来打德州扑克，房间号：${this.data.roomCode}`,
      path: `/pages/room/join/join?roomCode=${this.data.roomCode}`,
    }
  },
})
