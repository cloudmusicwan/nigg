class RealtimeClient {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.status = 'disconnected';
    this.reconnectDelay = 1500;
    this.shouldReconnect = false;
  }

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${protocol}://${location.host}`);
    this.status = 'connecting';
    this.shouldReconnect = true;

    this.socket.addEventListener('open', () => {
      this.status = 'connected';
      this.emit('status', this.status);
    });

    this.socket.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data);
        this.emit(data.type, data);
      } catch (error) {
        console.error('无法解析服务器消息', error);
      }
    });

    this.socket.addEventListener('close', () => {
      this.status = 'disconnected';
      this.emit('status', this.status);
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    });

    this.socket.addEventListener('error', err => {
      console.error('WebSocket 错误', err);
      this.socket.close();
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.close();
    }
  }

  on(type, handler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type).add(handler);
  }

  off(type, handler) {
    if (this.handlers.has(type)) {
      this.handlers.get(type).delete(handler);
    }
  }

  emit(type, data) {
    const handlers = this.handlers.get(type);
    if (!handlers) return;
    handlers.forEach(handler => handler(data));
  }

  send(type, payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type, ...payload });
    this.socket.send(message);
  }
}

window.RealtimeClient = RealtimeClient;
