// Single A/V compositor for the publisher.
//
// It composites optional camera + screen video onto a FIXED-size <canvas> and mixes
// optional mic + system audio through a WebAudio graph. It exposes ONE stable video
// track (the canvas) and ONE stable audio track (the mix destination) for the whole
// session. Toggling camera/screen/mic changes only the *inputs* — the published track
// identities never change, so viewers never get a RESET_STREAM (and the <moq-watch>
// element, which can't re-subscribe after a track reset, never freezes) when sources
// are added or removed mid-broadcast.
//
// Why a FIXED canvas size: changing a captureStream track's resolution mid-stream forces
// the MoQ video encoder to reconfigure, which republishes the catalog and resets the
// track — exactly the freeze we're avoiding. A constant 1280x720 canvas keeps the encoder
// (and the viewer's subscription) stable; camera/screen content is letterboxed to fit.
//
// Why a WebAudio mix: swapping the published audio track when crossing camera→screen
// (mic → system audio) would reset the audio track the same way. Instead the mix's output
// track is constant and we connect/disconnect mic and system-audio inputs behind it.

const CANVAS_W = 1280;
const CANVAS_H = 720;

export interface Compositor {
  readonly videoTrack: MediaStreamTrack; // stable: the canvas composite
  readonly audioTrack: MediaStreamTrack; // stable: the WebAudio mix destination
  readonly canvas: HTMLCanvasElement; // publisher preview; drag the camera inset to move it
  hasCamera: () => boolean;
  hasScreen: () => boolean;
  enableCamera: () => Promise<void>;
  disableCamera: () => void;
  enableScreen: (opts?: { onEnded?: () => void }) => Promise<void>;
  disableScreen: () => void;
  setMicEnabled: (on: boolean) => Promise<void>;
  setSystemAudioEnabled: (on: boolean) => void;
  stop: () => void;
}

function mkVideo(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  void v.play().catch(() => {});
  return v;
}

export function createCompositor(): Compositor {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // ---- Video sources (added/removed on demand) ----
  let screen: { stream: MediaStream; video: HTMLVideoElement } | null = null;
  let camera: { stream: MediaStream; video: HTMLVideoElement } | null = null;

  // Letterbox a video into the whole canvas, preserving aspect ratio.
  const drawContain = (v: HTMLVideoElement) => {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(CANVAS_W / vw, CANVAS_H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(v, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
  };

  // Camera inset (only when screen + camera): ~28% width, default bottom-right, draggable.
  let px = 0;
  let py = 0;
  let placed = false;
  const insetW = () => Math.round(CANVAS_W * 0.28);
  const insetH = () => {
    const cw = camera?.video.videoWidth || 16;
    const ch = camera?.video.videoHeight || 9;
    return Math.round(insetW() * (ch / cw));
  };

  let raf = 0;
  const draw = () => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (screen) {
      drawContain(screen.video);
      if (camera) {
        const w = insetW();
        const h = insetH();
        if (!placed && w && h) {
          px = CANVAS_W - w - 24;
          py = CANVAS_H - h - 24;
          placed = true;
        }
        px = Math.max(0, Math.min(px, CANVAS_W - w));
        py = Math.max(0, Math.min(py, CANVAS_H - h));
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 14;
        ctx.drawImage(camera.video, px, py, w, h);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px, py, w, h);
      }
    } else if (camera) {
      drawContain(camera.video);
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  // Drag the camera inset (only meaningful when both screen + camera are on).
  let dragging = false;
  let dx = 0;
  let dy = 0;
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CANVAS_W / r.width),
      y: (e.clientY - r.top) * (CANVAS_H / r.height),
    };
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    if (!screen || !camera) return;
    const p = toCanvas(e);
    if (p.x >= px && p.x <= px + insetW() && p.y >= py && p.y <= py + insetH()) {
      dragging = true;
      dx = p.x - px;
      dy = p.y - py;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = toCanvas(e);
    px = p.x - dx;
    py = p.y - dy;
  });
  const endDrag = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- Audio mix: one stable output track; mic + system audio are inputs ----
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const dest = ac.createMediaStreamDestination();
  let micStream: MediaStream | null = null;
  let micNode: MediaStreamAudioSourceNode | null = null;
  let sysNode: MediaStreamAudioSourceNode | null = null;

  // ---- Stable published tracks (identity never changes for the session) ----
  const composite = canvas.captureStream(30);
  const videoTrack = composite.getVideoTracks()[0];
  const audioTrack = dest.stream.getAudioTracks()[0];

  let stopped = false;

  return {
    videoTrack,
    audioTrack,
    canvas,
    hasCamera: () => !!camera,
    hasScreen: () => !!screen,

    async enableCamera() {
      if (camera || stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camera = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      placed = false; // re-place the inset for the new camera aspect ratio
    },
    disableCamera() {
      camera?.stream.getTracks().forEach((t) => t.stop());
      if (camera) camera.video.srcObject = null;
      camera = null;
    },

    async enableScreen(opts) {
      if (screen || stopped) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screen = { stream, video: mkVideo(new MediaStream(stream.getVideoTracks())) };
      placed = false;
      // If the user ends the share via the browser's own UI, tear it down + notify.
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        this.disableScreen();
        opts?.onEnded?.();
      });
    },
    disableScreen() {
      this.setSystemAudioEnabled(false);
      screen?.stream.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      screen = null;
      placed = false;
    },

    async setMicEnabled(on) {
      if (stopped) return;
      if (on && !micStream) {
        void ac.resume().catch(() => {});
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micNode = ac.createMediaStreamSource(micStream);
        micNode.connect(dest);
      } else if (!on && micStream) {
        try { micNode?.disconnect(); } catch { /* ignore */ }
        micStream.getTracks().forEach((t) => t.stop());
        micNode = null;
        micStream = null;
      }
    },
    setSystemAudioEnabled(on) {
      if (stopped) return;
      const sysTrack = screen?.stream.getAudioTracks()[0] ?? null;
      if (on && sysTrack && !sysNode) {
        void ac.resume().catch(() => {});
        sysNode = ac.createMediaStreamSource(new MediaStream([sysTrack]));
        sysNode.connect(dest);
      } else if (!on && sysNode) {
        try { sysNode.disconnect(); } catch { /* ignore */ }
        sysNode = null;
      }
    },

    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      screen?.stream.getTracks().forEach((t) => t.stop());
      camera?.stream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      composite.getTracks().forEach((t) => t.stop());
      if (screen) screen.video.srcObject = null;
      if (camera) camera.video.srcObject = null;
      void ac.close().catch(() => {});
      canvas.remove();
    },
  };
}
