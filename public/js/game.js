(function () {
  const Physics = window.BilliardsPhysics;
  const MAX_SHOT_SPEED = 3.6; // m/s
  const AIM_MAX_DISTANCE = 220;

  class BilliardsGame {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.options = Object.assign(
        {
          mode: 'single',
          playerId: null,
          role: 'solo',
          onShotFired: () => {},
          onShotComplete: () => {},
          onPocket: () => {},
          onStateChange: () => {},
          onLog: () => {}
        },
        options
      );

      this.ctx = canvas.getContext('2d');
      this.table = Physics.createTable(canvas);
      this.balls = Physics.createStandardRack(this.table);
      this.cueBall = this.balls.find(ball => ball.type === 'cue');
      this.lastTimestamp = null;
      this.running = true;
      this.isAiming = false;
      this.aimVector = { x: 0, y: 0, angle: 0, distance: 0 };
      this.interactive = true;
      this.shotInProgress = false;
      this.turn = 'host';
      this.assignments = { host: null, guest: null };
      this.scores = { host: 0, guest: 0 };
      this.singleScore = 0;
      this.currentShotPockets = [];
      this.winner = null;

      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(canvas);
      this.bindPointerEvents();
      requestAnimationFrame(ts => this.loop(ts));
    }

    handleResize() {
      const prevWidth = this.table.width;
      const prevHeight = this.table.height;
      this.table = Physics.createTable(this.canvas);
      const scaleX = this.table.width / prevWidth;
      const scaleY = this.table.height / prevHeight;
      this.balls.forEach(ball => {
        ball.x *= scaleX;
        ball.y *= scaleY;
      });
    }

    resetRack() {
      this.table = Physics.createTable(this.canvas);
      const fresh = Physics.createStandardRack(this.table);
      this.balls.length = 0;
      fresh.forEach(ball => this.balls.push(ball));
      this.cueBall = this.balls.find(ball => ball.type === 'cue');
      this.shotInProgress = false;
      this.currentShotPockets = [];
      this.winner = null;
      if (this.options.mode === 'single') {
        this.singleScore = 0;
        this.interactive = true;
      } else {
        this.scores = { host: 0, guest: 0 };
        this.assignments = { host: null, guest: null };
        this.turn = 'host';
        this.interactive = this.canControlTurn(this.options.role);
      }
      this.notifyState();
    }

    bindPointerEvents() {
      const startAim = evt => {
        if (!this.interactive || this.shotInProgress || this.winner) return;
        const cueBall = this.cueBall;
        const rect = this.canvas.getBoundingClientRect();
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;
        if (Math.hypot(x - cueBall.x, y - cueBall.y) > 80) return;
        this.isAiming = true;
        this.aimStart = { x, y };
        this.updateAim(x, y);
        this.canvas.setPointerCapture(evt.pointerId);
      };

      const moveAim = evt => {
        if (!this.isAiming) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;
        this.updateAim(x, y);
      };

      const endAim = evt => {
        if (!this.isAiming) return;
        this.isAiming = false;
        this.canvas.releasePointerCapture(evt.pointerId);
        this.takeShot();
      };

      this.canvas.addEventListener('pointerdown', startAim);
      this.canvas.addEventListener('pointermove', moveAim);
      this.canvas.addEventListener('pointerup', endAim);
      this.canvas.addEventListener('pointercancel', endAim);
    }

    updateAim(x, y) {
      const cueBall = this.cueBall;
      const dx = cueBall.x - x;
      const dy = cueBall.y - y;
      const distance = Math.min(Math.hypot(dx, dy), AIM_MAX_DISTANCE);
      const angle = Math.atan2(dy, dx);
      this.aimVector = { x: dx, y: dy, distance, angle };
    }

    takeShot() {
      if (!this.aimVector.distance) return;
      const power = Math.min(this.aimVector.distance / AIM_MAX_DISTANCE, 1);
      const angle = this.aimVector.angle + Math.PI; // reverse because aim vector points from cue to pointer
      const vx = Math.cos(angle) * MAX_SHOT_SPEED * power;
      const vy = Math.sin(angle) * MAX_SHOT_SPEED * power;

      this.cueBall.vx = vx;
      this.cueBall.vy = vy;
      this.shotInProgress = true;
      this.interactive = false;
      this.currentShotPockets = [];

      if (this.options.mode === 'multi') {
        this.options.onShotFired({ angle, power });
      }
    }

    applyRemoteShot({ angle, power }) {
      const vx = Math.cos(angle) * MAX_SHOT_SPEED * power;
      const vy = Math.sin(angle) * MAX_SHOT_SPEED * power;
      this.cueBall.vx = vx;
      this.cueBall.vy = vy;
      this.shotInProgress = true;
      this.interactive = false;
      this.currentShotPockets = [];
    }

    syncState(state) {
      Physics.applySerializedState(this.balls, state.balls);
      this.turn = state.turn;
      this.assignments = state.assignments;
      this.scores = state.scores;
      this.winner = state.winner;
      this.interactive = this.canControlTurn(this.options.role) && !this.winner;
      this.notifyState();
    }

    serializeState() {
      return {
        balls: Physics.serializeBalls(this.balls),
        turn: this.turn,
        assignments: this.assignments,
        scores: this.scores,
        winner: this.winner
      };
    }

    loop(timestamp) {
      if (!this.lastTimestamp) this.lastTimestamp = timestamp;
      const dt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.04);
      this.lastTimestamp = timestamp;

      const anyMoving = this.update(dt);
      this.draw();

      if (!anyMoving && this.shotInProgress) {
        this.shotInProgress = false;
        this.handleShotFinished();
      }

      if (this.running) {
        requestAnimationFrame(ts => this.loop(ts));
      }
    }

    update(dt) {
      const result = Physics.updateBalls(this.balls, this.table, dt, {
        onPocket: ball => this.currentShotPockets.push(ball)
      });
      return result.moving;
    }

    handleShotFinished() {
      let cueBallPocketed = false;
      let scored = 0;

      for (const ball of this.currentShotPockets) {
        if (ball.type === 'cue') {
          cueBallPocketed = true;
        } else if (this.options.mode === 'single') {
          this.singleScore++;
        } else {
          const player = this.turn;
          if (ball.type === 'eight') {
            this.winner = this.checkEightBallOutcome(player);
          } else {
            if (!this.assignments.host && !this.assignments.guest) {
              this.assignments[player] = ball.type;
              const opponent = player === 'host' ? 'guest' : 'host';
              this.assignments[opponent] = ball.type === 'solid' ? 'stripe' : 'solid';
            }
            if (!this.assignments[player] || this.assignments[player] === ball.type) {
              this.scores[player] += 1;
              scored++;
            } else {
              // wrong ball, treat as foul
              cueBallPocketed = true;
            }
          }
        }
        if (this.options.onPocket) {
          this.options.onPocket(ball);
        }
      }

      if (this.options.mode === 'single') {
        this.repositionCue();
        this.interactive = true;
        this.notifyState();
        return;
      }

      if (cueBallPocketed) {
        this.repositionCue();
      } else if (!this.cueBall.pocketed && (this.cueBall.vx !== 0 || this.cueBall.vy !== 0)) {
        // ensure cue is stationary
        this.cueBall.vx = 0;
        this.cueBall.vy = 0;
      }

      if (!this.winner) {
        if (scored === 0 || cueBallPocketed) {
          this.turn = this.turn === 'host' ? 'guest' : 'host';
        }
      }

      if (this.options.mode === 'multi') {
        this.interactive = this.canControlTurn(this.options.role) && !this.winner;
        const state = this.serializeState();
        this.options.onShotComplete(state);
      }

      this.notifyState();
    }

    canControlTurn(role) {
      if (role === 'host') {
        return this.turn === 'host';
      }
      if (role === 'guest') {
        return this.turn === 'guest';
      }
      return true;
    }

    repositionCue() {
      const cueBall = this.cueBall;
      if (!cueBall.pocketed) return;
      const startX = this.table.width * 0.25;
      const startY = this.table.height / 2;
      cueBall.x = startX;
      cueBall.y = startY;
      cueBall.vx = 0;
      cueBall.vy = 0;
      cueBall.pocketed = false;
    }

    checkEightBallOutcome(player) {
      const targetCount = 7;
      if (this.assignments[player]) {
        if (this.scores[player] >= targetCount) {
          return player;
        }
        const opponent = player === 'host' ? 'guest' : 'host';
        return opponent;
      }
      // before assignment, eight ball pocket is loss
      const opponent = player === 'host' ? 'guest' : 'host';
      return opponent;
    }

    draw() {
      const ctx = this.table.ctx;
      const { width, height } = this.table;
      ctx.clearRect(0, 0, width, height);

      drawTable(ctx, width, height, this.table.pockets);
      this.drawBalls(ctx);
      if (this.isAiming) {
        this.drawCue(ctx);
      }
    }

    drawBalls(ctx) {
      for (const ball of this.balls) {
        if (ball.pocketed) continue;
        ctx.save();
        ctx.translate(ball.x, ball.y);
        drawBall(ctx, ball, this.table.scale);
        ctx.restore();
      }
    }

    drawCue(ctx) {
      const cueBall = this.cueBall;
      const angle = this.aimVector.angle + Math.PI;
      const distance = Math.min(this.aimVector.distance, AIM_MAX_DISTANCE);
      const cueLength = 240;
      const offset = distance + 20;
      const startX = cueBall.x - Math.cos(angle) * offset;
      const startY = cueBall.y - Math.sin(angle) * offset;
      const endX = startX - Math.cos(angle) * cueLength;
      const endY = startY - Math.sin(angle) * cueLength;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(220, 200, 120, 0.95)';
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cueBall.x, cueBall.y);
      ctx.lineTo(cueBall.x + Math.cos(angle) * 240, cueBall.y + Math.sin(angle) * 240);
      ctx.stroke();
      ctx.restore();
    }

    notifyState() {
      if (this.options.mode === 'single') {
        this.options.onStateChange({
          mode: 'single',
          score: this.singleScore
        });
      } else {
        this.options.onStateChange({
          mode: 'multi',
          turn: this.turn,
          assignments: this.assignments,
          scores: this.scores,
          winner: this.winner
        });
      }
    }

    setInteraction(enabled) {
      this.interactive = enabled;
    }
  }

  function drawTable(ctx, width, height, pockets) {
    ctx.save();
    ctx.fillStyle = '#064f2a';
    ctx.fillRect(0, 0, width, height);

    ctx.lineWidth = 18;
    ctx.strokeStyle = '#3b1f0a';
    ctx.strokeRect(0, 0, width, height);

    ctx.fillStyle = '#000000';
    pockets.forEach(pocket => {
      ctx.beginPath();
      ctx.arc(pocket.x, pocket.y, pocket.r * 0.62, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawBall(ctx, ball, scale) {
    const radiusPx = ball.radius * scale;
    const gradient = ctx.createRadialGradient(-radiusPx * 0.4, -radiusPx * 0.4, radiusPx * 0.1, 0, 0, radiusPx);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.2, ball.color);
    gradient.addColorStop(1, shadeColor(ball.color, -0.4));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(-radiusPx * 0.3, -radiusPx * 0.3, radiusPx * 0.25, 0, Math.PI * 2);
    ctx.fill();

    if (ball.type === 'eight') {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, radiusPx * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = `${radiusPx * 0.6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('8', 0, 0);
    } else if (ball.type === 'cue') {
      ctx.fillStyle = '#f7f7f7';
      ctx.beginPath();
      ctx.arc(0, 0, radiusPx * 0.35, 0, Math.PI * 2);
      ctx.fill();
    } else if (ball.type === 'stripe') {
      ctx.save();
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = shadeColor(ball.color, -0.25);
      ctx.fillRect(-radiusPx, -radiusPx * 0.35, radiusPx * 2, radiusPx * 0.7);
      ctx.restore();
    }
  }

  function shadeColor(color, percent) {
    const num = parseInt(color.replace('#', ''), 16);
    let r = (num >> 16) + Math.round(255 * percent);
    let g = ((num >> 8) & 0x00ff) + Math.round(255 * percent);
    let b = (num & 0x0000ff) + Math.round(255 * percent);
    r = Math.max(Math.min(255, r), 0);
    g = Math.max(Math.min(255, g), 0);
    b = Math.max(Math.min(255, b), 0);
    return `rgb(${r}, ${g}, ${b})`;
  }

  window.BilliardsGame = BilliardsGame;
})();
