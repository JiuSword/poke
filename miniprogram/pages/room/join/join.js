// pages/room/join/join.js
const { roomManage } = require('../../../utils/cloud')
const { resolveAvatars } = require('../../../utils/format')

Page({
  data: { roomCode: '', loading: false, publicRooms: [], roomsLoading: false },

  onInput(e) {
    this.setData({ roomCode: e.detail.value.trim() })
  },

  async onJoin(e) {
    // 支持从列表点击传入 roomCode
    const roomCode = (e && e.currentTarget && e.currentTarget.dataset.roomCode) || this.data.roomCode
    if (!roomCode || roomCode.length !== 6) return wx.showToast({ title: '请输入6位房间号', icon: 'none' })
    if (this.data.loading) return

    this.setData({ loading: true })
    try {
      const res = await roomManage('joinRoom', { roomCode })
      const { roomId, isSpectator } = res.data
      if (isSpectator) {
        wx.navigateTo({
          url: `/pages/game/game?roomId=${roomId}&roomCode=${roomCode}&isSpectator=1`,
        })
      } else {
        wx.navigateTo({
          url: `/pages/room/lobby/lobby?roomId=${roomId}&roomCode=${roomCode}`,
        })
      }
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadPublicRooms() {
    this.setData({ roomsLoading: true })
    try {
      const res = await roomManage('listPublicRooms', {})
      const rooms = (res.data || []).map(r => ({
        ...r,
        filledCount: r.seats.filter(s => s.openid).length,
      }))
      this.setData({ publicRooms: rooms })
      // 解析 cloud:// 头像（旧数据兼容）
      const allAvatars = rooms.flatMap(r => (r.seats || []).map(s => s.avatar)).filter(a => a && a.startsWith('cloud://'))
      if (allAvatars.length > 0) {
        resolveAvatars(allAvatars).then(urlMap => {
          const resolved = rooms.map(r => ({
            ...r,
            seats: (r.seats || []).map(s => ({ ...s, avatar: urlMap[s.avatar] || s.avatar })),
          }))
          this.setData({ publicRooms: resolved })
        })
      }
    } catch (e) {
      console.error('loadPublicRooms error', e)
    } finally {
      this.setData({ roomsLoading: false })
    }
  },

  onPullDownRefresh() {
    this.loadPublicRooms().then(() => wx.stopPullDownRefresh())
  },

  // 分享卡片跳转时携带 roomCode 参数
  onLoad(options) {
    this.loadPublicRooms()
    if (options.roomCode) {
      this.setData({ roomCode: options.roomCode })
      this.onJoin()
    }
  },
})
