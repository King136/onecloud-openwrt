# HomeArena 外部游戏接入协议（v0.10.5）

大厅支持把任意 **H5 游戏**（含 **Cocos Creator Web 导出包**、Laya/Egret 等同理）以 iframe 沙箱方式接入，并由大厅提供**联机能力**（房间、座位、消息组播），游戏本身不需要实现任何后端。

## 一、注册（两步接入）

1. 把游戏（静态文件整体）放到 `app/web/ext/<gameId>/`，入口必须是 `index.html`；
2. 在 `app/server/index.js` 的 `GAMES` 注册表加一行：

```js
mygame: { label: '我的游戏', seats: 4, kind: 'external', engine: 'h5' /* 或 'cocos' */, entry: '/ext/mygame/' },
```

大厅即自动出现卡片（「扩展游戏」分类）、开桌 / 快速开局 / 房间列表 / 观战全部复用。

## 二、桥协议（postMessage）

游戏 iframe 与宿主（大厅房间页）通过 `window.postMessage` 通信，消息必须带命名空间字段：

### 宿主 → 游戏（`ns:'ha'`）

| type | 载荷 | 说明 |
|---|---|---|
| `init` | `seat, room, engine, players[]` | iframe 加载完成后宿主注入，`seat` 为本机座位号（0 基） |
| `room` | `players[]` | 座位名单变化（有人进出 / 断线） |
| `peer` | `from, data` | 其他成员经服务器转发的消息 |

`players[]` 元素：`{ seat, type:'human'|'ai', name, isMe, aiLevel }`

### 游戏 → 宿主（`ns:'ha-game'`）

| type | 载荷 | 说明 |
|---|---|---|
| `ready` | — | 游戏就绪（可选） |
| `peer` | `data` | 任意可 JSON 化对象，服务器组播给房内其他成员（含观战者），单条 ≤ 8KB |
| `move` | `move` | 兼容原生 `game:move` 通道（外部游戏一般不用） |

## 三、联机模型建议（权威端模式，示例见 ext/snake/）

- **权威端 = seat 0（房主）**：收集各端输入（`peer {dir}`），本地模拟，每帧组播 `peer {sync}`；
- 非权威端只发输入、只渲染 sync 帧；
- AI 座位（type==='ai'）由权威端托管；
- 消息都走 `peer`，服务端原样转发，**不解析游戏语义**——任何玩法都能跑。

## 四、Cocos 接入要点

1. Cocos Creator 构建发布选 **Web-Mobile**，产物整体拷入 `ext/<gameId>/`（保留 `cocos-js/`、`application.js` 等相对路径结构）；
2. 在游戏脚本里用同一段桥协议收发消息（`window.parent.postMessage`）；
3. iframe 沙箱已开 `allow-scripts allow-same-origin allow-pointer-lock`，Cocos 的全屏/音频正常可用；
4. 引擎标注 `engine:'cocos'`，大厅卡片会显示 Cocos 标签。

## 五、限制与安全

- iframe `sandbox` 隔离，游戏拿不到大厅 Cookie/账号体系；身份一律以 `init` 注入的 `seat/players` 为准；
- `peer` 消息服务端只做长度限制（防滥用），不校验语义——**不要**在 `peer` 里传越权指令；
- 外部游戏暂不参与战绩统计（`recordGame` 只对原生引擎结算）；
- 本地直开（非 iframe）时建议游戏自带单机模式（示例 snake 已演示双模式自动切换）。
