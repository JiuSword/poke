# 云数据库权限规则配置

在微信云开发控制台，对各集合配置以下安全规则：

## users
```json
{
  "read": "auth.openid == doc._openid",
  "write": "auth.openid == doc._openid"
}
```

## rooms
```json
{
  "read": "auth.openid != null",
  "write": false
}
```

## room_views
```json
{
  "read": "auth.openid != null",
  "write": false
}
```

## game_rounds
```json
{
  "read": false,
  "write": false
}
```

## my_cards
```json
{
  "read": "auth.openid == doc._openid",
  "write": false
}
```

## point_records
```json
{
  "read": "auth.openid == doc._openid",
  "write": false
}
```

## ai_sessions
```json
{
  "read": "auth.openid == doc._openid",
  "write": "auth.openid == doc._openid"
}
```

## 索引配置（建议创建）

- `rooms`: roomCode（唯一）、status、lastActivityAt
- `game_rounds`: roomId、phase、actionDeadline
- `point_records`: _openid + settledAt（联合索引）
- `my_cards`: _openid + gameRoundId（联合索引）
