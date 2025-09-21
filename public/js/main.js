document.addEventListener('DOMContentLoaded', () => {
  const screens = {
    menu: document.getElementById('menu-screen'),
    single: document.getElementById('singleplayer-screen'),
    lobby: document.getElementById('multiplayer-lobby'),
    multi: document.getElementById('multiplayer-game')
  };

  const buttons = {
    single: document.getElementById('single-player-btn'),
    multi: document.getElementById('multiplayer-btn'),
    resetSingle: document.getElementById('reset-single'),
    createRoom: document.getElementById('create-room'),
    joinRoom: document.getElementById('join-room'),
    multiRestart: document.getElementById('multi-restart')
  };

  const backButtons = document.querySelectorAll('.back-btn');

  function showScreen(key) {
    Object.entries(screens).forEach(([name, screen]) => {
      screen.classList.toggle('active', name === key);
    });
  }

  backButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      if (!target) return;
      let key = target;
      if (screens[target]) {
        key = target;
      } else if (target.endsWith('-screen')) {
        key = target.replace('-screen', '');
      } else if (target === 'multiplayer-lobby') {
        key = 'lobby';
      }
      showScreen(key);
      if (key === 'menu') {
        network.disconnect();
        createdRoomInfo.classList.add('hidden');
        joinError.classList.add('hidden');
        hintText.textContent = '等待建立对局';
        roomLabel.textContent = '房间号';
        buttons.multiRestart.disabled = true;
      }
    });
  });

  const singleCanvas = document.getElementById('single-canvas');
  const singleScore = document.getElementById('single-score');
  const singleGame = new BilliardsGame(singleCanvas, {
    mode: 'single',
    onStateChange: state => {
      singleScore.textContent = `已进球: ${state.score}`;
    }
  });

  buttons.resetSingle.addEventListener('click', () => {
    singleGame.resetRack();
  });

  buttons.single.addEventListener('click', () => {
    showScreen('single');
  });

  // Multiplayer logic
  const network = new RealtimeClient();
  const connectionStatus = document.getElementById('connection-status');
  const createdRoomInfo = document.getElementById('created-room-info');
  const joinError = document.getElementById('join-error');
  const roomLabel = document.getElementById('room-label');
  const turnIndicator = document.getElementById('turn-indicator');
  const hintText = document.getElementById('multi-hint');
  const playerOneBox = document.getElementById('player-one');
  const playerTwoBox = document.getElementById('player-two');

  let multiGame = null;
  let currentRoom = null;
  let selfId = null;
  let hostId = null;
  let role = null;
  let players = [];

  function ensureMultiGame() {
    if (multiGame) {
      multiGame.options.role = role;
      return;
    }
    const canvas = document.getElementById('multi-canvas');
    multiGame = new BilliardsGame(canvas, {
      mode: 'multi',
      role,
      onShotFired: data => network.send('shotFired', { data }),
      onShotComplete: state => {
        network.send('stateSync', { state });
        updateTurnInfo(state);
      },
      onStateChange: updateTurnInfo
    });
    multiGame.setInteraction(role === 'host');
  }

  function updateTurnInfo(state) {
    if (!state) return;
    if (state.mode === 'single') return;
    const { turn, scores, winner } = state;
    const you = role === 'host' ? '玩家 1' : '玩家 2';
    const opponent = role === 'host' ? '玩家 2' : '玩家 1';

    const turnText = winner
      ? (winner === (role || 'host') ? '🎉 你获胜了!' : '对手获胜')
      : turn === role
      ? '轮到你出杆'
      : '等待对手...';
    turnIndicator.textContent = turnText;

    const yourScore = role === 'host' ? scores.host : scores.guest;
    const oppScore = role === 'host' ? scores.guest : scores.host;
    playerOneBox.querySelector('.name').textContent = players[0]?.name || '玩家 1';
    playerTwoBox.querySelector('.name').textContent = players[1]?.name || '玩家 2';
    playerOneBox.querySelector('.balls').textContent = `${scores.host} 球`;
    playerTwoBox.querySelector('.balls').textContent = `${scores.guest} 球`;
    playerOneBox.classList.toggle('active', turn === 'host');
    playerTwoBox.classList.toggle('active', turn === 'guest');

    if (multiGame) {
      const allow = multiGame.canControlTurn(role) && !winner;
      multiGame.setInteraction(allow);
      buttons.multiRestart.disabled = !(role === 'host');
      hintText.textContent = turnText;
    }
  }

  function updatePlayersList(data) {
    players = data.players.slice().sort((a, b) => (a.id === hostId ? -1 : b.id === hostId ? 1 : 0));
    const playerNames = players.map(p => p.name);
    hintText.textContent = players.length < 2 ? '等待对手进入房间...' : '对战即将开始';
    playerOneBox.querySelector('.name').textContent = playerNames[0] || '玩家 1';
    playerTwoBox.querySelector('.name').textContent = playerNames[1] || '玩家 2';
  }

  buttons.multi.addEventListener('click', () => {
    showScreen('lobby');
    network.connect();
  });

  network.on('status', status => {
    connectionStatus.textContent = status === 'connected' ? '已连接' : '未连接';
  });

  network.on('connected', data => {
    selfId = data.id;
  });

  network.on('roomCreated', data => {
    currentRoom = data.roomId;
    hostId = data.hostId;
    role = 'host';
    ensureMultiGame();
    roomLabel.textContent = `房间号 ${currentRoom}`;
    createdRoomInfo.classList.remove('hidden');
    createdRoomInfo.textContent = `房间创建成功，分享房号 ${currentRoom} 邀请好友加入。`;
    hintText.textContent = '等待对手加入...';
  });

  network.on('roomJoined', data => {
    currentRoom = data.roomId;
    hostId = data.hostId;
    role = selfId === hostId ? 'host' : 'guest';
    ensureMultiGame();
    showScreen('multi');
    roomLabel.textContent = `房间号 ${currentRoom}`;
    hintText.textContent = '等待房主开始...';
  });

  network.on('joinFailed', data => {
    joinError.classList.remove('hidden');
    joinError.textContent = data.reason || '加入失败';
  });

  network.on('roomData', data => {
    updatePlayersList(data);
    if (currentRoom && data.players.length === 2) {
      hintText.textContent = '双人对战即将开始';
    }
  });

  network.on('beginMatch', () => {
    showScreen('multi');
    if (multiGame) {
      multiGame.resetRack();
      multiGame.options.role = role;
      multiGame.setInteraction(role === 'host');
    }
    buttons.multiRestart.disabled = role !== 'host';
    hintText.textContent = role === 'host' ? '轮到你出杆' : '等待对手...';
    turnIndicator.textContent = hintText.textContent;
  });

  network.on('shotFired', ({ data }) => {
    ensureMultiGame();
    multiGame.applyRemoteShot(data);
  });

  network.on('stateSync', ({ state }) => {
    ensureMultiGame();
    multiGame.syncState(state);
    updateTurnInfo(state);
  });

  network.on('resetMatch', () => {
    if (multiGame) {
      multiGame.resetRack();
      multiGame.setInteraction(role === 'host');
    }
  });

  network.on('playerLeft', () => {
    hintText.textContent = '对手已离开，等待新的玩家加入';
    buttons.multiRestart.disabled = true;
    if (multiGame) {
      multiGame.setInteraction(role === 'host');
    }
  });

    buttons.createRoom.addEventListener('click', () => {
      const name = document.getElementById('create-name').value.trim() || '玩家';
      network.send('createRoom', { name });
      joinError.classList.add('hidden');
    });

    buttons.joinRoom.addEventListener('click', () => {
      const name = document.getElementById('join-name').value.trim() || '玩家';
      const roomId = document.getElementById('join-room-id').value.trim().toUpperCase();
      if (!roomId) {
        joinError.classList.remove('hidden');
        joinError.textContent = '请输入房间号';
        return;
      }
      network.send('joinRoom', { roomId, name });
    });

    buttons.multiRestart.addEventListener('click', () => {
      if (role !== 'host' || !multiGame) return;
      multiGame.resetRack();
      const state = multiGame.serializeState();
      network.send('stateSync', { state });
      network.send('resetMatch', {});
    });

  // tab switch
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-button').forEach(b => b.classList.toggle('active', b === btn));
      document
        .querySelectorAll('[data-tab-content]')
        .forEach(content => content.classList.toggle('active', content.getAttribute('data-tab-content') === tab));
    });
  });
});
