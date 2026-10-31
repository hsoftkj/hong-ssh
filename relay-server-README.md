# HongSSH WebRTC 中继服务

这个服务只做 **设备注册、SDP/ICE 信令交换**，不转发屏幕、键鼠或文件。两端能打洞时数据走 WebRTC P2P；只有对称 NAT 需要兜底时，才由 TURN 服务器转发媒体。

## 0. 一键部署（Linux，推荐）

仓库根目录的 [`deploy-relay.sh`](deploy-relay.sh) 是自包含脚本，会把当前 Node.js 版中继服务、依赖和 systemd 服务一起部署到新服务器，不需要先安装 Node.js。

在本机执行：

```bash
scp deploy-relay.sh root@your-server:/root/
ssh root@your-server 'bash /root/deploy-relay.sh'
```

脚本会完成：

- 安装 `curl`、`ca-certificates`、`openssl`、Node.js 20+ 和 `ws` 依赖；
- 创建专用系统用户和 `/opt/hongssh-relay`；
- 首次运行自动生成高熵 `HOST_TOKEN`；
- 写入 `/etc/hongssh-relay.env` 和 systemd 服务；
- 启动服务并做 `/health` 检查；
- 如已启用 ufw/firewalld，自动放行信令端口。

常用参数：

```bash
# 指定端口和 token
sudo bash deploy-relay.sh --port 47891 --token 'your-long-token'

# 直接使用已有证书启用 WSS
sudo bash deploy-relay.sh \
  --tls-cert /etc/letsencrypt/live/relay.example.com/fullchain.pem \
  --tls-key /etc/letsencrypt/live/relay.example.com/privkey.pem

# 配置 STUN/TURN
sudo bash deploy-relay.sh \
  --ice-json '[{"urls":"stun:relay.example.com:3478"},{"urls":"turn:relay.example.com:3478","username":"hongssh","credential":"turn-password"}]'
```

再次执行脚本会更新服务和内嵌的 `relay-server.js`，并保留已生成的 token、端口和 ICE 配置。部署完成后脚本会输出中继地址和 `HOST_TOKEN`，桌面端“中继地址”填写不带 `/signal` 的地址。

要求：Linux + systemd、root 权限、可访问外网安装软件包。没有配置 `--tls-cert/--tls-key` 时默认是 `ws://`，公网使用请在前面加 Caddy/Nginx 提供 `wss://`，或直接使用证书参数。

直接使用 `--tls-cert/--tls-key` 时，脚本会把证书复制到 `/etc/hongssh-relay/tls/` 并限制为服务用户可读。Let's Encrypt 等证书续期后需要重新执行脚本或配置 certbot deploy hook 更新副本并重启服务；更推荐用 Caddy/Nginx 自动管理证书。

## 1. 安装

服务器需要 Node.js 20+：

```bash
mkdir -p /opt/hongssh-relay
cd /opt/hongssh-relay
cp /path/to/relay-server.js .
npm init -y
npm install ws
```

## 2. 启动

```bash
export PORT=47891
export HOST_TOKEN='换成一个足够长的随机字符串'
export ICE_SERVERS_JSON='[{"urls":"stun:stun.example.com:3478"}]'
node relay-server.js
```

公网必须使用 TLS。可以让 Node 直接加载证书：

```bash
export TLS_CERT=/etc/letsencrypt/live/relay.example.com/fullchain.pem
export TLS_KEY=/etc/letsencrypt/live/relay.example.com/privkey.pem
node relay-server.js
```

桌面端填写：

```text
wss://relay.example.com:47891
```

也可以让 Nginx/Caddy 终止 TLS，Node 监听本地 HTTP；桌面端填写 `https://relay.example.com` 或 `wss://relay.example.com`。

### 使用 TURN 兜底

只有 NAT 打洞失败才需要 TURN。使用 coturn 时：

```bash
export ICE_SERVERS_JSON='[
  {"urls":"stun:relay.example.com:3478"},
  {"urls":"turn:relay.example.com:3478","username":"hongssh","credential":"turn-password"}
]'
```

服务器防火墙只需放行：

- TCP `47891`：信令；
- TCP/UDP `3478`：STUN/TURN；
- UDP `49152-65535`：TURN 中继端口（按 coturn 配置）。

没有 TURN 时，双方 NAT 打洞失败会直接连接失败，不会偷偷把画面转到这台服务器。

## 3. systemd

```ini
[Unit]
Description=HongSSH WebRTC signaling relay
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/hongssh-relay
Environment=PORT=47891
Environment=HOST_TOKEN=replace-me
Environment=ICE_SERVERS_JSON=[{"urls":"stun:relay.example.com:3478"}]
ExecStart=/usr/bin/node /opt/hongssh-relay/relay-server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## 4. 健康检查

```bash
curl https://relay.example.com:47891/health
```

返回：

```json
{"ok":true,"agents":1,"sessions":0}
```

## 5. 桌面端配置

### 被控端

`设置 → 公网中继（WebRTC）`：

- 勾选启用；
- 中继地址：`wss://relay.example.com:47891`；
- 本机设备码：自动生成，可重新生成；
- HOST_TOKEN：与服务器一致；
- 同时开启“允许本机被远程控制”并设置口令。

### 控制端

新建远程桌面连接，连接方式选“公网中继（设备码）”，填写同一个中继地址、对方设备码和对方本机口令。

## 6. 安全说明

- 中继服务器只看到信令，不转发正常 P2P 媒体；
- TURN 兜底会看到加密后的 WebRTC 流量，但仍应使用强口令；
- 设备码不是密码，真正的访问控制仍是对方本机口令；
- `HOST_TOKEN` 只用于防止陌生主机注册，不要泄露；
- 当前 Desktop 端对中继 TLS 证书使用 `rejectUnauthorized:false`，公网部署建议使用可信证书，并在后续版本增加证书指纹固定；
- 建议限制设备码尝试频率，或只允许公司出口 IP 访问信令端口。

## 7. 故障判断

- 控制端提示“设备离线”：被控端未启用中继、设备码不一致，或信令服务未运行；
- 设备在线但一直“连接中”：ICE 没有找到可用路径，检查 STUN，必要时配置 TURN；
- 能建立 WebRTC 但认证失败：本机远程口令不一致；
- 画面卡顿：先看是否 P2P；如果走了 TURN，检查 TURN 带宽和 `refreshMs`/画质设置。
