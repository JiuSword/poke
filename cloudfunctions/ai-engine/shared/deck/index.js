// shared/deck/index.js
// 洗牌与发牌工具

const SUITS = ['s', 'h', 'd', 'c'] // spades, hearts, diamonds, clubs
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']

/**
 * 生成标准52张牌组
 * 牌面格式: "As"=黑桃A, "Kh"=红心K, "Td"=方块10, "2c"=梅花2
 */
function createDeck() {
  const deck = []
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(rank + suit)
    }
  }
  return deck
}

/**
 * Fisher-Yates 洗牌
 */
function shuffle(deck) {
  const d = [...deck]
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

/**
 * 从牌堆顶部取出 n 张牌
 * @returns { cards: string[], remaining: string[] }
 */
function deal(deck, n) {
  return {
    cards: deck.slice(0, n),
    remaining: deck.slice(n),
  }
}

/**
 * 创建并洗好的新牌堆
 */
function newShuffledDeck() {
  return shuffle(createDeck())
}

module.exports = { createDeck, shuffle, deal, newShuffledDeck }
