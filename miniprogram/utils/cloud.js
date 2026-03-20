// utils/cloud.js
// 云函数调用统一封装

const callFunction = (name, data) => {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: res => {
        if (res.result && res.result.code !== 0) {
          reject(new Error(res.result.msg || '操作失败'))
        } else {
          resolve(res.result)
        }
      },
      fail: err => reject(err),
    })
  })
}

module.exports = {
  userAuth: (action, data = {}) => callFunction('user-auth', { action, ...data }),
  roomManage: (action, data = {}) => callFunction('room-manage', { action, ...data }),
  gameAction: (action, data = {}) => callFunction('game-action', { action, ...data }),
  aiEngine: (action, data = {}) => callFunction('ai-engine', { routeAction: action, action, ...data }),
}
