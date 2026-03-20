// utils/db-watch.js
// db.watch 监听管理器，支持指数退避重连，永不放弃

const db = wx.cloud.database()

// 指数退避延迟：1s, 2s, 4s, 8s, 16s, 30s, 30s...
function backoffDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), 30000)
}

class WatchManager {
  constructor() {
    this.watchers = {}      // key -> watcher 实例
    this.retryCount = {}    // key -> 重试次数
    this.retryTimers = {}   // key -> setTimeout 句柄
    this.connectFns = {}    // key -> connect 函数（用于外部触发重连）
  }

  // 订阅房间视图（lobby + game 页）
  watchRoom(roomId, onChange, onError) {
    const key = `room_${roomId}`
    this._unwatch(key)

    const connect = () => {
      // 先清理旧连接
      this._unwatchSilent(key)

      let watcher
      try {
        watcher = db.collection('room_views')
          .doc(roomId)
          .watch({
            onChange: snapshot => {
              this.retryCount[key] = 0  // 成功重置计数
              if (snapshot.docs && snapshot.docs.length > 0) {
                onChange(snapshot.docs[0])
              }
            },
            onError: err => {
              console.warn('watchRoom error, will retry', err)
              if (onError) onError(err)
              this._scheduleRetry(key, connect)
            },
          })
        this.watchers[key] = watcher
        this.connectFns[key] = connect
      } catch (e) {
        console.warn('watchRoom connect threw', e)
        this._scheduleRetry(key, connect)
      }
    }

    this.retryCount[key] = 0
    connect()
    return key
  }

  // 订阅个人手牌
  watchMyCards(gameRoundId, onChange) {
    const key = `cards_${gameRoundId}`
    this._unwatch(key)

    const connect = () => {
      this._unwatchSilent(key)
      try {
        const watcher = db.collection('my_cards')
          .where({ gameRoundId })
          .watch({
            onChange: snapshot => {
              this.retryCount[key] = 0
              if (snapshot.docs && snapshot.docs.length > 0) {
                onChange(snapshot.docs[0].holeCards)
              }
            },
            onError: () => this._scheduleRetry(key, connect),
          })
        this.watchers[key] = watcher
        this.connectFns[key] = connect
      } catch (e) {
        this._scheduleRetry(key, connect)
      }
    }

    this.retryCount[key] = 0
    connect()
    return key
  }

  // 取消某个订阅（彻底清理，不再重连）
  unwatch(key) {
    this._clearRetryTimer(key)
    this._unwatchSilent(key)
    delete this.retryCount[key]
    delete this.connectFns[key]
  }

  // 取消所有订阅
  unwatchAll() {
    Object.keys(this.watchers).forEach(key => this.unwatch(key))
  }

  // App.onShow 时重连所有活跃 watcher
  reconnectAll() {
    Object.keys(this.connectFns).forEach(key => {
      this._clearRetryTimer(key)
      this.retryCount[key] = 0
      const fn = this.connectFns[key]
      if (fn) fn()
    })
  }

  // ── 内部方法 ──────────────────────────────────────

  // 静默关闭 watcher（不清理元数据，用于重连前清理旧连接）
  _unwatchSilent(key) {
    if (this.watchers[key]) {
      try { this.watchers[key].close() } catch (e) {}
      delete this.watchers[key]
    }
  }

  _unwatch(key) {
    this._clearRetryTimer(key)
    this._unwatchSilent(key)
  }

  _clearRetryTimer(key) {
    if (this.retryTimers[key]) {
      clearTimeout(this.retryTimers[key])
      delete this.retryTimers[key]
    }
  }

  _scheduleRetry(key, connectFn) {
    this._clearRetryTimer(key)
    // 不设上限，永远重试，只是延迟越来越长（最长 30s）
    const count = this.retryCount[key] || 0
    this.retryCount[key] = count + 1
    const delay = backoffDelay(count)
    console.log(`watchKey ${key} 将在 ${delay}ms 后重连（第${count + 1}次）`)
    this.retryTimers[key] = setTimeout(connectFn, delay)
  }
}

module.exports = new WatchManager()
