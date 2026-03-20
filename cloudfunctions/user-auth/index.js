// cloudfunctions/user-auth/index.js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const INITIAL_POINTS = 999999

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  switch (action) {
    case 'login':
      return login(OPENID, event)
    case 'updateProfile':
      return updateProfile(OPENID, event)
    case 'getProfile':
      return getProfile(OPENID)
    case 'getPointRecords':
      return getPointRecords(OPENID, event)
    default:
      return { code: 400, msg: '未知操作' }
  }
}

async function login(openid, event) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()

    if (res.data.length > 0) {
      // 已有账号，返回用户信息
      return { code: 0, data: res.data[0], isNew: false }
    }

    // 首次登录，创建账号
    const now = db.serverDate()
    const newUser = {
      _openid: openid,
      nickname: event.nickname || '玩家' + Math.floor(Math.random() * 9999),
      avatar: event.avatar || '',
      points: INITIAL_POINTS,
      totalGames: 0,
      totalWins: 0,
      maxPotWon: 0,
      createdAt: now,
      updatedAt: now,
    }
    const addRes = await db.collection('users').add({ data: newUser })
    newUser._id = addRes._id
    return { code: 0, data: newUser, isNew: true }
  } catch (e) {
    return { code: 500, msg: e.message }
  }
}

async function updateProfile(openid, event) {
  try {
    const update = { updatedAt: db.serverDate() }
    if (event.nickname) update.nickname = event.nickname
    if (event.avatar) update.avatar = event.avatar

    await db.collection('users').where({ _openid: openid }).update({ data: update })
    return { code: 0 }
  } catch (e) {
    return { code: 500, msg: e.message }
  }
}

async function getProfile(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get()
    if (res.data.length === 0) return { code: 404, msg: '用户不存在' }
    return { code: 0, data: res.data[0] }
  } catch (e) {
    return { code: 500, msg: e.message }
  }
}

async function getPointRecords(openid, event) {
  try {
    const { page = 1, pageSize = 20, startDate, endDate } = event
    const skip = (page - 1) * pageSize

    let query = db.collection('point_records').where({ _openid: openid })

    if (startDate || endDate) {
      const timeFilter = {}
      if (startDate) timeFilter[_.gte] = new Date(startDate)
      if (endDate) timeFilter[_.lte] = new Date(endDate)
      query = db.collection('point_records').where({
        _openid: openid,
        settledAt: timeFilter,
      })
    }

    const [records, countRes] = await Promise.all([
      query.orderBy('settledAt', 'desc').skip(skip).limit(pageSize).get(),
      query.count(),
    ])

    return {
      code: 0,
      data: {
        list: records.data,
        total: countRes.total,
        page,
        pageSize,
      },
    }
  } catch (e) {
    return { code: 500, msg: e.message }
  }
}
