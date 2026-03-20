// pages/room/join/join.js
const { roomManage } = require('../../../utils/cloud')

Page({
  data: { roomCode: '', loading: false },

  onInput(e) {
    this.setData({ roomCode: e.detail.value.trim() })
  },

  async onJoin() {
    const { roomCode } = this.data
    if (roomCode.length !== 6) return wx.showToast({ title: '请输入6位房间号', icon: 'none' })
    if (this.data.loading) return

    this.setData({ loading: true })
    try {
      const res = await roomManage('joinRoom', { roomCode })
      wx.navigateTo({
        url: `/pages/room/lobby/lobby?roomId=${res.data.roomId}&roomCode=${roomCode}`,
      })
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 分享卡片跳转时携带 roomCode 参数
  onLoad(options) {
    if (options.roomCode) {
      this.setData({ roomCode: options.roomCode })
      this.onJoin()
    }
  },
})
