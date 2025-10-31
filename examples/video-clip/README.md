# VideoClip Component (KISS)

A minimal video clip component for a Web A/V Editor, built on Mediabunny.

Features:
- Load, decode, and render video with optional audio
- Precise seek (time, frame, timecode)
- Smooth playback with requestAnimationFrame (60fps target)
- Playback state management (play/pause/stop)
- Timecode sync via external clock provider (multi-track sync)
- Simple event callbacks for Editor integration
- Efficient resource management and cleanup

## Usage

```ts
import { VideoClip } from './video-clip';

const canvas = document.querySelector('canvas')!;
const clip = new VideoClip({ canvas, enableAudio: true });

clip.addEventListener('ready', () => console.log('ready'));
clip.addEventListener('bufferingstart', () => console.log('buffering...'));
clip.addEventListener('bufferingend', () => console.log('buffering done'));
clip.addEventListener('timeupdate', (e) => console.log('time', e.detail.time));

await clip.load('/path/to/video.mp4');
clip.execute({ type: 'play' });

// Seek
await clip.execute({ type: 'seek', time: 12.345 });
await clip.execute({ type: 'seek-frame', frame: 250, fps: 25 });

// Multi-track sync: use an Editor timeline clock
clip.setClockProvider(() => editorTimeline.currentTime);
```

## API

### new VideoClip(options)

Options:
- `canvas: HTMLCanvasElement` — Target canvas for rendering
- `allowAlpha?: boolean` — Enable alpha if video can be transparent (default: false)
- `fit?: 'contain' | 'cover' | 'fill'` — Canvas fit mode (default: 'contain')
- `enableAudio?: boolean` — Play audio if present (default: true)
- `volume?: number` — Initial volume [0..1] (default: 0.7)
- `clockProvider?: () => number` — External timeline clock provider in seconds (default: none)
- `loadingDelayMs?: number` — Buffering delay threshold (default: 100ms)

### Methods
- `load(resource: File | string): Promise<void>` — Load and prepare the clip
- `execute(command: PlaybackCommand): Promise<void> | void` — Unified control interface
  - `{ type: 'play' }`
  - `{ type: 'pause' }`
  - `{ type: 'stop' }`
  - `{ type: 'seek', time: number }`
  - `{ type: 'seek-frame', frame: number, fps: number }`
- `seekToTimecode(tc: string): Promise<void>` — Seek by timecode (HH:MM:SS.MS)
- `getState(): ClipState` — Snapshot state
- `setClockProvider(provider: (() => number) | null): void` — Use external clock (for multi-track sync)
- `setVolume(vol: number): void` — Set volume [0..1]
- `mute(): void`, `unmute(): void` — Mute/unmute audio
- `dispose(): Promise<void>` — Cleanup resources

### Events
Dispatched via `addEventListener` on the `VideoClip` instance:
- `ready`
- `play`
- `pause`
- `stop`
- `ended`
- `seeking` — `{ to: number }`
- `seeked` — `{ at: number }`
- `timeupdate` — `{ time: number }`
- `bufferingstart`
- `bufferingend`
- `error` — `{ error: unknown }`

### Types

```ts
type PlaybackCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; time: number }
  | { type: 'seek-frame'; frame: number; fps: number };

type ClipState = {
  playing: boolean;
  currentTime: number;
  duration: number;
  buffering: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
};
```

## Design Notes (KISS)
- Single class, minimal responsibilities
- EventTarget for simple integration (no external libs)
- RAF-based render loop + interval fallback for hidden tabs
- Buffering detection via 100ms timeout when no frames arrive
- Audio scheduling aligned to timeline (works with internal/external clocks)
- CanvasSink poolSize = 2 to minimize memory usage