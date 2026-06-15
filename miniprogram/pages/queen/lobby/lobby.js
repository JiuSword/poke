// pages/queen/lobby/lobby.js
const { queenRoom } = require('../../../utils/cloud')
const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    roomCode: '',
    creating: false,
    joining: false,
    rooms: [],
    roomsLoading: false,
    myRooms: [],
    myRoomsLoading: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 })
    this.loadRooms()
    this.loadMyRooms()
  },

  onShow() {
    this.loadRooms()
    this.loadMyRooms()
  },

  onPullDownRefresh() {
    Promise.all([this.loadRooms(), this.loadMyRooms()]).then(() => wx.stopPullDownRefresh())
  },

  onCodeInput(e) {
    this.setData({ roomCode: e.detail.value.replace(/\D/g, '').slice(0, 6) })
  },

  async loadRooms() {
    this.setData({ roomsLoading: true })
    try {
      const res = await queenRoom('listPublicRooms')
      this.setData({ rooms: res.data || [] })
    } catch (e) {
      // 静默
    } finally {
      this.setData({ roomsLoading: false })
    }
  },

  async loadMyRooms() {
    this.setData({ myRoomsLoading: true })
    try {
      const res = await queenRoom('listMyRooms')
      const myRooms = (res.data || []).map(r => ({
        ...r,
        statusText: r.status === 'playing' ? '进行中' : '等待中',
      }))
      this.setData({ myRooms })
    } catch (e) {
      // 静默
    } finally {
      this.setData({ myRoomsLoading: false })
    }
  },

  async onCreate() {
    if (this.data.creating) return
    this.setData({ creating: true })
    try {
      const res = await queenRoom('createRoom')
      wx.navigateTo({
        url: `/pages/queen/room/room?roomId=${res.data.roomId}&roomCode=${res.data.roomCode}&isHost=1`,
      })
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败', icon: 'none' })
    } finally {
      this.setData({ creating: false })
    }
  },

  onJoinByList(e) {
    const { roomid, roomcode } = e.currentTarget.dataset
    this.joinRoom(roomcode, roomid)
  },

  onJoinByCode() {
    const code = this.data.roomCode
    if (code.length !== 6) return wx.showToast({ title: '请输入6位房间号', icon: 'none' })
    this.joinRoom(code)
  },

  async joinRoom(roomCode, roomId) {
    if (this.data.joining) return
    this.setData({ joining: true })
    try {
      const res = await queenRoom('joinRoom', { roomCode })
      wx.navigateTo({
        url: `/pages/queen/room/room?roomId=${res.data.roomId}&roomCode=${res.data.roomCode}`,
      })
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' })
    } finally {
      this.setData({ joining: false })
    }
  },

  // 历史房间：再次加入继续游玩
  async onRejoin(e) {
    if (this.data.joining) return
    const { roomid } = e.currentTarget.dataset
    this.setData({ joining: true })
    try {
      const res = await queenRoom('rejoinRoom', { roomId: roomid })
      const { roomId, roomCode, status, isHost, myColor } = res.data
      if (status === 'playing') {
        wx.navigateTo({
          url: `/pages/queen/game/game?roomId=${roomId}&roomCode=${roomCode}&myColor=${myColor || ''}`,
        })
      } else {
        wx.navigateTo({
          url: `/pages/queen/room/room?roomId=${roomId}&roomCode=${roomCode}${isHost ? '&isHost=1' : ''}`,
        })
      }
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' })
    } finally {
      this.setData({ joining: false })
    }
  },

  onBack() {
    wx.navigateBack()
  },
})
