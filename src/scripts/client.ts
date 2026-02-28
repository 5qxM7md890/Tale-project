import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

type Quality = 'high' | 'med' | 'low';
type ChapterName = 'hero' | 'featured' | 'capabilities' | 'process' | 'studio' | 'recognition' | 'contact';

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function pickQuality(): Quality {
  if (prefersReducedMotion()) return 'low';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as any).deviceMemory || 4;
  if (dpr <= 1 || cores <= 4 || mem <= 4) return 'med';
  return 'high';
}

function canWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function getAccent(): string {
  const meta = document.querySelector('meta[name="tale-accent"]') as HTMLMetaElement | null;
  return meta?.content?.trim() || '#7c5cff';
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function createStatusPill(): HTMLDivElement {
  const existing = document.getElementById('tale-status') as HTMLDivElement | null;
  if (existing) return existing;

  const el = document.createElement('div');
  el.id = 'tale-status';
  el.style.position = 'fixed';
  el.style.left = '12px';
  el.style.bottom = '12px';
  el.style.zIndex = '9999';
  el.style.padding = '8px 10px';
  el.style.borderRadius = '12px';
  el.style.border = '1px solid rgba(255,255,255,0.16)';
  el.style.background = 'rgba(0,0,0,0.55)';
  el.style.backdropFilter = 'blur(10px)';
  el.style.color = 'rgba(255,255,255,0.85)';
  el.style.fontSize = '12px';
  el.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  el.textContent = '3D: booting…';
  document.body.appendChild(el);
  return el;
}

/**
 * Realistic SFX approach:
 * - We ship short WAVs in /public/sfx/*.wav (procedurally generated).
 * - If anything fails, we fall back to synth so the experience never goes silent.
 */
class SfxEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private ambience!: GainNode;
  private sfx!: GainNode;
  private convolver!: ConvolverNode;
  private compressor!: DynamicsCompressorNode;
  private buffers: Record<string, AudioBuffer> = {};
  private ambientSource: AudioBufferSourceNode | null = null;

  init() {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioCtx();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;

    this.ambience = this.ctx.createGain();
    this.ambience.gain.value = 0.33;

    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.78;

    // light reverb (generated impulse)
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(1.05, 0.9);

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -22;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 3.5;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.12;

    this.ambience.connect(this.convolver);
    this.sfx.connect(this.convolver);
    this.convolver.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  async resume() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {}
    }
    // fade in master
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0, now);
    this.master.gain.linearRampToValueAtTime(0.9, now + 0.55);
  }

  async loadAll(): Promise<{ ok: boolean; missing: string[] }> {
    if (!this.ctx) return { ok: false, missing: ['audio-context'] };

    const files = [
      ['ambient', '/sfx/ambient_loop.wav'],
      ['whoosh1', '/sfx/whoosh_01.wav'],
      ['whoosh2', '/sfx/whoosh_02.wav'],
      ['chime1', '/sfx/chime_01.wav'],
      ['chime2', '/sfx/chime_02.wav'],
      ['impact1', '/sfx/impact_01.wav'],
      ['impact2', '/sfx/impact_02.wav'],
      ['tick1', '/sfx/tick_01.wav'],
      ['tick2', '/sfx/tick_02.wav'],
    ] as const;

    const missing: string[] = [];

    await Promise.all(
      files.map(async ([key, url]) => {
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const audio = await this.ctx!.decodeAudioData(buf.slice(0));
          this.buffers[key] = audio;
        } catch (e) {
          missing.push(key);
          console.warn('[Tale] SFX load failed:', key, e);
        }
      }),
    );

    return { ok: missing.length === 0, missing };
  }

  startAmbient() {
    if (!this.ctx) return;
    if (!this.buffers['ambient']) return;
    if (this.ambientSource) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers['ambient'];
    src.loop = true;
    src.connect(this.ambience);
    src.start();
    this.ambientSource = src;
  }

  stop() {
    if (!this.ctx) return;

    try {
      this.ambientSource?.stop();
    } catch {}
    this.ambientSource = null;

    const ctx = this.ctx;
    this.ctx = null;

    setTimeout(() => {
      try {
        ctx.close();
      } catch {}
    }, 0);
  }

  isOn() {
    return !!this.ctx;
  }

  // 0..1 proxy for audio-reactive visuals
  level(): number {
    if (!this.ctx) return 0;
    // use master gain plus tiny randomness for motion
    const g = this.master?.gain?.value ?? 0;
    return clamp01(g * 0.25 + Math.random() * 0.015);
  }

  playCue(kind: 'whoosh' | 'chime' | 'impact' | 'tick') {
    if (!this.ctx) return;

    const pick = (a: string, b: string) => (Math.random() < 0.5 ? a : b);
    const key =
      kind === 'whoosh'
        ? pick('whoosh1', 'whoosh2')
        : kind === 'chime'
          ? pick('chime1', 'chime2')
          : kind === 'impact'
            ? pick('impact1', 'impact2')
            : pick('tick1', 'tick2');

    const buf = this.buffers[key];
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const g = this.ctx.createGain();
      g.gain.value = kind === 'impact' ? 0.9 : kind === 'whoosh' ? 0.75 : kind === 'chime' ? 0.55 : 0.35;

      src.playbackRate.value = 0.95 + Math.random() * 0.1;

      src.connect(g);
      g.connect(this.sfx);
      src.start();
      return;
    }

    // fallback synth
    this.synthFallback(kind);
  }

  private synthFallback(kind: string) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;

    if (kind === 'tick') {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1200;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
      osc.connect(g);
      g.connect(this.sfx);
      osc.start(t0);
      osc.stop(t0 + 0.07);
      return;
    }

    if (kind === 'chime') {
      const freqs = [660, 990, 1320];
      freqs.forEach((f, i) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.value = f * (0.98 + Math.random() * 0.04);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.22 / (i + 1), t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
        osc.connect(g);
        g.connect(this.sfx);
        osc.start(t0);
        osc.stop(t0 + 0.65);
      });
      return;
    }

    // noise-based for whoosh/impact
    const bufferSize = Math.floor(this.ctx.sampleRate * (kind === 'impact' ? 0.28 : 0.85));
    const noise = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;

    const src = this.ctx.createBufferSource();
    src.buffer = noise;

    const filter = this.ctx.createBiquadFilter();
    filter.type = kind === 'impact' ? 'lowpass' : 'bandpass';
    filter.frequency.setValueAtTime(kind === 'impact' ? 400 : 120, t0);
    filter.frequency.linearRampToValueAtTime(kind === 'impact' ? 120 : 1500, t0 + (kind === 'impact' ? 0.18 : 0.78));
    filter.Q.value = kind === 'impact' ? 0.7 : 0.9;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(kind === 'impact' ? 0.9 : 0.55, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === 'impact' ? 0.28 : 0.9));

    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfx);

    src.start(t0);
    src.stop(t0 + (kind === 'impact' ? 0.3 : 0.9));
  }

  private makeImpulse(seconds: number, decay: number) {
    if (!this.ctx) return null;
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const impulse = this.ctx.createBuffer(2, length, rate);

    for (let ch = 0; ch < 2; ch++) {
      const chan = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const n = Math.random() * 2 - 1;
        chan[i] = n * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }
}

// -------------------- WebGL app with chapters --------------------
class TaleWebGLApp {
  private quality: Quality;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private pmrem: THREE.PMREMGenerator;
  private accent = new THREE.Color(getAccent());
  private clock = new THREE.Clock();

  private orb: THREE.Mesh;
  private knot: THREE.Mesh;
  private stars: THREE.Points;
  private swarm: THREE.InstancedMesh;

  private pointerX = 0;
  private pointerY = 0;
  private scrollT = 0;

  private currentChapter: { index: number; id: ChapterName } = { index: 0, id: 'hero' };
  private chapterEls: HTMLElement[] = [];
  private chapterObserver: IntersectionObserver | null = null;

  private opacity = 1;
  private readonly sfx = new SfxEngine();

  constructor(private canvas: HTMLCanvasElement, private statusEl: HTMLDivElement) {
    this.quality = pickQuality();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality !== 'low',
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.12);

    this.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 0.12, 6.6);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // lights
    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(2.8, 2.2, 3.3);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fb0ff, 1.0);
    fill.position.set(-2.6, -0.5, 2.0);
    this.scene.add(fill);

    // Orb
    const orbGeo = new THREE.IcosahedronGeometry(0.92, this.quality === 'high' ? 5 : 4);
    const orbMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#d7dcff'),
      roughness: 0.22,
      metalness: 0.82,
      clearcoat: 0.92,
      clearcoatRoughness: 0.18,
      emissive: this.accent.clone().multiplyScalar(0.12),
      emissiveIntensity: 0.5,
    });
    this.orb = new THREE.Mesh(orbGeo, orbMat);
    this.scene.add(this.orb);

    // Knot
    const knotGeo = new THREE.TorusKnotGeometry(0.46, 0.14, this.quality === 'high' ? 220 : 180, 20);
    const knotMat = new THREE.MeshStandardMaterial({
      color: this.accent.clone().lerp(new THREE.Color('#ffffff'), 0.25),
      roughness: 0.36,
      metalness: 0.6,
      emissive: this.accent.clone().multiplyScalar(0.08),
      emissiveIntensity: 0.42,
    });
    this.knot = new THREE.Mesh(knotGeo, knotMat);
    this.scene.add(this.knot);

    // stars
    this.stars = this.makeStars(this.quality === 'high' ? 1300 : 900);
    this.scene.add(this.stars);

    // swarm
    this.swarm = this.makeSwarm(this.quality === 'high' ? 260 : 180);
    this.scene.add(this.swarm);

    // Post FX
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.6, 0.85);
    this.composer.addPass(this.bloom);

    // input
    window.addEventListener('pointermove', (e) => {
      this.pointerX = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    });

    window.addEventListener('scroll', () => this.onScroll(), { passive: true });
    window.addEventListener('resize', () => this.onResize());

    // home link behavior
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a[data-home]') as HTMLAnchorElement | null;
      if (!a) return;
      if (location.pathname === '/') {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    this.onResize();
    this.onScroll();
    this.setAccent(getAccent());
    this.setChapter(0, 'hero', true);

    this.wireSoundButton();
    this.rebindChapters();

    this.status(`3D: ON • hero • sound off`);
  }

  private status(msg: string) {
    this.statusEl.textContent = msg;
  }

  private makeStars(count: number) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const r = 10 + Math.random() * 30;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3 + 0] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.35;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ size: 0.055, color: 0xffffff, opacity: 0.88, transparent: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.position.y = -0.4;
    return pts;
  }

  private makeSwarm(count: number) {
    const geo = new THREE.IcosahedronGeometry(0.085, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: this.accent.clone(),
      roughness: 0.5,
      metalness: 0.52,
      emissive: this.accent.clone().multiplyScalar(0.07),
      emissiveIntensity: 0.33,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * 3.0;
      const y = (Math.random() * 2 - 1) * 1.5;
      const z = (Math.random() * 2 - 1) * 2.0 - 1.0;
      dummy.position.set(x, y, z);
      dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const s = 0.6 + Math.random() * 1.2;
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.position.set(0.15, 0.05, -0.9);
    return mesh;
  }

  private setAccent(hex: string) {
    this.accent.set(hex);

    (this.orb.material as THREE.MeshPhysicalMaterial).emissive.copy(this.accent).multiplyScalar(0.12);
    (this.knot.material as THREE.MeshStandardMaterial).color.copy(this.accent).lerp(new THREE.Color('#ffffff'), 0.25);
    (this.knot.material as THREE.MeshStandardMaterial).emissive.copy(this.accent).multiplyScalar(0.08);
    (this.swarm.material as THREE.MeshStandardMaterial).color.copy(this.accent);
    (this.swarm.material as THREE.MeshStandardMaterial).emissive.copy(this.accent).multiplyScalar(0.07);
  }

  private onScroll() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    this.scrollT = window.scrollY / max;

    // fade after hero (protect reading)
    const hero = document.querySelector('[data-chapter-index="0"]') as HTMLElement | null;
    if (hero) {
      const rect = hero.getBoundingClientRect();
      const progressPastHero = clamp01((-(rect.bottom) + window.innerHeight * 0.2) / (window.innerHeight * 0.9));
      this.opacity = 1.0 - progressPastHero * 0.55; // keep presence
    } else {
      this.opacity = 0.85;
    }

    // apply to canvas directly (simple & robust)
    this.canvas.style.opacity = String(this.opacity);
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  private wireSoundButton() {
    const btn = document.getElementById('sound-toggle') as HTMLButtonElement | null;
    if (!btn) return;

    const sync = (state?: 'loading' | 'on' | 'off') => {
      const on = this.sfx.isOn();
      if (state === 'loading') btn.textContent = 'Sound: Loading…';
      else btn.textContent = on ? 'Sound: On' : 'Sound: Off';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.status(`3D: ON • ${this.currentChapter.id} • sound ${state === 'loading' ? 'loading' : on ? 'on' : 'off'}`);
    };

    sync('off');

    btn.addEventListener('click', async () => {
      if (!this.sfx.isOn()) {
        sync('loading');
        this.sfx.init();
        await this.sfx.resume();

        const { ok, missing } = await this.sfx.loadAll();
        this.sfx.startAmbient();
        this.sfx.playCue('chime');

        if (!ok) {
          // still works via synth fallback, but tell the user what happened
          this.status(`3D: ON • ${this.currentChapter.id} • sound on (missing: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? '…' : ''})`);
        }
      } else {
        this.sfx.playCue('tick');
        this.sfx.stop();
      }
      sync();
    });
  }

  rebindChapters() {
    this.chapterObserver?.disconnect();
    this.chapterEls = Array.from(document.querySelectorAll('[data-chapter]')) as HTMLElement[];

    if (this.chapterEls.length === 0) {
      this.status(`3D: ON • hero • no chapters found`);
      return;
    }

    this.chapterObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;

        const el = visible.target as HTMLElement;
        const idx = Number(el.dataset.chapterIndex || 0);
        const id = (el.id || 'hero') as ChapterName;
        this.setChapter(idx, id, false);
      },
      { root: null, threshold: [0.25, 0.35, 0.5, 0.65] },
    );

    this.chapterEls.forEach((el) => this.chapterObserver!.observe(el));
  }

  private setChapter(index: number, id: ChapterName, immediate: boolean) {
    if (this.currentChapter.index === index && this.currentChapter.id === id) return;
    this.currentChapter = { index, id };

    // Sound cue on chapter transitions (only if enabled)
    if (this.sfx.isOn()) {
      if (id === 'hero') this.sfx.playCue('chime');
      else if (id === 'featured' || id === 'capabilities') this.sfx.playCue('whoosh');
      else if (id === 'process') this.sfx.playCue('tick');
      else if (id === 'studio') this.sfx.playCue('whoosh');
      else if (id === 'recognition') this.sfx.playCue('impact');
      else this.sfx.playCue('chime');
    }

    // Layout targets per chapter (keeps text readable)
    const mobile = window.innerWidth < 768;
    const set = (o: THREE.Object3D, x: number, y: number, z: number) => o.position.set(x, y, z);

    if (id === 'hero') {
      set(this.orb, mobile ? 0.95 : 1.65, 0.26, -0.25);
      set(this.knot, mobile ? 0.18 : 0.35, -0.35, -0.9);
      this.bloom.strength = 0.75;
    } else if (id === 'featured') {
      set(this.orb, mobile ? 0.72 : 1.25, 0.16, -0.45);
      set(this.knot, mobile ? -0.05 : 0.15, -0.25, -1.0);
      this.bloom.strength = 0.68;
    } else if (id === 'capabilities') {
      set(this.orb, mobile ? 0.55 : 1.05, 0.1, -0.6);
      set(this.knot, mobile ? -0.18 : -0.25, -0.15, -1.1);
      this.bloom.strength = 0.64;
    } else if (id === 'process') {
      set(this.orb, mobile ? 0.25 : 0.78, 0.05, -0.72);
      set(this.knot, mobile ? -0.32 : -0.58, -0.1, -1.2);
      this.bloom.strength = 0.58;
    } else if (id === 'studio') {
      set(this.orb, mobile ? 0.35 : 0.95, 0.08, -0.62);
      set(this.knot, mobile ? -0.12 : -0.38, -0.2, -1.05);
      this.bloom.strength = 0.6;
    } else if (id === 'recognition') {
      set(this.orb, mobile ? 0.15 : 0.62, 0.1, -0.85);
      set(this.knot, mobile ? -0.42 : -0.72, -0.1, -1.35);
      this.bloom.strength = 0.7;
    } else {
      // contact
      set(this.orb, mobile ? 0.0 : 0.45, 0.1, -1.05);
      set(this.knot, mobile ? -0.55 : -0.9, -0.1, -1.45);
      this.bloom.strength = 0.55;
    }

    // Accent tint shift per chapter (subtle)
    const base = new THREE.Color(getAccent());
    const alt = new THREE.Color(id === 'capabilities' ? '#40d2ff' : id === 'recognition' ? '#ffffff' : base.getStyle());
    this.setAccent(base.getStyle());
    (this.swarm.material as THREE.MeshStandardMaterial).color.lerp(alt, 0.25);

    this.status(`3D: ON • ${id} • sound ${this.sfx.isOn() ? 'on' : 'off'}`);
  }

  update = () => {
    const t = this.clock.getElapsedTime();

    // Parallax camera
    const px = this.pointerX * 0.35;
    const py = -this.pointerY * 0.22;
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, px * 0.75, 0.05);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, 0.12 + py * 0.7, 0.05);
    this.camera.lookAt(0, 0, -0.9);

    // Animate
    const audio = this.sfx.level();
    const breathe = 0.055 * Math.sin(t * 1.2) + audio * 0.085;

    this.orb.rotation.y = t * 0.26 + this.pointerX * 0.45;
    this.orb.rotation.x = t * 0.13 + this.pointerY * 0.22;
    this.orb.scale.setScalar(1.0 + breathe);

    this.knot.rotation.y = -t * 0.55;
    this.knot.rotation.x = t * 0.35;

    this.stars.rotation.y = t * 0.02;

    // swarm wobble (light)
    const dummy = new THREE.Object3D();
    const count = this.swarm.count;
    for (let i = 0; i < count; i++) {
      this.swarm.getMatrixAt(i, dummy.matrix);
      dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
      dummy.rotation.y += 0.01 + (i % 7) * 0.0005;
      dummy.rotation.x += 0.006;
      dummy.position.x += Math.sin(t * 0.2 + i) * 0.00014;
      dummy.updateMatrix();
      this.swarm.setMatrixAt(i, dummy.matrix);
    }
    this.swarm.instanceMatrix.needsUpdate = true;

    // Audio reactive glow
    const orbMat = this.orb.material as THREE.MeshPhysicalMaterial;
    orbMat.emissiveIntensity = (0.4 + audio * 0.95) * this.opacity;

    this.bloom.strength = (0.56 + audio * 0.55) * (0.65 + this.opacity * 0.55);

    // Fade stars with opacity
    (this.stars.material as THREE.PointsMaterial).opacity = 0.78 * this.opacity;

    // Render
    this.composer.render();
    requestAnimationFrame(this.update);
  };
}

// singleton for SPA transitions
declare global {
  interface Window {
    __TALE_APP__?: TaleWebGLApp;
  }
}

function boot() {
  const statusEl = createStatusPill();

  if (!canWebGL()) {
    statusEl.textContent = '3D: unavailable (WebGL not supported)';
    return;
  }

  const canvas = document.getElementById('tale-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    statusEl.textContent = '3D: missing canvas';
    return;
  }

  try {
    if (!window.__TALE_APP__) {
      window.__TALE_APP__ = new TaleWebGLApp(canvas, statusEl);
      window.__TALE_APP__.update();
    } else {
      // after navigation: refresh accent + chapters
      window.__TALE_APP__.rebindChapters();
    }
  } catch (e: any) {
    statusEl.textContent = `3D: init failed (${e?.message || 'unknown'})`;
    console.error(e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Astro view transitions route changes
document.addEventListener('astro:after-swap', () => {
  boot();
});
