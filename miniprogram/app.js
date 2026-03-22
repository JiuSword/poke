// app.js
App({
  globalData: {
    userInfo: null,
    cloudEnvId: 'cloudbase-0glgrdbn2f319379',
    statusBarHeight: 20,   // 状态栏高度 px
    safeAreaBottom: 0,     // 底部安全区高度 px
  },

  onLaunch() {
    wx.cloud.init({
      env: this.globalData.cloudEnvId,
      traceUser: true,
    })

    // 获取系统信息，适配刘海屏/状态栏
    try {
      const sys = wx.getSystemInfoSync()
      this.globalData.statusBarHeight = sys.statusBarHeight || 20
      // 底部安全区：iOS 用 safeArea 计算，安卓最少保留 16px 边距
      const safeBottom = sys.safeArea ? sys.screenHeight - sys.safeArea.bottom : 0
      const MIN_BOTTOM = 16 // 安卓兜底最小边距（px）
      this.globalData.safeAreaBottom = Math.max(safeBottom, MIN_BOTTOM)
    } catch (e) {}

    this.silentLogin()
  },

  onShow() {
    const pages = getCurrentPages()
    const currentPage = pages[pages.length - 1]
    if (currentPage && currentPage.onAppShow) {
      currentPage.onAppShow()
    }
  },

  // 静默登录：用 wx.login 换取 openid，自动创建/读取账号
  async silentLogin() {
    try {
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject })
      })

      const res = await new Promise((resolve, reject) => {
        wx.cloud.callFunction({
          name: 'user-auth',
          data: { action: 'login', code: loginRes.code },
          success: r => resolve(r.result),
          fail: reject,
        })
      })

      if (res.code === 0) {
        this.globalData.userInfo = res.data
        // login 云函数已在返回前刷新了 avatar 为临时 URL
        // 没有头像或是新用户：跳转设置资料
        if (res.data.isNew || !res.data.avatar) {
          // 只在首页等待时才跳转，避免重复跳转
          const pages = getCurrentPages()
          const current = pages[pages.length - 1]
          if (current && current.route === 'pages/home/home') {
            wx.reLaunch({ url: '/pages/login/login?step=profile' })
            return
          }
        }
        // 老用户：通知首页登录成功
        if (this.loginReadyCallback) {
          this.loginReadyCallback(res.data)
          this.loginReadyCallback = null
        }
      } else {
        this.redirectToLogin()
      }
    } catch (e) {
      console.error('静默登录失败', e)
      this.redirectToLogin()
    }
  },

  redirectToLogin() {
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    if (current && current.route !== 'pages/login/login') {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  // 将 cloud:// fileID 转为临时 URL 更新 globalData（每次登录刷新，不更新数据库）
  async _migrateAvatar(fileID) {
    try {
      const res = await new Promise((resolve, reject) => {
        wx.cloud.getTempFileURL({ fileList: [fileID], success: resolve, fail: reject })
      })
      const tempURL = res.fileList[0]?.tempFileURL
      if (tempURL) this.globalData.userInfo.avatar = tempURL
    } catch (e) {}
  },
})
