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

module.exports = { formatCard, formatPoints, formatPointsDelta, formatTime, formatCountdown }
