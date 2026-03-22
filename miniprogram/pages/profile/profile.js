// pages/profile/profile.js
const { userAuth } = require('../../utils/cloud')
const { formatPoints, formatPointsDelta, formatTime, resolveAvatars } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    userInfo: null,
    stats: { totalGames: 0, totalWins: 0, winRate: '0%', maxPotWon: 0 },
    records: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    loading: false,
    // 昵称编辑
    showNicknameEdit: false,
    nicknameInput: '',
    editLoading: false,
    loadingMore: false,
    expandedIds: {},
  },

  async onLoad() {
    const userInfo = app.globalData.userInfo
    this.setData({ userInfo })
    await this.loadProfile()
    await this.loadRecords()
  },

  async loadProfile() {
    try {
      const res = await userAuth('getProfile')
      const u = res.data
      // 解析 cloud:// 头像
      if (u.avatar && u.avatar.startsWith('cloud://')) {
        const urlMap = await resolveAvatars([u.avatar])
        u.avatar = urlMap[u.avatar] || u.avatar
      }
      app.globalData.userInfo = u
      const winRate = u.totalGames > 0 ? Math.round(u.totalWins / u.totalGames * 100) + '%' : '0%'
      this.setData({
        userInfo: u,
        stats: {
          totalGames: u.totalGames,
          totalWins: u.totalWins,
          winRate,
          maxPotWon: u.maxPotWon || 0,
        },
      })
    } catch (e) {}
  },

  async loadRecords(reset = false) {
    if (this.data.loading || this.data.loadingMore) return
    const page = reset ? 1 : this.data.page

    this.setData(reset ? { loading: true } : { loadingMore: true })
    try {
      const res = await userAuth('getPointRecords', { page, pageSize: this.data.pageSize })
      const newRecords = res.data.list.map(r => ({
        ...r,
        timeDisplay: formatTime(r.settledAt),
        pointsDeltaDisplay: formatPointsDelta(r.pointsDelta),
        expanded: false,
      }))

      this.setData({
        records: reset ? newRecords : [...this.data.records, ...newRecords],
        total: res.data.total,
        page: page + 1,
        hasMore: (page * this.data.pageSize) < res.data.total,
      })
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false, loadingMore: false })
    }
  },

  onLoadMore() {
    if (this.data.hasMore) this.loadRecords()
  },

  onToggleExpand(e) {
    const { id } = e.currentTarget.dataset
    const expanded = { ...this.data.expandedIds }
    expanded[id] = !expanded[id]
    this.setData({ expandedIds: expanded })
  },

  async onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl
    wx.showLoading({ title: '上传中...', mask: true })
    try {
      const openid = app.globalData.userInfo?._openid || Date.now()
      const uploadRes = await new Promise((resolve, reject) => {
        wx.cloud.uploadFile({
          cloudPath: `avatars/${openid}.jpg`,
          filePath: tempPath,
          success: resolve,
          fail: reject,
        })
      })
      const fileID = uploadRes.fileID
      const { userAuth } = require('../../utils/cloud')
      // 传 fileID，云函数存 cloudAva 并刷新 avatar 为临时 URL
      await userAuth('updateProfile', { avatar: fileID })
      const profileRes = await userAuth('getProfile')
      const newAvatar = profileRes.data.avatar
      app.globalData.userInfo.avatar = newAvatar
      this.setData({ 'userInfo.avatar': newAvatar })
      wx.showToast({ title: '头像已更新' })
    } catch (err) {
      wx.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onEditNickname() {
    this.setData({
      showNicknameEdit: true,
      nicknameInput: this.data.userInfo?.nickname || '',
      editLoading: false,
    })
  },

  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value })
  },

  onCancelEdit() {
    this.setData({ showNicknameEdit: false })
  },

  async onConfirmEdit() {
    const nickname = this.data.nicknameInput.trim()
    if (!nickname) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
    if (nickname.length > 20) return wx.showToast({ title: '昵称最多20个字符', icon: 'none' })

    this.setData({ editLoading: true })
    try {
      await userAuth('updateProfile', { nickname })
      app.globalData.userInfo.nickname = nickname
      this.setData({ 'userInfo.nickname': nickname, showNicknameEdit: false })
      wx.showToast({ title: '修改成功' })
    } catch (e) {
      wx.showToast({ title: '修改失败', icon: 'none' })
    } finally {
      this.setData({ editLoading: false })
    }
  },
})
