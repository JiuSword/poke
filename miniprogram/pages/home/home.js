// pages/home/home.js
const { userAuth } = require('../../utils/cloud')
const { formatPoints } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    userInfo: null,
    pointsDisplay: '0',
    loading: true,
  },

  onLoad() {
    if (app.globalData.userInfo) {
      // 已有登录信息，直接展示
      this.setUserInfo(app.globalData.userInfo)
    } else {
      // 等待 app.js 静默登录完成
      app.loginReadyCallback = userInfo => {
        this.setUserInfo(userInfo)
      }
      // 超时兜底：3秒后还没登录就跳登录页
      this._loginTimeout = setTimeout(() => {
        if (!app.globalData.userInfo) {
          wx.reLaunch({ url: '/pages/login/login' })
        }
      }, 5000)
    }
  },

  onShow() {
    // 兜底：没有头像则跳回设置页（防止用户绕过设置）
    const userInfo = app.globalData.userInfo
    if (userInfo && !userInfo.avatar) {
      wx.reLaunch({ url: '/pages/login/login?step=profile' })
      return
    }
    // 从其他页面返回时刷新积分
    if (app.globalData.userInfo) {
      this.refreshProfile()
    }
  },

  onUnload() {
    if (this._loginTimeout) clearTimeout(this._loginTimeout)
  },

  setUserInfo(userInfo) {
    if (this._loginTimeout) clearTimeout(this._loginTimeout)
    this.setData({
      userInfo,
      pointsDisplay: formatPoints(userInfo.points),
      loading: false,
    })
  },

  async refreshProfile() {
    try {
      const res = await userAuth('getProfile')
      app.globalData.userInfo = res.data
      this.setData({
        userInfo: res.data,
        pointsDisplay: formatPoints(res.data.points),
        loading: false,
      })
    } catch (e) {
      // 登录态过期，跳转登录页
      if (e.message && e.message.includes('auth')) {
        wx.reLaunch({ url: '/pages/login/login' })
      } else {
        this.setData({ loading: false })
      }
    }
  },

  onCreateRoom() {
    wx.navigateTo({ url: '/pages/room/create/create' })
  },

  onJoinRoom() {
    wx.navigateTo({ url: '/pages/room/join/join' })
  },

  onAIPractice() {
    wx.navigateTo({ url: '/pages/ai-practice/ai-practice' })
  },

  onProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },
})
