const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const publicDir = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(publicDir, decodeURI(url.split('?')[0]));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

function createAcceptValue(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(secWebSocketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');
}

function encodeMessage(data) {
  const json = JSON.stringify(data);
  const length = Buffer.byteLength(json);
  let headerLength = 2;

  if (length >= 126 && length <= 0xffff) {
    headerLength = 4;
  } else if (length > 0xffff) {
    headerLength = 10;
  }

  const buffer = Buffer.alloc(headerLength + length);
  buffer[0] = 0x81; // text frame

  if (headerLength === 2) {
    buffer[1] = length;
    buffer.write(json, 2);
  } else if (headerLength === 4) {
    buffer[1] = 126;
    buffer.writeUInt16BE(length, 2);
    buffer.write(json, 4);
  } else {
    buffer[1] = 127;
    const high = Math.floor(length / 2 ** 32);
    const low = length >>> 0;
    buffer.writeUInt32BE(high, 2);
    buffer.writeUInt32BE(low, 6);
    buffer.write(json, 10);
  }
  return buffer;
}

function decodeMessages(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const isMasked = (byte2 & 0x80) === 0x80;
    let payloadLength = byte2 & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength += 2;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      payloadLength = high * 2 ** 32 + low;
      headerLength += 8;
    }

    const maskLength = isMasked ? 4 : 0;
    const totalLength = headerLength + maskLength + payloadLength;
    if (offset + totalLength > buffer.length) break;

    const maskingKey = isMasked ? buffer.slice(offset + headerLength, offset + headerLength + 4) : null;
    const payloadStart = offset + headerLength + maskLength;
    const payload = buffer.slice(payloadStart, payloadStart + payloadLength);

    let data;
    if (isMasked && maskingKey) {
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        unmasked[i] = payload[i] ^ maskingKey[i % 4];
      }
      data = unmasked.toString('utf8');
    } else {
      data = payload.toString('utf8');
    }

    if (byte1 === 0x81) {
      try {
        messages.push(JSON.parse(data));
      } catch (error) {
        console.error('Failed to parse message', error);
      }
    }

    offset += totalLength;
  }
  return { messages, remaining: buffer.slice(offset) };
}

let nextRoomId = 1000;
const rooms = new Map(); // roomId -> {clients: Set<Client>, state}

function generateRoomCode() {
  const base = (nextRoomId++).toString(36).toUpperCase();
  return base.padStart(4, '0');
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = crypto.randomBytes(8).toString('hex');
    this.roomId = null;
    this.name = null;
  }

  send(payload) {
    try {
      this.socket.write(encodeMessage(payload));
    } catch (error) {
      console.error('Failed to send message', error);
    }
  }
}

function broadcast(roomId, payload, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const client of room.clients) {
    if (excludeId && client.id === excludeId) continue;
    client.send(payload);
  }
}

function sendRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const players = Array.from(room.clients).map(client => ({
    id: client.id,
    name: client.name
  }));
  broadcast(roomId, {
    type: 'roomData',
    roomId,
    players
  });
}

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }
  const acceptKey = createAcceptValue(req.headers['sec-websocket-key']);
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];
  socket.write(headers.concat('\r\n').join('\r\n'));

  const client = new Client(socket);
  client.send({ type: 'connected', id: client.id });

  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, remaining } = decodeMessages(buffer);
    buffer = remaining;
    for (const message of messages) {
      handleMessage(client, message);
    }
  });

  socket.on('end', () => {
    disconnect(client);
  });

  socket.on('error', err => {
    console.error('Socket error', err);
    disconnect(client);
  });
});

function disconnect(client) {
  if (client.roomId) {
    const room = rooms.get(client.roomId);
    if (room) {
      room.clients.delete(client);
      broadcast(client.roomId, { type: 'playerLeft', playerId: client.id });
      if (room.clients.size === 0) {
        rooms.delete(client.roomId);
      } else {
        sendRoomState(client.roomId);
      }
    }
  }
}

function handleMessage(client, message) {
  switch (message.type) {
    case 'setName': {
      client.name = (message.name || '玩家').slice(0, 12);
      break;
    }
    case 'createRoom': {
      const roomId = generateRoomCode();
      const room = {
        clients: new Set([client]),
        state: null,
        hostId: client.id
      };
      rooms.set(roomId, room);
      client.roomId = roomId;
      client.name = (message.name || '玩家').slice(0, 12);
      client.send({ type: 'roomCreated', roomId, hostId: client.id });
      sendRoomState(roomId);
      break;
    }
    case 'joinRoom': {
      const roomId = (message.roomId || '').toUpperCase();
      const room = rooms.get(roomId);
      if (!room) {
        client.send({ type: 'joinFailed', reason: '房间不存在' });
        return;
      }
      if (room.clients.size >= 2) {
        client.send({ type: 'joinFailed', reason: '房间人数已满' });
        return;
      }
      client.roomId = roomId;
      client.name = (message.name || '玩家').slice(0, 12);
      room.clients.add(client);
      client.send({ type: 'roomJoined', roomId, hostId: room.hostId });
      sendRoomState(roomId);
      if (room.clients.size === 2) {
        broadcast(roomId, { type: 'beginMatch', roomId });
      }
      break;
    }
    case 'leaveRoom': {
      disconnect(client);
      client.roomId = null;
      break;
    }
    case 'shotFired': {
      if (!client.roomId) return;
      broadcast(client.roomId, { type: 'shotFired', from: client.id, data: message.data }, client.id);
      break;
    }
    case 'stateSync': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (room) {
        room.state = message.state;
      }
      broadcast(client.roomId, { type: 'stateSync', from: client.id, state: message.state }, client.id);
      break;
    }
    case 'resetMatch': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room || room.hostId !== client.id) return;
      room.state = null;
      broadcast(client.roomId, { type: 'resetMatch' }, null);
      break;
    }
    case 'chat': {
      if (!client.roomId) return;
      broadcast(client.roomId, { type: 'chat', from: client.id, name: client.name, text: message.text }, null);
      break;
    }
    default:
      break;
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
