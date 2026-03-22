// pages/login/login.js
const { userAuth } = require('../../utils/cloud')
const app = getApp()

Page({
  data: {
    loading: false,
    step: 'login',
    nickname: '',
    avatar: '',
  },

  onLoad(options) {
    // app.js 静默登录后发现新用户，直接进入 profile 步骤
    if (options.step === 'profile') {
      const userInfo = app.globalData.userInfo
      this.setData({
        step: 'profile',
        nickname: userInfo?.nickname || '',
        avatar: userInfo?.avatar || '',
      })
    }
  },

  // 步骤1：微信静默登录，获取 openid
  async onLogin() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject })
      })

      const res = await userAuth('login', { code: loginRes.code })
      app.globalData.userInfo = res.data

      if (res.data.isNew) {
        // 新用户：进入设置头像昵称步骤
        this.setData({
          step: 'profile',
          nickname: '',
          avatar: '',
        })
      } else {
        // 老用户：直接进入游戏
        wx.reLaunch({ url: '/pages/home/home' })
      }
    } catch (e) {
      console.error('登录失败', e)
      wx.showToast({ title: e.message || '登录失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 步骤2：用户选择头像（open-type="chooseAvatar"）
  onChooseAvatar(e) {
    this.setData({ avatar: e.detail.avatarUrl })
  },

  // 步骤2：用户输入昵称（type="nickname" 组件会自动填入微信昵称）
  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  // 步骤2：确认资料，保存并进入游戏
  async onConfirmProfile() {
    const { nickname, avatar } = this.data
    if (!avatar) {
      return wx.showToast({ title: '请先选择头像', icon: 'none' })
    }
    if (!nickname.trim()) {
      return wx.showToast({ title: '请输入昵称', icon: 'none' })
    }
    this.setData({ loading: true })
    try {
      await userAuth('updateProfile', { nickname: nickname.trim(), avatar })
      app.globalData.userInfo.nickname = nickname.trim()
      app.globalData.userInfo.avatar = avatar
      wx.reLaunch({ url: '/pages/home/home' })
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 跳过，使用随机昵称
  async onSkipProfile() {
    const nickname = '玩家' + Math.floor(Math.random() * 9999)
    this.setData({ loading: true })
    try {
      await userAuth('updateProfile', { nickname })
      app.globalData.userInfo.nickname = nickname
    } catch (e) {}
    wx.reLaunch({ url: '/pages/home/home' })
  },
})
