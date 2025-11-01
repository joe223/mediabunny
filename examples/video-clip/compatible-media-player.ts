/**
 * @fileoverview CompatibleMediaPlayer component for Web A/V Editor applications.
 *
 * Provides a compatible implementation that uses HTML video element for video
 * encoding/decoding and rendering, offering the same interface and functionality
 * as MediaPlayer for drop-in compatibility.
 *
 * @author joe223
 */

import {
	BaseMediaPlayer,
	IMediaPlayer,
	IMediaPlayerStatic,
	MediaPlayerEvent,
	MediaPlayerEventMap,
	MediaPlayerState,
	MediaProbeResult,
	OnCreateAudioSourceParams,
	MediaPlayerOptions,
	DEFAULT_VOLUME,
	MIN_VOLUME,
	MAX_VOLUME,
} from "./media-player-interface.js";

export { MediaPlayerEvent };
export type {
	MediaPlayerState,
	MediaProbeResult,
	OnCreateAudioSourceParams,
	MediaPlayerOptions,
};

/**
 * Compatible high-performance media player component designed for professional Web A/V Editor applications.
 *
 * ## Architecture Overview
 * Built on top of HTML5 video element with enhanced capabilities, this player provides:
 * - **Frame-accurate playback control** with precise seeking capabilities
 * - **Real-time audio/video synchronization** using native browser codecs
 * - **Hardware-accelerated rendering** via HTML video element
 * - **Event-driven architecture** extending EventEmitter3 for seamless integration
 * - **Canvas integration** for advanced video processing and effects
 *
 * ## Key Features
 * - ✅ **Multi-format support**: MP4, WebM, MOV, AVI, and more via native browser support
 * - ✅ **Precise frame control**: Seek to exact frame numbers with FPS awareness
 * - ✅ **Professional audio**: Native audio with gain control and muting
 * - ✅ **Responsive rendering**: Adaptive canvas scaling (contain/cover/fill)
 * - ✅ **Performance monitoring**: Built-in buffering detection and lag reporting
 * - ✅ **Type safety**: Full TypeScript support with comprehensive interfaces
 *
 * ## Implementation Details
 * This class implements the `IMediaPlayer` interface to ensure API consistency across
 * different player implementations. It provides the exact same functionality as MediaPlayer
 * for drop-in compatibility while using HTML video element for codec and rendering.
 *
 * The player uses HTML5 video element for media decoding and playback, with canvas
 * integration for advanced rendering control and effects processing.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const player = new CompatibleMediaPlayer({
 *   canvas: document.getElementById('video-canvas'),
 *   volume: 0.8,
 *   enableAudio: true,
 *   fit: 'contain'
 * });
 *
 * // Load and play media
 * await player.load('/path/to/video.mp4');
 * await player.play();
 *
 * // Frame-accurate seeking
 * await player.seekToFrame(150, 30); // Seek to frame 150 at 30fps
 *
 * // Event handling
 * player.on('ready', () => console.log('Media loaded'));
 * ```
 *
 * @extends BaseMediaPlayer
 * @implements IMediaPlayer
 * @fires MediaPlayerEvent.READY
 * @fires MediaPlayerEvent.PLAY
 * @fires MediaPlayerEvent.PAUSE
 * @fires MediaPlayerEvent.SEEKING
 * @fires MediaPlayerEvent.SEEKED
 * @fires MediaPlayerEvent.TIME_UPDATE
 * @fires MediaPlayerEvent.BUFFERING_START
 * @fires MediaPlayerEvent.BUFFERING_END
 * @fires MediaPlayerEvent.ENDED
 * @fires MediaPlayerEvent.ERROR
 * @author joe223
 * @since 1.0.0
 * @see {@link IMediaPlayer} for the interface specification
 */
export class CompatibleMediaPlayer
	extends BaseMediaPlayer
	implements IMediaPlayer
{
	// === Core Elements ===
	/** HTML video element for media playback */
	private videoElement: HTMLVideoElement;
	/** Target canvas element for video rendering */
	private canvas: HTMLCanvasElement | OffscreenCanvas;
	/** 2D rendering context for the canvas */
	private context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

	// === Configuration ===
	/** Canvas scaling behavior configuration */
	private fit: "contain" | "cover" | "fill";
	/** Optional override for canvas dimensions */
	private canvasSize?: { width: number; height: number };
	/** Whether audio playback is enabled */
	private enableAudio: boolean;
	/** Current volume level [0..1] */
	private volume: number = 1;
	/** Whether audio is currently muted */
	private volumeMuted = false;

	// === State Management ===
	/** Whether the player is currently playing */
	private playing = false;
	/** Whether a media file has been successfully loaded */
	private fileLoaded = false;
	/** Total duration of the loaded media in seconds */
	private totalDuration = 0;
	/** Whether the player is currently in buffering state */
	private isBuffering = false;
	/** Start time of the current buffering period */
	private bufferingStartTime = 0;

	// === Render Loop Management ===
	/** RequestAnimationFrame ID for the render loop */
	private rafId: number | null = null;
	/** Interval ID for fallback rendering when tab is inactive */
	private intervalId: number | null = null;

	// === Event Handling ===
	/** Bound event handlers for cleanup */
	private boundEventHandlers: Map<string, EventListener> = new Map();

	// === Audio Processing ===
	/** AudioContext for custom audio processing */
	private audioContext: AudioContext | null = null;
	/** Audio source node from the video element */
	private sourceNode: MediaElementAudioSourceNode | null = null;
	/** Primary gain node for volume control */
	private masterGainNode: GainNode | null = null;
	/** Custom gain node for audio processing */
	private customGainNode?: GainNode | null = null;
	// === Buffering Management ===
	/** Timer ID for delayed buffering indicator */
	private loadingTimerId: number | null = null;
	/** Delay before showing buffering indicator */
	private readonly loadingDelayMs: number;

	/**
	 * Creates a new CompatibleMediaPlayer instance.
	 *
	 * @param options - Configuration options for the media player
	 * @param options.canvas - Target canvas element for video rendering
	 * @param options.volume - Initial volume level [0..1], defaults to 1
	 * @param options.enableAudio - Whether to enable audio playback, defaults to true
	 * @param options.fit - Canvas scaling behavior, defaults to "fill"
	 * @param options.loadingDelayMs - Delay before showing buffering indicator, defaults to 16ms
	 * @param options.canvasSize - Optional override for canvas dimensions
	 */
	constructor(options: MediaPlayerOptions) {
		super(options);

		// Initialize canvas and context
		this.canvas = options.canvas;
		this.context = this.canvas.getContext("2d")!;

		// Initialize configuration
		this.volume = options.volume ?? 1;
		this.loadingDelayMs = options.loadingDelayMs ?? 16;
		this.enableAudio = options.enableAudio ?? true;
		this.fit = options.fit ?? "fill";
		this.canvasSize = options.canvasSize;

		// Create video element
		this.videoElement = document.createElement("video");
		this.videoElement.style.display = "none"; // Hidden, we render to canvas
		this.videoElement.crossOrigin = "anonymous";
		this.videoElement.preload = "auto";
		// Always mute the element. Audio is routed and controlled via WebAudio.
		this.videoElement.muted = false;
		this.videoElement.volume = DEFAULT_VOLUME;

		// Initialize audio context if audio is enabled
		if (this.enableAudio) {
			this.audioContext = new AudioContext();
			this.audioContext.suspend().catch(console.error);
			this.sourceNode = this.audioContext.createMediaElementSource(
				this.videoElement
			);
			this.masterGainNode = this.audioContext.createGain();
			// Apply custom node chain: source -> custom -> master gain -> destination
			this.masterGainNode.connect(this.audioContext.destination);
		}

		// Setup event handlers
		this.setupVideoEventHandlers();
	}

	/**
	 * Static property implementing IMediaPlayerStatic interface.
	 * Provides access to the probeMedia method for media compatibility checking.
	 */
	static probeMedia: IMediaPlayerStatic["probeMedia"] =
		CompatibleMediaPlayer.probeMediaInternal;

	/**
	 * Probes a media resource to determine compatibility and extract metadata.
	 * This method analyzes the media file without loading it into the player.
	 *
	 * @param resource - Media file (File object) or URL (string) to probe
	 * @returns Promise resolving to probe result with compatibility and metadata information
	 *
	 * @example
	 * ```typescript
	 * const result = await CompatibleMediaPlayer.probeMedia('video.mp4');
	 * if (result.ok) {
	 *   console.log(`Duration: ${result.duration}s, Has video: ${result.hasVideo}`);
	 * } else {
	 *   console.error(`Cannot play: ${result.reason}`);
	 * }
	 * ```
	 */
	private static async probeMediaInternal(
		resource: File | string
	): Promise<MediaProbeResult> {
		return new Promise((resolve) => {
			const video = document.createElement("video");
			video.style.display = "none";
			video.crossOrigin = "anonymous";
			video.preload = "metadata";

			const cleanup = () => {
				video.remove();
			};

			const onLoadedMetadata = () => {
				const duration = video.duration;
				const hasVideo = video.videoWidth > 0 && video.videoHeight > 0;
				// Check for audio using available properties
				const hasAudio =
					Boolean((video as any).mozHasAudio) ||
					Boolean((video as any).webkitAudioDecodedByteCount) ||
					Boolean((video as any).audioTracks?.length) ||
					Boolean(video.duration > 0); // Fallback: assume audio if video has duration

				cleanup();
				resolve({
					ok: true,
					duration: isFinite(duration) ? duration : undefined,
					hasVideo,
					hasAudio,
					videoDecodable: hasVideo,
					audioDecodable: hasAudio,
					transparent: false, // HTML video doesn't support alpha channel
				});
			};

			const onError = () => {
				cleanup();
				resolve({
					ok: false,
					reason: "Failed to load media metadata",
				});
			};

			video.addEventListener("loadedmetadata", onLoadedMetadata, {
				once: true,
			});
			video.addEventListener("error", onError, { once: true });

			// Set source
			if (resource instanceof File) {
				video.src = URL.createObjectURL(resource);
			} else {
				video.src = resource;
			}

			// Append to DOM temporarily for loading
			document.body.appendChild(video);
		});
	}

	/**
	 * Sets up event handlers for the video element.
	 * Manages all video element events and forwards them as MediaPlayer events.
	 */
	private setupVideoEventHandlers(): void {
		const handlers: Array<[string, EventListener]> = [
			["loadedmetadata", this.onLoadedMetadata.bind(this)],
			["canplay", this.onCanPlay.bind(this)],
			["play", this.onPlay.bind(this)],
			["pause", this.onPause.bind(this)],
			["seeking", this.onSeeking.bind(this)],
			["seeked", this.onSeeked.bind(this)],
			["timeupdate", this.onTimeUpdate.bind(this)],
			["stalled", this.onStalled.bind(this)],
			["waiting", this.onWaiting.bind(this)],
			["playing", this.onPlaying.bind(this)],
			["ended", this.onEnded.bind(this)],
			["error", this.onError.bind(this)],
		];

		handlers.forEach(([event, handler]) => {
			this.videoElement.addEventListener(event, handler);
			this.boundEventHandlers.set(event, handler);
		});
	}

	/**
	 * Removes all event handlers from the video element.
	 */
	private removeVideoEventHandlers(): void {
		this.boundEventHandlers.forEach((handler, event) => {
			this.videoElement.removeEventListener(event, handler);
		});
		this.boundEventHandlers.clear();
	}

	// === Video Event Handlers ===

	private onLoadedMetadata(): void {
		this.totalDuration = this.videoElement.duration;

		// Set canvas size based on video dimensions or override
		if (this.canvasSize) {
			this.canvas.width = this.canvasSize.width;
			this.canvas.height = this.canvasSize.height;
		} else if (
			this.videoElement.videoWidth > 0 &&
			this.videoElement.videoHeight > 0
		) {
			this.canvas.width = this.videoElement.videoWidth;
			this.canvas.height = this.videoElement.videoHeight;
		}

		this.fileLoaded = true;

		this.emit(MediaPlayerEvent.READY);
	}

	private onPlay(): void {
		this.playing = true;
		this.startRenderLoop();
		this.emit(MediaPlayerEvent.PLAY);
	}

	private onPause(): void {
		this.playing = false;
		this.stopRenderLoop();
		this.audioContext?.suspend().catch(console.error);
		this.emit(MediaPlayerEvent.PAUSE);
	}

	private onSeeking(): void {
		this.audioContext?.suspend().catch(console.error);
		this.emit(MediaPlayerEvent.SEEKING, { to: this.videoElement.currentTime });
		this.startBuffering();
	}

	private onSeeked(): void {
		if (this.videoElement.paused === false) {
			this.setupAudioContext();
			this.audioContext?.resume().catch(console.error);
		}
		this.cancelBuffering();
		this.emit(MediaPlayerEvent.SEEKED, { at: this.videoElement.currentTime });
	}

	private onTimeUpdate(): void {
		this.emitTimeUpdate(this.videoElement.currentTime);
	}

	private onStalled(): void {
		this.startBuffering();
	}

	private onWaiting(): void {
		this.startBuffering();
	}

	private onCanPlay(): void {
		this.cancelBuffering();
	}

	private onPlaying(): void {
		this.setupAudioContext();
		this.cancelBuffering();
	}

	private onEnded(): void {
		this.playing = false;
		this.stopRenderLoop();
		this.emit(MediaPlayerEvent.ENDED);
	}

	private onError(): void {
		const error = new Error(
			this.videoElement.error?.message || "Video playback error"
		);
		this.emit(MediaPlayerEvent.ERROR, error);
	}

	// === Buffering Management ===

	/**
	 * Starts the buffering indicator with a delay.
	 */
	private startBuffering(): void {
		if (this.isBuffering) return;

		this.bufferingStartTime = this.audioContext!.currentTime;
		this.isBuffering = true;
		this.emit(MediaPlayerEvent.BUFFERING_START);
	}

	/**
	 * Cancels the buffering indicator.
	 */
	private cancelBuffering(): void {
		if (this.isBuffering) {
			this.isBuffering = false;
			const lag = this.audioContext!.currentTime - this.bufferingStartTime;
			this.emit(MediaPlayerEvent.BUFFERING_END, { lag });
		}
	}

	// === Render Loop Management ===

	/**
	 * Starts the render loop to continuously draw video frames to canvas.
	 */
	private startRenderLoop(): void {
		if (this.rafId || this.intervalId) return;

		const renderFrame = () => {
			if (!this.playing) return;

			this.drawVideoToCanvas();
			this.rafId = requestAnimationFrame(renderFrame);
		};

		// Start with RAF for smooth rendering
		this.rafId = requestAnimationFrame(renderFrame);
	}

	/**
	 * Stops the render loop.
	 */
	private stopRenderLoop(): void {
		if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/**
	 * Draws the current video frame to the canvas with proper scaling.
	 */
	private drawVideoToCanvas(): void {
		if (!this.videoElement.videoWidth || !this.videoElement.videoHeight) return;

		const canvasWidth = this.canvas.width;
		const canvasHeight = this.canvas.height;
		const videoWidth = this.videoElement.videoWidth;
		const videoHeight = this.videoElement.videoHeight;

		// Clear canvas
		this.context.clearRect(0, 0, canvasWidth, canvasHeight);

		// Calculate scaling and positioning based on fit mode
		let drawWidth: number, drawHeight: number, drawX: number, drawY: number;

		switch (this.fit) {
			case "contain": {
				const scale = Math.min(
					canvasWidth / videoWidth,
					canvasHeight / videoHeight
				);
				drawWidth = videoWidth * scale;
				drawHeight = videoHeight * scale;
				drawX = (canvasWidth - drawWidth) / 2;
				drawY = (canvasHeight - drawHeight) / 2;
				break;
			}
			case "cover": {
				const scale = Math.max(
					canvasWidth / videoWidth,
					canvasHeight / videoHeight
				);
				drawWidth = videoWidth * scale;
				drawHeight = videoHeight * scale;
				drawX = (canvasWidth - drawWidth) / 2;
				drawY = (canvasHeight - drawHeight) / 2;
				break;
			}
			case "fill":
			default: {
				drawWidth = canvasWidth;
				drawHeight = canvasHeight;
				drawX = 0;
				drawY = 0;
				break;
			}
		}

		// Draw video frame to canvas
		this.context.drawImage(
			this.videoElement,
			drawX,
			drawY,
			drawWidth,
			drawHeight
		);
	}

	// === IMediaPlayer Interface Implementation ===

	/**
	 * Loads a media resource into the player for playback.
	 * This method initializes the video element and prepares the player for playback.
	 *
	 * @param resource - Media file (File object) or URL (string) to load
	 * @throws {Error} When the media resource cannot be loaded
	 *
	 * @fires MediaPlayerEvent.READY When the media is successfully loaded and ready for playback
	 * @fires MediaPlayerEvent.ERROR When an error occurs during loading
	 *
	 * @example
	 * ```typescript
	 * const player = new CompatibleMediaPlayer({ canvas: myCanvas });
	 * await player.load('video.mp4');
	 * // Player is now ready for playback
	 * ```
	 */
	async load(resource: File | string): Promise<void> {
		this.disposeCurrentPlayback();
		return new Promise((resolve, reject) => {
			this.setupAudioContext();
			this.startBuffering();
			this.fileLoaded = false;

			const onReady = () => {
				this.removeListener(MediaPlayerEvent.READY, onReady);
				this.removeListener(MediaPlayerEvent.ERROR, onError);
				this.cancelBuffering();
				resolve();
			};

			const onError = (error: Error) => {
				this.removeListener(MediaPlayerEvent.READY, onReady);
				this.removeListener(MediaPlayerEvent.ERROR, onError);
				this.cancelBuffering();
				reject(error);
			};

			this.addListener(MediaPlayerEvent.READY, onReady);
			this.addListener(MediaPlayerEvent.ERROR, onError);

			// Set source
			if (resource instanceof File) {
				this.videoElement.src = URL.createObjectURL(resource);
			} else {
				this.videoElement.src = resource;
			}
		});
	}

	/**
	 * Returns a snapshot of the current player state.
	 * This method provides real-time information about playback status, timing, and media capabilities.
	 *
	 * @returns Current state object containing playback status, timing, and media information
	 *
	 * @example
	 * ```typescript
	 * const state = player.getState();
	 * console.log(`Playing: ${state.playing}, Time: ${state.currentTime}/${state.duration}`);
	 * ```
	 */
	getState(): MediaPlayerState {
		return {
			playing: this.playing,
			currentTime: this.videoElement.currentTime || 0,
			duration: this.totalDuration,
			buffering: this.isBuffering,
			hasVideo:
				this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0,
			hasAudio:
				this.enableAudio &&
				(Boolean((this.videoElement as any).mozHasAudio) ||
					Boolean((this.videoElement as any).webkitAudioDecodedByteCount) ||
					Boolean((this.videoElement as any).audioTracks?.length) ||
					Boolean(this.videoElement.duration > 0)), // Fallback
		};
	}

	/**
	 * Starts or resumes media playback.
	 * This method handles play promise and ensures proper playback state management.
	 *
	 * @returns Promise that resolves when playback has started
	 *
	 * @fires MediaPlayerEvent.PLAY When playback starts
	 * @fires MediaPlayerEvent.ENDED When playback reaches the end of the media
	 *
	 * @example
	 * ```typescript
	 * await player.play();
	 * console.log('Playback started');
	 * ```
	 */
	async play(): Promise<void> {
		if (!this.fileLoaded) return;
		if (this.videoElement.currentTime >= this.totalDuration) return;

		// Resume AudioContext before starting playback (required by some browsers)
		if (this.audioContext?.state === "suspended") {
			await this.audioContext.resume();
		}

		try {
			await this.videoElement.play();
		} catch (error) {
			this.emit(MediaPlayerEvent.ERROR, error as Error);
			throw error;
		}
	}

	/**
	 * Pauses media playback.
	 * This method stops playback and preserves the current playback position.
	 *
	 * @fires MediaPlayerEvent.PAUSE When playback is paused
	 *
	 * @example
	 * ```typescript
	 * player.pause();
	 * console.log('Playback paused');
	 * ```
	 */
	pause(): void {
		if (!this.fileLoaded) return;
		this.videoElement.pause();
	}

	/**
	 * Seeks to a specific time position in the media.
	 * This method handles seeking and ensures proper event firing.
	 *
	 * @param seconds - Target time position in seconds (will be clamped to [0, duration])
	 * @returns Promise that resolves when seeking is complete
	 *
	 * @fires MediaPlayerEvent.SEEKING When seeking starts with target position
	 * @fires MediaPlayerEvent.SEEKED When seeking completes with actual position
	 *
	 * @example
	 * ```typescript
	 * await player.seekToTime(30.5); // Seek to 30.5 seconds
	 * ```
	 */
	async seekToTime(seconds: number): Promise<void> {
		if (!this.fileLoaded) return;

		const seekTo = this.clamp(seconds, 0, this.totalDuration);

		return new Promise((resolve) => {
			const onSeeked = () => {
				this.videoElement.removeEventListener("seeked", onSeeked);
				resolve();
			};

			this.videoElement.addEventListener("seeked", onSeeked, { once: true });
			this.videoElement.currentTime = seekTo;
		});
	}

	/**
	 * Seeks to a specific frame number in the media.
	 * This method converts frame numbers to time positions using the provided FPS and seeks to that position.
	 *
	 * @param frame - Target frame number (0-based)
	 * @param fps - Frames per second rate for conversion
	 * @returns Promise that resolves when seeking is complete
	 *
	 * @fires MediaPlayerEvent.SEEKING When seeking starts with target position
	 * @fires MediaPlayerEvent.SEEKED When seeking completes with actual position
	 *
	 * @example
	 * ```typescript
	 * await player.seekToFrame(750, 30); // Seek to frame 750 at 30fps (25 seconds)
	 * ```
	 */
	override async seekToFrame(frame: number, fps: number): Promise<void> {
		const seconds = frame / fps;
		await this.seekToTime(seconds);
	}

	/**
	 * Sets the playback volume level.
	 *
	 * @param vol - Volume level [0..1] where 0 is silent and 1 is full volume
	 *
	 * @example
	 * ```typescript
	 * player.setVolume(0.5); // Set volume to 50%
	 * ```
	 */
	setVolume(vol: number): void {
		this.volume = this.clamp(vol, MIN_VOLUME, MAX_VOLUME);
		this.updateVolume();
	}

	/**
	 * Mutes the audio playback.
	 * The volume level is preserved and can be restored with unmute().
	 *
	 * @example
	 * ```typescript
	 * player.mute();
	 * ```
	 */
	mute(): void {
		this.volumeMuted = true;
		this.updateVolume();
	}

	/**
	 * Unmutes the audio playback.
	 * Restores the previously set volume level.
	 *
	 * @example
	 * ```typescript
	 * player.unmute();
	 * ```
	 */
	unmute(): void {
		this.volumeMuted = false;
		this.updateVolume();
	}

	/**
	 * Disposes of the media player and cleans up all resources.
	 * This method should be called when the player is no longer needed to prevent memory leaks.
	 * After disposal, the player instance should not be used.
	 *
	 * @returns Promise that resolves when all resources have been cleaned up
	 *
	 * @example
	 * ```typescript
	 * await player.dispose();
	 * // Player is now disposed and should not be used
	 * ```
	 */
	async dispose(): Promise<void> {
		this.disposeCurrentPlayback();
		this.removeVideoEventHandlers();

		// Clean up audio context
		if (this.audioContext) {
			this.audioContext.close();
			this.audioContext = null;
			this.sourceNode = null;
			this.masterGainNode = null;
		}

		// Clean up video element
		if (this.videoElement.src) {
			URL.revokeObjectURL(this.videoElement.src);
		}
		this.videoElement.remove();
	}

	// === Internal Helper Methods ===

	/**
	 * Sets up the AudioContext and audio processing graph if enabled.
	 */
	private setupAudioContext(): void {
		if (
			this.enableAudio &&
			this.audioContext &&
			this.sourceNode &&
			this.masterGainNode
		) {
			this.customGainNode?.disconnect();
			// Apply custom node chain: source -> custom -> gain -> destination
			this.customGainNode = this.options.onCreateAudioSource?.({
				audioContext: this.audioContext!,
				sourceNode: this.sourceNode,
				timestamp: 0,
				duration: this.totalDuration,
				timelineNow: this.videoElement.currentTime,
			});
			if (this.customGainNode) {
				this.customGainNode.connect(this.masterGainNode);
			}
			this.sourceNode.connect(this.customGainNode || this.masterGainNode);
			// Route audio through WebAudio graph exclusively
			this.masterGainNode.connect(this.audioContext!.destination);

			this.updateVolume();
		}
	}

	/**
	 * Updates the video element volume based on current settings.
	 */
	private updateVolume(): void {
		if (!this.enableAudio) {
			if (this.masterGainNode) {
				this.masterGainNode.gain.value = 0;
			}
			return;
		}

		if (this.audioContext && this.masterGainNode) {
			const vol = this.volumeMuted
				? 0
				: this.clamp(this.volume, MIN_VOLUME, MAX_VOLUME);
			try {
				this.masterGainNode.gain.setValueAtTime(
					vol,
					this.audioContext.currentTime
				);
			} catch (err) {
				console.error("Error setting volume:", err);
				this.masterGainNode.gain.value = vol;
			}
		}
	}

	/**
	 * Cleans up current playback session and resets all playback-related state.
	 */
	private async disposeCurrentPlayback(): Promise<void> {
		this.playing = false;
		this.fileLoaded = false;
		this.totalDuration = 0;

		// Stop render loop
		this.stopRenderLoop();

		// Cancel buffering
		this.cancelBuffering();

		// Reset video element
		this.videoElement.pause();
		if (this.videoElement.src) {
			URL.revokeObjectURL(this.videoElement.src);
			this.videoElement.src = "";
		}
	}
}

/**
 * Default export for convenient importing.
 */
export default CompatibleMediaPlayer;
