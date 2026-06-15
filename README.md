# 微信小程序联机德州扑克

## 快速开始

### 1. 配置 AppID 和云环境

- `miniprogram/app.js` → 修改 `cloudEnvId`
- `project.config.json` → 修改 `appid`

### 2. 安装云函数依赖

```bash
cd cloudfunctions/user-auth && npm install
cd ../room-manage && npm install
cd ../game-action && npm install
cd ../game-engine && npm install
cd ../settlement && npm install
cd ../ai-engine && npm install
cd ../timer-scheduler && npm install
```

### 3. 上传云函数

在微信开发者工具中，右键每个云函数目录 → 上传并部署

### 4. 创建数据库集合

在云开发控制台创建以下集合：
- `users`
- `rooms`
- `room_views`
- `game_rounds`
- `my_cards`
- `point_records`
- `ai_sessions`

双人桌游《女王万岁》额外需要：
- `queen_rooms`
- `queen_states`
- `queen_private`

### 5. 配置数据库权限规则

参考 `database-rules.md`

### 6. 配置定时触发器

在云开发控制台，为 `timer-scheduler` 云函数添加定时触发器：
- 触发周期：每分钟（`* * * * *`）

## 项目结构

```
poker-miniprogram/
├── miniprogram/          # 小程序前端
│   ├── pages/            # 页面
│   ├── utils/            # 工具函数
│   └── app.js            # 全局入口
├── cloudfunctions/       # 云函数
│   ├── user-auth/        # 用户认证
│   ├── room-manage/      # 房间管理
│   ├── game-action/      # 游戏操作
│   ├── game-engine/      # 牌局引擎
│   ├── settlement/       # 积分结算
│   ├── ai-engine/        # AI练习
│   ├── timer-scheduler/  # 定时任务
│   ├── queen-room/       # 双人桌游《女王万岁》房间管理
│   ├── queen-game/       # 双人桌游《女王万岁》对战引擎
│   └── shared/           # 共享模块（扑克逻辑）
├── database-rules.md     # 数据库权限规则
└── README.md
```

## 双人桌游《女王万岁》（Long Live the Queen · Dieselpunk）

主页底部「双人桌游」横置入口进入。两大帮派（白玫瑰 / 黑玫瑰）争夺女王之位，
**集齐红黄蓝各 3 声望**，或**翻面对方公主**即获胜。

- 页面：`miniprogram/pages/queen/`（lobby 大厅 / room 候场 / game 棋盘），蒸汽朋克风，独立于德扑视觉。
- 云函数：`queen-room`（创建/加入/准备/开局）、`queen-game`（掷骰/能力结算/决策/布置/结束回合）。
- 规则引擎在 `cloudfunctions/queen-game/lib/`（`engine.js` + `abilities.js`），全部判定在服务端。
- 三集合隐藏信息架构：
  - `queen_rooms`：房间元信息 + **公开棋局视图**（背面牌身份脱敏为 null），双方 watch。
  - `queen_states`：完整真相（客户端不可读）。
  - `queen_private`：每玩家私有视图（仅自己可读，含己方所有牌真身）。
- 纯娱乐，不消耗/不结算积分；回合不计时。

## 注意事项

- 所有牌局逻辑在服务端云函数执行，客户端不可信
- 积分变更通过 `settlement` 云函数事务操作，保障原子性
- `game_rounds` 集合客户端无访问权限（含手牌信息）
- `queen_states` 集合客户端无访问权限；对手背面牌身份仅存于服务端，不进入公开视图
- 断线重连通过 `db-watch.js` 的 `WatchManager` 自动处理
