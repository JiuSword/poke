// pages/login/login.js
const { userAuth } = require('../../utils/cloud')
const app = getApp()

Page({
  data: { loading: false },

  async onLogin() {
    if (this.data.loading) return
    this.setData({ loading: true })

    try {
      // 先静默登录获取 openid
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject })
      })

      // 获取用户信息（需用户主动授权）
      let nickname = '', avatar = ''
      try {
        const profileRes = await new Promise((resolve, reject) => {
          wx.getUserProfile({ desc: '用于展示游戏头像和昵称', success: resolve, fail: reject })
        })
        nickname = profileRes.userInfo.nickName
        avatar = profileRes.userInfo.avatarUrl
      } catch (e) {
        nickname = '玩家' + Math.floor(Math.random() * 9999)
      }

      const res = await userAuth('login', { code: loginRes.code, nickname, avatar })
      app.globalData.userInfo = res.data

      if (nickname && avatar) {
        await userAuth('updateProfile', { nickname, avatar })
        app.globalData.userInfo.nickname = nickname
        app.globalData.userInfo.avatar = avatar
      }

      wx.reLaunch({ url: '/pages/home/home' })
    } catch (e) {
      console.error('登录失败', e)
      wx.showToast({ title: e.message || '登录失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
