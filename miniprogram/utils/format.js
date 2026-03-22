// utils/format.js

const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' }
const SUIT_COLORS = { s: '#333', h: '#e74c3c', d: '#e74c3c', c: '#333' }

function formatCard(card) {
  if (!card || card === '??') return { rank: '?', suit: '?', symbol: '?', color: '#999' }
  const rank = card[0] === 'T' ? '10' : card[0]
  const suit = card[1]
  return {
    rank,
    suit,
    symbol: SUIT_SYMBOLS[suit] || suit,
    color: SUIT_COLORS[suit] || '#333',
    display: rank + (SUIT_SYMBOLS[suit] || suit),
  }
}

function formatPoints(n) {
  if (n === undefined || n === null) return '0'
  return Number(n).toLocaleString()
}

function formatPointsDelta(delta) {
  if (delta > 0) return '+' + delta
  return String(delta)
}

function formatTime(timestamp) {
  if (!timestamp) return ''
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatCountdown(deadlineMs) {
  const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
  return remaining
}

// 头像 URL 缓存（fileID -> 临时 URL）
const _avatarCache = {}

/**
 * 批量解析头像 URL，将 cloud:// fileID 转为可展示的临时 URL
 * @param {string[]} fileIDs
 * @returns {Promise<Object>} { fileID: tempURL }
 */
async function resolveAvatars(fileIDs) {
  const toFetch = fileIDs.filter(id => id && id.startsWith('cloud://') && !_avatarCache[id])
  if (toFetch.length > 0) {
    try {
      const res = await new Promise((resolve, reject) => {
        wx.cloud.getTempFileURL({
          fileList: toFetch,
          success: resolve,
          fail: reject,
        })
      })
      for (const item of res.fileList) {
        if (item.tempFileURL) _avatarCache[item.fileID] = item.tempFileURL
      }
    } catch (e) {}
  }
  const result = {}
  for (const id of fileIDs) {
    result[id] = _avatarCache[id] || id
  }
  return result
}

module.exports = { formatCard, formatPoints, formatPointsDelta, formatTime, formatCountdown, resolveAvatars }
