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
      // 底部安全区 = 屏幕高度 - 可用高度 - 状态栏
      const safeBottom = sys.screenHeight - sys.safeArea.bottom
      this.globalData.safeAreaBottom = safeBottom > 0 ? safeBottom : 0
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
        // 通知首页登录成功（如果首页已经在等待）
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
    // 如果当前不在登录页，才跳转
    const current = pages[pages.length - 1]
    if (current && current.route !== 'pages/login/login') {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },
})
