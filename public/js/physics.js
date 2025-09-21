(function () {
  const TABLE_WIDTH = 2.84;
  const TABLE_HEIGHT = 1.42;
  const BALL_DIAMETER = 0.05715;
  const BALL_RADIUS = BALL_DIAMETER / 2;
  const FRICTION = 0.18;
  const REST_THRESHOLD = 0.02;
  const CUSHION_RESTITUTION = 0.92;

  function createTable(canvas) {
    const aspect = TABLE_WIDTH / TABLE_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    let width = canvas.clientWidth;
    let height = width / aspect;
    if (canvas.clientHeight && height > canvas.clientHeight) {
      height = canvas.clientHeight;
      width = height * aspect;
    }
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {
      width,
      height,
      scale: width / TABLE_WIDTH,
      ctx,
      pockets: createPockets(width, height)
    };
  }

  function createPockets(width, height) {
    const pocketRadius = Math.min(width, height) * 0.06;
    return [
      { x: 0, y: 0, r: pocketRadius * 1.1 },
      { x: width / 2, y: 0, r: pocketRadius },
      { x: width, y: 0, r: pocketRadius * 1.1 },
      { x: 0, y: height, r: pocketRadius * 1.1 },
      { x: width / 2, y: height, r: pocketRadius },
      { x: width, y: height, r: pocketRadius * 1.1 }
    ];
  }

  function createBall(id, x, y, color, type = 'object') {
    return {
      id,
      type,
      color,
      x,
      y,
      vx: 0,
      vy: 0,
      radius: BALL_RADIUS,
      pocketed: false
    };
  }

  function createStandardRack(table) {
    const spacing = BALL_DIAMETER * table.scale * 0.98;
    const baseX = table.width * 0.72;
    const baseY = table.height / 2;
    const balls = [];

    const colors = {
      solids: ['#f24c4c', '#f5a623', '#3e64ff', '#2ecc71', '#9b59b6', '#e67e22', '#16a085'],
      stripes: ['#fbc531', '#8c7ae6', '#4cd137', '#00a8ff', '#e84118', '#487eb0', '#44bd32']
    };

    balls.push(createBall('cue', table.width * 0.22, table.height / 2, '#ffffff', 'cue'));

    let solidIndex = 0;
    let stripeIndex = 0;
    const layout = [1, 2, 3, 4, 5];
    let id = 1;

    for (let row = 0; row < layout.length; row++) {
      const count = layout[row];
      for (let i = 0; i < count; i++) {
        const x = baseX + row * spacing;
        const y = baseY + (i - (count - 1) / 2) * spacing;
        let type = 'solid';
        let color = colors.solids[solidIndex % colors.solids.length];

        if (row === 2 && i === Math.floor(count / 2)) {
          type = 'eight';
          color = '#111111';
        } else if ((row + i) % 2 === 1) {
          type = 'stripe';
          color = colors.stripes[stripeIndex % colors.stripes.length];
          stripeIndex++;
        } else {
          solidIndex++;
        }

        balls.push(createBall(`ball-${id++}`, x, y, color, type));
      }
    }

    return balls;
  }

  function updateBalls(balls, table, dt, events = {}) {
    const scale = table.scale;
    const pocketedThisFrame = [];
    const activeBalls = balls.filter(ball => !ball.pocketed);

    for (const ball of activeBalls) {
      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed > 0) {
        const decel = FRICTION * dt;
        const nextSpeed = Math.max(speed - decel, 0);
        const ratio = nextSpeed / speed;
        ball.vx *= ratio;
        ball.vy *= ratio;
      }

      ball.x += ball.vx * dt * scale;
      ball.y += ball.vy * dt * scale;

      handleCushionCollision(ball, table);
    }

    for (let i = 0; i < activeBalls.length; i++) {
      for (let j = i + 1; j < activeBalls.length; j++) {
        resolveBallCollision(activeBalls[i], activeBalls[j], scale);
      }
    }

    for (const ball of activeBalls) {
      for (const pocket of table.pockets) {
        const dx = ball.x - pocket.x;
        const dy = ball.y - pocket.y;
        const dist = Math.hypot(dx, dy);
        if (dist < pocket.r * 0.63) {
          ball.pocketed = true;
          ball.vx = 0;
          ball.vy = 0;
          pocketedThisFrame.push(ball);
          if (events.onPocket) {
            events.onPocket(ball);
          }
          break;
        }
      }
    }

    for (const ball of activeBalls) {
      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed < REST_THRESHOLD) {
        ball.vx = 0;
        ball.vy = 0;
      }
    }

    const moving = activeBalls.some(ball => Math.hypot(ball.vx, ball.vy) > REST_THRESHOLD);
    return { moving, pocketed: pocketedThisFrame };
  }

  function handleCushionCollision(ball, table) {
    const rPx = ball.radius * table.scale;
    let hit = false;

    if (ball.x - rPx < 0) {
      ball.x = rPx;
      ball.vx = Math.abs(ball.vx) * CUSHION_RESTITUTION;
      hit = true;
    } else if (ball.x + rPx > table.width) {
      ball.x = table.width - rPx;
      ball.vx = -Math.abs(ball.vx) * CUSHION_RESTITUTION;
      hit = true;
    }

    if (ball.y - rPx < 0) {
      ball.y = rPx;
      ball.vy = Math.abs(ball.vy) * CUSHION_RESTITUTION;
      hit = true;
    } else if (ball.y + rPx > table.height) {
      ball.y = table.height - rPx;
      ball.vy = -Math.abs(ball.vy) * CUSHION_RESTITUTION;
      hit = true;
    }

    if (hit && typeof table.onRail === 'function') {
      table.onRail(ball);
    }
  }

  function resolveBallCollision(a, b, scale) {
    const radius = BALL_RADIUS * scale;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = radius * 2;

    if (dist === 0 || dist >= minDist) {
      return;
    }

    const overlap = minDist - dist;
    const nx = dx / dist;
    const ny = dy / dist;

    a.x -= (overlap / 2) * nx;
    a.y -= (overlap / 2) * ny;
    b.x += (overlap / 2) * nx;
    b.y += (overlap / 2) * ny;

    const dvx = b.vx - a.vx;
    const dvy = b.vy - a.vy;
    const impactSpeed = dvx * nx + dvy * ny;

    if (impactSpeed > 0) return;

    const impulse = -(1 + 0.98) * impactSpeed / 2;
    const impulseX = impulse * nx;
    const impulseY = impulse * ny;

    a.vx -= impulseX;
    a.vy -= impulseY;
    b.vx += impulseX;
    b.vy += impulseY;
  }

  function serializeBalls(balls) {
    return balls.map(ball => ({
      id: ball.id,
      type: ball.type,
      color: ball.color,
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      pocketed: ball.pocketed
    }));
  }

  function applySerializedState(balls, serialized) {
    const byId = new Map(balls.map(ball => [ball.id, ball]));
    serialized.forEach(state => {
      const ball = byId.get(state.id);
      if (!ball) return;
      Object.assign(ball, {
        x: state.x,
        y: state.y,
        vx: state.vx,
        vy: state.vy,
        pocketed: state.pocketed
      });
    });
  }

  window.BilliardsPhysics = {
    TABLE_WIDTH,
    TABLE_HEIGHT,
    BALL_RADIUS,
    createTable,
    createStandardRack,
    updateBalls,
    serializeBalls,
    applySerializedState
  };
})();
