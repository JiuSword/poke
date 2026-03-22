// pages/settlement/settlement.js
const app = getApp()

Page({
  data: {
    settlements: [],
    myOpenid: '',
    loading: true,
    totalPointsDelta: 0,
  },

  onLoad(options) {
    const myOpenid = app.globalData.userInfo?._openid || ''
    this.setData({ myOpenid })

    const raw = app.globalData.finalSettlements || []

    if (raw.length > 0) {
      const settlements = raw.map(s => ({
        ...s,
        isMe: s.openid === myOpenid,
        // 自己用 globalData 里的头像（已刷新临时 URL），对手用结算数据里的头像
        avatar: s.openid === myOpenid ? (app.globalData.userInfo?.avatar || s.avatar || '') : (s.avatar || ''),
        pointsDeltaDisplay: (s.pointsDelta >= 0 ? '+' : '') + s.pointsDelta,
        chipsDeltaDisplay: (s.chipsDelta >= 0 ? '+' : '') + s.chipsDelta,
      }))
      .sort((a, b) => b.pointsDelta - a.pointsDelta)

      const totalPointsDelta = settlements.reduce((sum, s) => sum + s.pointsDelta, 0)
      this.setData({ settlements, loading: false, totalPointsDelta })
    } else {
      // 兜底：从云函数重新查
      this.loadFromRecords(options.roomId, myOpenid)
    }
  },

  async loadFromRecords(roomId, myOpenid) {
    try {
      const { userAuth } = require('../../utils/cloud')
      const res = await userAuth('getPointRecords', { page: 1, pageSize: 100 })
      const records = res.data.list.filter(r => r.roomId === roomId)

      if (records.length > 0) {
        const totalPointsDelta = records.reduce((sum, r) => sum + r.pointsDelta, 0)
        const lastRecord = records[0]
        const myEntry = {
          openid: myOpenid,
          nickname: app.globalData.userInfo?.nickname || '我',
          avatar: app.globalData.userInfo?.avatar || '',
          pointsDelta: totalPointsDelta,
          pointsDeltaDisplay: (totalPointsDelta >= 0 ? '+' : '') + totalPointsDelta,
          chipsDelta: records.reduce((sum, r) => sum + r.chipsDelta, 0),
          pointsAfter: lastRecord.pointsAfter,
          isMe: true,
        }
        const opponentsMap = {}
        for (const r of records) {
          for (const o of (r.opponents || [])) {
            if (!opponentsMap[o.openid]) {
              opponentsMap[o.openid] = { openid: o.openid, nickname: o.nickname, pointsDelta: 0, chipsDelta: 0 }
            }
            opponentsMap[o.openid].pointsDelta += (o.pointsDelta || 0)
            opponentsMap[o.openid].chipsDelta += (o.chipsDelta || 0)
          }
        }
        const all = [myEntry, ...Object.values(opponentsMap).map(o => ({
          ...o,
          pointsDeltaDisplay: (o.pointsDelta >= 0 ? '+' : '') + o.pointsDelta,
        }))]
        .sort((a, b) => b.pointsDelta - a.pointsDelta)
        this.setData({ settlements: all })
      }
    } catch (e) {
      wx.showToast({ title: '加载结算数据失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onHome() {
    app.globalData.finalSettlements = null
    wx.reLaunch({ url: '/pages/home/home' })
  },
})
