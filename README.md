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
│   └── shared/           # 共享模块（扑克逻辑）
├── database-rules.md     # 数据库权限规则
└── README.md
```

## 注意事项

- 所有牌局逻辑在服务端云函数执行，客户端不可信
- 积分变更通过 `settlement` 云函数事务操作，保障原子性
- `game_rounds` 集合客户端无访问权限（含手牌信息）
- 断线重连通过 `db-watch.js` 的 `WatchManager` 自动处理
