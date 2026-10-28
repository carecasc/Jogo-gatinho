/** Mini sistema de animações por quadro, baseado em promessas. */

type Updater = (t: number, dt: number) => void;

interface Tween {
  elapsed: number;
  duration: number;
  update: Updater;
  ease: (t: number) => number;
  resolve: () => void;
}

export const ease = {
  linear: (t: number) => t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number) =>
    t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
};

export class Tweener {
  private tweens: Tween[] = [];

  /** Anima de 0 a 1 em `duration` segundos. */
  tween(duration: number, update: Updater, easing: (t: number) => number = ease.linear): Promise<void> {
    return new Promise((resolve) => {
      const tw: Tween = { elapsed: 0, duration: Math.max(0.0001, duration), update, ease: easing, resolve };
      update(0, 0);
      this.tweens.push(tw);
    });
  }

  wait(seconds: number): Promise<void> {
    return this.tween(seconds, () => {});
  }

  tick(dt: number) {
    if (!this.tweens.length) return;
    const done: Tween[] = [];
    for (const tw of this.tweens) {
      tw.elapsed += dt;
      const t = Math.min(1, tw.elapsed / tw.duration);
      tw.update(tw.ease(t), dt);
      if (t >= 1) done.push(tw);
    }
    if (done.length) {
      this.tweens = this.tweens.filter((t) => !done.includes(t));
      done.forEach((t) => t.resolve());
    }
  }

  /** Termina tudo imediatamente (ex.: ao reconectar). */
  finishAll() {
    const all = this.tweens;
    this.tweens = [];
    for (const tw of all) {
      tw.update(1, 0);
      tw.resolve();
    }
  }
}
