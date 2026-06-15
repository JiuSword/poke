// pages/queen/roles.js —— 客户端角色展示元数据（与云端 engine.js 保持一致）
const ROLES = {
  SNIPER:      { name: '狙击手', emoji: '🎯', init: 1, prestige: 'r', desc: '+1红；翻面敌方点对称位置的牌' },
  ASSASSIN:    { name: '刺客',   emoji: '🗡️', init: 2, prestige: 'r', desc: '+1红；翻面敌方同位置的牌' },
  SCHEMER:     { name: '阴谋家', emoji: '🎭', init: 3, prestige: 'y', desc: '+1黄；使对手退回1个声望' },
  NOBLE:       { name: '贵族',   emoji: '🎩', init: 4, prestige: 'y', desc: '+1黄；再获得任意1个声望' },
  GAMBLER:     { name: '赌徒',   emoji: '🎲', init: 5, prestige: null, desc: '从对手夺取2个声望' },
  PRINCESS:    { name: '公主',   emoji: '👸', init: 6, prestige: null, desc: '翻开己方1张背面牌；被翻面即败' },
  PILOT:       { name: '飞行员', emoji: '✈️', init: 7, prestige: 'b', desc: '+1蓝；交换己方相邻牌最多2次' },
  ENTERTAINER: { name: '艺人',   emoji: '🎻', init: 8, prestige: 'b', desc: '+1蓝；给对手1个再拿对手1个' },
  SPY:         { name: '间谍',   emoji: '🕵️', init: 9, prestige: 'b', desc: '+1蓝；交换对手相邻牌最多2次' },
  RECRUIT:     { name: '新兵',   emoji: '🪖', init: null, prestige: null, desc: '继承主谋的能力与先攻值' },
  GUARD:       { name: '卫兵',   emoji: '🛡️', init: null, prestige: null, desc: '保护相邻牌不被翻面（被动）' },
}
const PRESTIGE = {
  r: { name: '红', label: '威慑', cls: 'p-red' },
  y: { name: '黄', label: '财富', cls: 'p-yellow' },
  b: { name: '蓝', label: '智略', cls: 'p-blue' },
}
const VALID_MASTERS = ['SNIPER', 'ASSASSIN', 'SCHEMER', 'NOBLE', 'PILOT', 'ENTERTAINER', 'SPY']

module.exports = { ROLES, PRESTIGE, VALID_MASTERS }
