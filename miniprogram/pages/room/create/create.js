// pages/room/create/create.js
const { roomManage } = require('../../../utils/cloud')

const ACTION_TIMEOUT_OPTIONS = [
  { label: '30秒', value: 30 },
  { label: '60秒', value: 60 },
  { label: '90秒', value: 90 },
  { label: '不限制', value: 0 },
]

Page({
  data: {
    smallBlind: 10,
    maxPlayers: 6,
    buyInChips: 1000,
    // 积分换算：pointsIn 积分 = chipsOut 筹码
    pointsIn: 100,
    chipsOut: 1000,
    costPoints: 100, // 入座消耗积分
    // 操作倒计时
    actionTimeoutOptions: ACTION_TIMEOUT_OPTIONS.map(o => o.label),
    actionTimeoutIndex: 0, // 默认30秒
    loading: false,
  },

  onSmallBlindChange(e) {
    this.setData({ smallBlind: Number(e.detail.value) || 10 })
  },

  onMaxPlayersChange(e) {
    this.setData({ maxPlayers: Number(e.detail.value) || 6 })
  },

  onBuyInChange(e) {
    const buyInChips = Number(e.detail.value) || 1000
    this.setData({ buyInChips, costPoints: this.calcCost(buyInChips, this.data.pointsIn, this.data.chipsOut) })
  },

  onPointsInChange(e) {
    const pointsIn = Number(e.detail.value) || 100
    this.setData({ pointsIn, costPoints: this.calcCost(this.data.buyInChips, pointsIn, this.data.chipsOut) })
  },

  onChipsOutChange(e) {
    const chipsOut = Number(e.detail.value) || 1000
    this.setData({ chipsOut, costPoints: this.calcCost(this.data.buyInChips, this.data.pointsIn, chipsOut) })
  },

  onActionTimeoutChange(e) {
    this.setData({ actionTimeoutIndex: Number(e.detail.value) })
  },

  calcCost(buyInChips, pointsIn, chipsOut) {
    if (!chipsOut) return 0
    return Math.ceil(buyInChips / chipsOut * pointsIn)
  },

  async onCreateRoom() {
    if (this.data.loading) return
    const { smallBlind, maxPlayers, buyInChips, pointsIn, chipsOut, actionTimeoutIndex } = this.data

    if (smallBlind < 1) return wx.showToast({ title: '小盲注至少为1', icon: 'none' })
    if (maxPlayers < 2 || maxPlayers > 9) return wx.showToast({ title: '玩家数2~9人', icon: 'none' })
    if (buyInChips < smallBlind * 10) return wx.showToast({ title: `入座筹码至少为 ${smallBlind * 10}`, icon: 'none' })
    if (pointsIn < 1 || chipsOut < 1) return wx.showToast({ title: '积分换算比例不合法', icon: 'none' })

    const actionTimeoutSec = ACTION_TIMEOUT_OPTIONS[actionTimeoutIndex].value
    // pointsPerChip = pointsIn / chipsOut（每筹码对应多少积分）
    const pointsPerChip = pointsIn / chipsOut

    this.setData({ loading: true })
    try {
      const res = await roomManage('createRoom', {
        config: { smallBlind, maxPlayers, buyInChips, pointsPerChip, pointsIn, chipsOut, actionTimeoutSec },
      })
      wx.navigateTo({
        url: `/pages/room/lobby/lobby?roomId=${res.data.roomId}&roomCode=${res.data.roomCode}&isHost=1`,
      })
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
