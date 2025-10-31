/**
 * @fileoverview MediaPlayer component for Web A/V Editor applications.
 *
 * Provides a minimal, KISS-style implementation that wraps Mediabunny to load, decode,
 * and render video/audio clips with precise seek capabilities and smooth playback.
 * Offers a simple scheduling interface and event callbacks for Editor integration.
 *
 * @author joe223
 */

import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	CanvasSink,
	Input,
	UrlSource,
	WrappedAudioBuffer,
	WrappedCanvas,
} from "mediabunny";
import { EventEmitter } from "eventemitter3";

/**
 * Loading delay in milliseconds to ensure proper frame rendering.
 * Since decode operations are typically very fast (< 1ms), this 16ms delay
 * provides a safe margin to ensure the first frame is properly rendered.
 */
const LOADING_DELAY_MS = 16;

/**
 * Event types emitted by the MediaPlayer component.
 * These events provide lifecycle and state change notifications.
 */
export enum ClipEvent {
	READY = "ready",
	PLAY = "play",
	PAUSE = "pause",
	STOP = "stop",
	ENDED = "ended",
	SEEKING = "seeking",
	SEEKED = "seeked",
	TIME_UPDATE = "timeupdate",
	BUFFERING_START = "bufferingstart",
	BUFFERING_END = "bufferingend",
	ERROR = "error",
}

/**
 * Public state snapshot representing the current state of the media clip.
 * Provides read-only access to playback status and media properties.
 */
export type ClipState = {
	/** Whether the clip is currently playing */
	playing: boolean;
	/** Current playback time in seconds */
	currentTime: number;
	/** Total duration of the clip in seconds */
	duration: number;
	/** Whether the player is currently buffering */
	buffering: boolean;
	/** Whether the clip contains video content */
	hasVideo: boolean;
	/** Whether the clip contains audio content */
	hasAudio: boolean;
};

/**
 * Event payload mapping for EventEmitter3 type safety.
 * Defines the argument types for each event that can be emitted by MediaPlayer.
 */
export interface ClipEventMap {
	[ClipEvent.READY]: [];
	[ClipEvent.PLAY]: [];
	[ClipEvent.PAUSE]: [];
	[ClipEvent.STOP]: [];
	[ClipEvent.ENDED]: [];
	[ClipEvent.SEEKING]: [{ to: number }];
	[ClipEvent.SEEKED]: [{ at: number }];
	[ClipEvent.TIME_UPDATE]: [{ time: number }];
	[ClipEvent.BUFFERING_START]: [];
	[ClipEvent.BUFFERING_END]: [
		{
			lag: number;
		}
	];
	[ClipEvent.ERROR]: [Error];
}

/**
 * Result type returned by media probing operations.
 * Contains information about media file compatibility and properties.
 */
export type MediaProbeResult = {
	/** Whether the media file can be successfully processed */
	ok: boolean;
	/** Error message if probing failed */
	reason?: string;
	/** Total duration of the media in seconds */
	duration?: number;
	/** Whether the media contains video tracks */
	hasVideo?: boolean;
	/** Whether the media contains audio tracks */
	hasAudio?: boolean;
	/** Whether video tracks can be decoded */
	videoDecodable?: boolean;
	/** Whether audio tracks can be decoded */
	audioDecodable?: boolean;
	/** Whether video supports transparency/alpha channel */
	transparent?: boolean;
};

/**
 * Parameters passed to the onCreateAudioSource hook for custom audio processing.
 * Enables per-buffer audio effects and transformations.
 */
export type OnCreateAudioSourceParams = {
	/** The AudioContext currently used by this clip */
	audioContext: AudioContext;
	/** The freshly created AudioBufferSourceNode carrying the decoded audio buffer */
	sourceNode: AudioBufferSourceNode;
	/** The media timestamp in seconds of this audio buffer */
	timestamp: number;
	/** The current playback time on the clip's timeline in seconds */
	timelineNow: number;
};

/**
 * Configuration options for initializing the MediaPlayer component.
 * Provides control over rendering, audio, and playback behavior.
 */
export type VideoClipOptions = {
	/** Target canvas element for video rendering */
	canvas: HTMLCanvasElement | OffscreenCanvas;
	/** Enable alpha channel rendering for transparent videos. Default: false */
	allowAlpha?: boolean;
	/** Canvas scaling behavior. Default: 'contain' */
	fit?: "contain" | "cover" | "fill";
	/** Enable audio playback if present. Default: true */
	enableAudio?: boolean;
	/** Initial volume level [0..1]. Default: 0.7 */
	volume?: number;
	/** Delay in ms before showing buffering indicator. Default: 16 */
	loadingDelayMs?: number;
	/** Override canvas dimensions. Default: use video's native size */
	canvasSize?: { width: number; height: number };
};

/**
 * Minimal, KISS-style media player component for Web A/V Editor applications.
 * Extends EventEmitter3 for simple event integration and provides precise playback control.
 */
export class MediaPlayer extends EventEmitter<ClipEventMap> {
	// === Rendering Properties ===
	/** Target canvas element for video rendering */
	private canvas: HTMLCanvasElement | OffscreenCanvas;
	/** 2D rendering context for the canvas */
	private context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	/** Canvas scaling behavior configuration */
	private fit: "contain" | "cover" | "fill";
	/** Optional override for canvas dimensions */
	private canvasSize?: { width: number; height: number };

	// === Audio System ===
	/** Whether audio playback is enabled */
	private enableAudio: boolean;
	/** Web Audio API context for audio processing */
	private audioContext: AudioContext | null = null;
	/** Master gain node for volume control */
	private gainNode: GainNode | null = null;
	/** Set of currently scheduled audio buffer source nodes */
	private queuedAudioNodes: Set<AudioBufferSourceNode> = new Set();

	/**
	 * Optional hook for custom audio processing per audio buffer.
	 * Return an AudioNode to insert custom effects or processing chains.
	 * If undefined/null is returned, audio connects directly to the master gain.
	 *
	 * @note The returned node MUST belong to the same AudioContext as provided in params.
	 */
	onCreateAudioSource?: (params: OnCreateAudioSourceParams) => AudioNode | null;

	// === Media Processing ===
	/** Video sink for decoding and rendering video frames */
	private videoSink: CanvasSink | null = null;
	/** Audio sink for decoding audio buffers */
	private audioSink: AudioBufferSink | null = null;

	// === Frame Management ===
	/** Async generator for video frame iteration */
	private videoFrameIterator: AsyncGenerator<
		WrappedCanvas,
		void,
		unknown
	> | null = null;
	/** Async generator for audio buffer iteration */
	private audioBufferIterator: AsyncGenerator<
		WrappedAudioBuffer,
		void,
		unknown
	> | null = null;
	/** Pre-fetched next video frame for smooth playback */
	private nextFrame: WrappedCanvas | null = null;

	// === Playback State ===
	/** Whether the player is currently playing */
	private playing = false;
	/** Playback time in seconds when playback started or was paused */
	private playbackTimeAtStart = 0;
	/** AudioContext time reference when playback started */
	private audioContextStartTime: number | null = null;
	/** Total duration of the loaded media in seconds */
	private totalDuration = 0;
	/** Whether a media file has been successfully loaded */
	private fileLoaded = false;

	// === Buffering Management ===
	/** Timer ID for delayed buffering indicator */
	private loadingTimerId: number | null = null;
	/** Delay before showing buffering indicator */
	private readonly loadingDelayMs: number;
	/** Whether the player is currently in buffering state */
	private isBuffering = false;
	/** Sync ID to prevent stale buffering operations */
	private bufferingSyncId = 0;
	/** AudioContext time when buffering started */
	private bufferingContextTime: number | null = null;
	/** Playback time when buffering started */
	private bufferingStartPlaybackTime: number | null = null;

	// === Async Operation Control ===
	/** Incremental ID to cancel stale async operations */
	private asyncId = 0;

	// === Volume Control ===
	/** Current volume level [0..1] */
	private volume: number;
	/** Whether audio is currently muted */
	private volumeMuted = false;

	// === Render Loop Management ===
	/** RequestAnimationFrame ID for the render loop */
	private rafId: number | null = null;
	/** Interval ID for fallback rendering when tab is inactive */
	private intervalId: number | null = null;
	/** Flag to prevent concurrent frame fetching operations */
	private fetchingNextFrame = false;

	/**
	 * Creates a new MediaPlayer instance.
	 *
	 * @param options - Configuration options for the media player
	 * @param options.canvas - Target canvas element for video rendering
	 * @param options.volume - Initial volume level [0..1], defaults to 1
	 * @param options.enableAudio - Whether to enable audio playback, defaults to true
	 * @param options.fit - Canvas scaling behavior, defaults to "fill"
	 * @param options.loadingDelayMs - Delay before showing buffering indicator, defaults to 16ms
	 * @param options.canvasSize - Optional override for canvas dimensions
	 *
	 * @throws {Error} When Web Audio API is not supported
	 */
	constructor(options: VideoClipOptions) {
		super();
		this.canvas = options.canvas;
		this.context = this.canvas.getContext("2d")!;
		this.volume = options.volume ?? 1;
		this.loadingDelayMs = options.loadingDelayMs ?? LOADING_DELAY_MS;
		this.enableAudio = options.enableAudio ?? true;
		this.fit = options.fit ?? "fill";
		this.canvasSize = options.canvasSize;

		// Pre-create AudioContext if audio is enabled. We'll set sampleRate later based on track.
		if (!AudioContext) {
			throw new Error("Web Audio API not supported");
		}
		this.audioContext = new AudioContext();
		this.gainNode = this.audioContext.createGain();
		this.gainNode.connect(this.audioContext.destination);
		this.updateVolume();
	}

	/**
	 * Internal helper to collect media information with unified logic used by both load() and probeMedia().
	 */
	private static async probeInternal(resource: File | string): Promise<{
		input: Input;
		duration: number;
		videoTrack: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>;
		audioTrack: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>;
		videoDecodable: boolean;
		audioDecodable: boolean;
		transparent: boolean;
	}> {
		const source =
			resource instanceof File
				? new BlobSource(resource)
				: new UrlSource(resource);
		const input = new Input({ source, formats: ALL_FORMATS });

		const [duration, rawVideoTrack, rawAudioTrack] = await Promise.all([
			input.computeDuration(),
			input.getPrimaryVideoTrack(),
			input.getPrimaryAudioTrack(),
		]);

		const [videoDecodable, audioDecodable] = await Promise.all([
			rawVideoTrack
				? rawVideoTrack.codec !== null && (await rawVideoTrack.canDecode())
				: false,
			rawAudioTrack
				? rawAudioTrack.codec !== null && (await rawAudioTrack.canDecode())
				: false,
		]);

		const videoTrack = videoDecodable ? rawVideoTrack : null;
		const audioTrack = audioDecodable ? rawAudioTrack : null;
		const transparent = videoTrack
			? await videoTrack.canBeTransparent()
			: false;

		return {
			input,
			duration,
			videoTrack,
			audioTrack,
			videoDecodable,
			audioDecodable,
			transparent,
		};
	}

	/**
	 * Probes a media resource to determine compatibility and extract metadata.
	 * This method analyzes the media file without loading it into the player.
	 *
	 * @param resource - Media file (File object) or URL (string) to probe
	 * @returns Promise resolving to probe result with compatibility and metadata information
	 *
	 * @example
	 * ```typescript
	 * const result = await MediaPlayer.probeMedia('video.mp4');
	 * if (result.ok) {
	 *   console.log(`Duration: ${result.duration}s, Has video: ${result.hasVideo}`);
	 * } else {
	 *   console.error(`Cannot play: ${result.reason}`);
	 * }
	 * ```
	 */
	static async probeMedia(resource: File | string): Promise<MediaProbeResult> {
		try {
			const info = await MediaPlayer.probeInternal(resource);
			const ok = !!(info.videoDecodable || info.audioDecodable);
			// Dispose input after probing to free resources
			info.input.dispose();
			return {
				ok,
				reason: ok ? undefined : "No decodable audio or video track found.",
				duration: info.duration,
				hasVideo: !!info.videoTrack,
				hasAudio: !!info.audioTrack,
				videoDecodable: info.videoDecodable,
				audioDecodable: info.audioDecodable,
				transparent: info.transparent,
			};
		} catch (err) {
			return {
				ok: false,
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Loads a media resource into the player for playback.
	 * This method initializes video/audio sinks, configures the canvas, and prepares the player for playback.
	 *
	 * @param resource - Media file (File object) or URL (string) to load
	 * @throws {Error} When no decodable audio or video track is found, or Web Audio API is not supported
	 *
	 * @fires ClipEvent.READY When the media is successfully loaded and ready for playback
	 * @fires ClipEvent.ERROR When an error occurs during loading
	 *
	 * @example
	 * ```typescript
	 * const player = new MediaPlayer({ canvas: myCanvas });
	 * await player.load('video.mp4');
	 * // Player is now ready for playback
	 * ```
	 */
	async load(resource: File | string): Promise<void> {
		try {
			this.disposeCurrentPlayback();
			this.fileLoaded = false;
			this.readyBorBuffering();

			this.playbackTimeAtStart = 0;

			const info = await MediaPlayer.probeInternal(resource);
			this.totalDuration = info.duration;
			let videoTrack = info.videoTrack;
			let audioTrack = info.audioTrack;
			const videoCanBeTransparent = info.transparent;

			// Init sinks
			this.videoSink = videoTrack
				? new CanvasSink(videoTrack, {
						poolSize: 2, // only current + next frame
						fit: this.fit,
						...this.canvasSize,
						alpha: videoCanBeTransparent,
				  })
				: null;
			this.audioSink =
				audioTrack && this.enableAudio ? new AudioBufferSink(audioTrack) : null;

			// Canvas size
			if (videoTrack && !this.canvasSize) {
				this.canvas.width = videoTrack.displayWidth;
				this.canvas.height = videoTrack.displayHeight;
			} else if (this.canvasSize) {
				this.canvas.width = this.canvasSize.width;
				this.canvas.height = this.canvasSize.height;
			}

			// Match AudioContext sampleRate to track, if present
			if (audioTrack && this.audioContext?.state !== "closed") {
				// Some browsers require recreating AudioContext for sample rate changes.
				if (this.audioContext!.sampleRate !== audioTrack.sampleRate) {
					await this.audioContext!.close();
					if (!AudioContext) {
						throw new Error("Web Audio API not supported");
					}
					this.audioContext = new AudioContext({
						sampleRate: audioTrack.sampleRate,
					});
					this.gainNode = this.audioContext.createGain();
					this.gainNode.connect(this.audioContext.destination);
					this.updateVolume();
				}
			}

			if (!videoTrack && !audioTrack) {
				throw new Error("No decodable audio or video track found.");
			}

			this.cancelBuffering();

			await this.startVideoIterator();
			this.fileLoaded = true;
			this.emit(ClipEvent.READY);
			this.startRenderLoop();
		} catch (error) {
			this.cancelBuffering();
			this.emit(ClipEvent.ERROR, error as Error);
			throw error;
		}
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
	getState(): ClipState {
		return {
			playing: this.playing,
			currentTime: this.getPlaybackTime(),
			duration: this.totalDuration,
			buffering: this.isBuffering,
			hasVideo: !!this.videoSink,
			hasAudio: !!this.audioSink,
		};
	}

	/**
	 * Starts or resumes media playback.
	 * This method handles audio context resumption, iterator initialization, and render loop startup.
	 *
	 * @returns Promise that resolves when playback has started
	 *
	 * @fires ClipEvent.PLAY When playback starts
	 * @fires ClipEvent.ENDED When playback reaches the end of the media
	 *
	 * @example
	 * ```typescript
	 * await player.play();
	 * console.log('Playback started');
	 * ```
	 */
	async play(): Promise<void> {
		if (this.getPlaybackTime() >= this.totalDuration) {
			return;
		}
		if (this.playing) return;
		if (!this.fileLoaded) return;

		this.cancelBuffering();

		if (this.audioContext?.state === "suspended") {
			await this.audioContext.resume();
		}
		// snap to start
		// if (this.getPlaybackTime() >= this.totalDuration) {
		// 	this.playbackTimeAtStart = 0;
		// }
		await this.startVideoIterator();
		this.audioContextStartTime = this.audioContext!.currentTime;
		this.playing = true;
		this.startRenderLoop();

		if (this.audioSink) {
			void this.audioBufferIterator?.return();
			this.audioBufferIterator = this.audioSink.buffers(this.getPlaybackTime());
			void this.runAudioIterator();
		}

		this.emit(ClipEvent.PLAY);
	}

	/**
	 * Pauses media playback.
	 * This method stops audio playback, clears queued audio nodes, and preserves the current playback position.
	 *
	 * @fires ClipEvent.PAUSE When playback is paused
	 *
	 * @example
	 * ```typescript
	 * player.pause();
	 * console.log('Playback paused');
	 * ```
	 */
	pause(): void {
		if (!this.fileLoaded) return;
		this.playbackTimeAtStart = this.getPlaybackTime();
		this.playing = false;
		void this.audioBufferIterator?.return();
		this.audioBufferIterator = null;

		// Stop queued audio
		for (const node of this.queuedAudioNodes) node.stop();
		this.queuedAudioNodes.clear();

		this.emit(ClipEvent.PAUSE);
	}

	/**
	 * Seeks to a specific time position in the media.
	 * This method handles playback state preservation and ensures smooth seeking.
	 *
	 * @param seconds - Target time position in seconds (will be clamped to [0, duration])
	 * @returns Promise that resolves when seeking is complete
	 *
	 * @fires ClipEvent.SEEKING When seeking starts with target position
	 * @fires ClipEvent.SEEKED When seeking completes with actual position
	 *
	 * @example
	 * ```typescript
	 * await player.seekToTime(30.5); // Seek to 30.5 seconds
	 * ```
	 */
	async seekToTime(seconds: number): Promise<void> {
		const seekTo = Math.min(Math.max(0, seconds), this.totalDuration);

		if (this.getPlaybackTime() === seekTo) return;

		this.emit(ClipEvent.SEEKING, { to: seekTo });
		this.cancelBuffering();
		const wasPlaying = this.playing;
		if (wasPlaying) this.pause();

		this.playbackTimeAtStart = seekTo;
		await this.startVideoIterator();

		if (wasPlaying && this.playbackTimeAtStart < this.totalDuration)
			void this.play();
		this.emit(ClipEvent.SEEKED, { at: seconds });
	}

	/**
	 * Seeks to a specific frame position in the media (frame-accurate seeking).
	 * This is a convenience method that converts frame number to time and calls seekToTime.
	 *
	 * @param frame - Target frame number (0-based)
	 * @param fps - Frame rate to use for time conversion
	 * @returns Promise that resolves when seeking is complete
	 *
	 * @example
	 * ```typescript
	 * await player.seekToFrame(750, 30); // Seek to frame 750 at 30fps (25 seconds)
	 * ```
	 */
	async seekToFrame(frame: number, fps: number): Promise<void> {
		const seconds = frame / fps;
		return this.seekToTime(seconds);
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
		this.volume = Math.max(0, Math.min(vol, 1));
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
		if (this.audioContext && this.audioContext.state !== "closed") {
			await this.audioContext.close();
		}
		this.audioContext = null;
		this.gainNode = null;
	}

	// === Internal Methods ===

	/**
	 * Cleans up current playback session and resets all playback-related state.
	 * This method stops all iterators, cancels render loops, and clears audio nodes.
	 */
	private disposeCurrentPlayback() {
		this.playing = false;
		this.fileLoaded = false;

		// Increment async ID to invalidate any pending async operations
		this.asyncId++;

		// Clean up video and audio iterators
		void this.videoFrameIterator?.return();
		void this.audioBufferIterator?.return();
		this.videoFrameIterator = null;
		this.audioBufferIterator = null;
		this.nextFrame = null;

		// Cancel render loops
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Clean up buffering state and audio nodes
		this.cancelBuffering();
		for (const node of this.queuedAudioNodes) node.stop();
		this.queuedAudioNodes.clear();
	}

	/**
	 * Initializes video frame iterator and pre-fetches the first two frames.
	 * This method handles async operation cancellation and buffering state management.
	 */
	private async startVideoIterator(): Promise<void> {
		if (!this.videoSink) return;

		// Increment async ID to cancel any stale operations
		this.asyncId++;

		// Clean up existing iterator
		await this.videoFrameIterator?.return();

		const playbackTime = this.getPlaybackTime();
		this.videoFrameIterator = this.videoSink.canvases(playbackTime);
		const videoIterator = this.videoFrameIterator;

		// Fetch and display first frame
		this.readyBorBuffering();
		const firstFrame = (await videoIterator.next()).value ?? null;
		this.cancelBuffering();

		// Check if iterator is still valid (not replaced by another operation)
		if (this.videoFrameIterator !== videoIterator) return;

		if (firstFrame) {
			this.drawFrameToCanvas(firstFrame);
		}

		// Pre-fetch second frame for smooth playback
		this.readyBorBuffering();
		const secondFrame = (await videoIterator.next()).value ?? null;
		this.cancelBuffering();
		if (this.videoFrameIterator !== videoIterator) return;

		this.nextFrame = secondFrame;
		this.cancelBuffering();

		// Start proactive frame fetching if needed
		if (!this.nextFrame && this.playing) {
			void this.updateNextFrame();
		}
	}

	/**
	 * Starts the main render loop for video playback
	 * Handles frame rendering, time updates, and playback end detection
	 * @private
	 */
	private startRenderLoop(): void {
		const render = (requestFrame = true) => {
			// Exit early if playback is stopped
			if (!this.playing) return;

			if (this.fileLoaded) {
				const playbackTime = this.getPlaybackTime();
				const isEnded = playbackTime >= this.totalDuration;

				// Emit time update events during active playback (throttling can be added if needed)
				if (this.playing && !this.isBuffering) {
					this.emit(ClipEvent.TIME_UPDATE, { time: playbackTime });
				}

				// Render the next frame if it's ready and due for display
				if (this.nextFrame && this.nextFrame.timestamp <= playbackTime) {
					this.drawFrameToCanvas(this.nextFrame);
					this.nextFrame = null;

					// Fetch the subsequent frame
					void this.updateNextFrame();
				} else if (!this.nextFrame && this.playing) {
					// If no frame is available during playback, fetch one and manage buffering
					void this.updateNextFrame();
				}

				// Handle playback completion
				if (isEnded) {
					this.pause();
					this.playbackTimeAtStart = this.totalDuration;
					this.emit(ClipEvent.ENDED);
					return;
				}
			}

			// Schedule next render frame using requestAnimationFrame for smooth playback
			if (requestFrame) {
				this.rafId = requestAnimationFrame(() => render());
			}
		};
		render();
		// Fallback when tab is hidden (currently disabled)
		// this.intervalId = setInterval(() => render(false), 500);
	}

	/**
	 * Initiates buffering state after a delay to avoid flickering on quick loads
	 * @private
	 */
	private readyBorBuffering() {
		if (this.loadingTimerId === null) {
			this.loadingTimerId = setTimeout(() => {
				// Sync buffering state with current async operation to prevent stale buffering
				this.bufferingSyncId = this.asyncId;

				if (!this.isBuffering) {
					const currentPlaybackTime = this.getPlaybackTime();
					this.isBuffering = true;
					this.bufferingStartPlaybackTime = currentPlaybackTime;
					this.bufferingContextTime = this.audioContext!.currentTime;
					this.emit(ClipEvent.BUFFERING_START);
				}
			}, this.loadingDelayMs);
		}
	}

	/**
	 * Cancels buffering state and resumes playback from the correct position
	 * @private
	 */
	private cancelBuffering() {
		// Only cancel buffering for the latest async operation to prevent race conditions
		if (this.asyncId !== this.bufferingSyncId) return;

		// Clear any pending buffering timeout immediately to avoid stale state changes
		if (this.loadingTimerId !== null) {
			clearTimeout(this.loadingTimerId);
			this.loadingTimerId = null;
		}

		if (this.isBuffering) {
			// Calculate audio context lag during buffering period
			const lag =
				this.bufferingContextTime !== null
					? this.audioContext!.currentTime - this.bufferingContextTime
					: 0;

			// Reset buffering state and restore playback time continuity
			// This ensures getPlaybackTime() continues from where buffering started
			this.playbackTimeAtStart = this.bufferingStartPlaybackTime!;
			this.audioContextStartTime = this.audioContext!.currentTime;
			this.isBuffering = false;
			this.bufferingStartPlaybackTime = null;
			this.emit(ClipEvent.BUFFERING_END, {
				lag,
			});
			this.bufferingContextTime = null;
		}
	}

	/**
	 * Fetches the next video frame for rendering, handling buffering and async operation synchronization
	 * Iterates over frames until a future frame is found; manages buffering state during fetch
	 * @private
	 */
	private async updateNextFrame(): Promise<void> {
		// Prevent concurrent frame fetching operations
		if (this.fetchingNextFrame) return;
		this.fetchingNextFrame = true;
		const currentAsyncId = this.asyncId;
		const iterator = this.videoFrameIterator;
		try {
			while (true) {
				// Exit immediately if seek occurred or iterator changed during operation
				if (
					currentAsyncId !== this.asyncId ||
					iterator !== this.videoFrameIterator ||
					!iterator
				) {
					break;
				}

				// Start buffering indicator before potentially slow frame fetch
				this.readyBorBuffering();

				const now = performance.now();

				const result = await iterator.next();

				// Cancel buffering once frame is available
				this.cancelBuffering();

				// Check again for async operation changes after await
				if (
					currentAsyncId !== this.asyncId ||
					iterator !== this.videoFrameIterator
				) {
					break;
				}

				const newNextFrame = result.value ?? null;

				// No more frames available
				if (!newNextFrame) {
					break;
				}

				const playbackTime = this.getPlaybackTime();
				// If frame is already due, render immediately and continue fetching
				if (newNextFrame.timestamp <= playbackTime) {
					this.drawFrameToCanvas(newNextFrame);
				} else {
					// Frame is for future playback, store it and exit
					this.nextFrame = newNextFrame;
					break;
				}
			}
		} finally {
			this.fetchingNextFrame = false;
		}
	}

	/**
	 * Processes audio buffer iterator and schedules audio playback
	 * Handles custom audio source creation and connects to master gain chain
	 * @private
	 */
	private async runAudioIterator(): Promise<void> {
		if (!this.audioSink || !this.audioContext) return;

		// Start buffering if no video track is present (audio-only playback)
		if (!this.videoSink) this.readyBorBuffering();

		for await (const { buffer, timestamp } of this.audioBufferIterator!) {
			// Cancel buffering once audio data is available (for audio-only playback)
			if (!this.videoSink) this.cancelBuffering();

			// Create audio source node for this buffer
			const node = this.audioContext.createBufferSource();
			const timelineNow = this.getPlaybackTime();

			node.buffer = buffer;

			// Allow custom audio processing (e.g., effects, gain envelopes)
			const customAudioNode = this.onCreateAudioSource?.({
				audioContext: this.audioContext!,
				sourceNode: node,
				timestamp,
				timelineNow,
			});

			// Connect custom node to master gain chain to preserve volume/mute functionality
			if (customAudioNode) {
				customAudioNode.connect(this.gainNode!);
			}
			node.connect(customAudioNode ?? this.gainNode!);

			// Schedule audio relative to the current timeline time (works for both internal and external clocks):
			// startTimestamp = audioContext.currentTime + (timestamp - timelineNow)
			const startTimestamp =
				this.audioContext.currentTime + (timestamp - timelineNow);
			if (startTimestamp >= this.audioContext.currentTime) {
				node.start(startTimestamp);
			} else {
				node.start(
					this.audioContext.currentTime,
					this.audioContext.currentTime - startTimestamp
				);
			}

			// Track queued audio nodes for cleanup
			this.queuedAudioNodes.add(node);
			node.onended = () => {
				node.disconnect();
				this.queuedAudioNodes.delete(node);
			};

			// Throttle audio scheduling when too far ahead to prevent memory buildup
			if (timestamp - this.getPlaybackTime() >= 1) {
				await new Promise<void>((resolve) => {
					const id = setInterval(() => {
						if (timestamp - this.getPlaybackTime() < 1) {
							clearInterval(id);
							resolve();
						}
					}, 100);
				});
			}
			// Manage buffering state for audio-only playback
			if (!this.videoSink) this.readyBorBuffering();
		}
		if (!this.videoSink) this.cancelBuffering();
	}

	/**
	 * Calculates current playback time based on audio context timing
	 * Handles buffering state and ensures accurate time tracking
	 * @private
	 * @returns Current playback time in seconds
	 */
	private getPlaybackTime(): number {
		if (this.playing) {
			// Return frozen time during buffering to maintain consistency
			if (this.isBuffering) {
				return this.bufferingStartPlaybackTime!;
			}

			// Calculate elapsed time since playback started
			const playbackTime =
				this.audioContext!.currentTime -
				this.audioContextStartTime! +
				this.playbackTimeAtStart;

			// Clamp playback time to total duration to prevent overflow
			return playbackTime >= this.totalDuration
				? this.totalDuration
				: playbackTime;
		}
		return this.playbackTimeAtStart;
	}

	/**
	 * Updates the master gain node volume based on current volume and mute state
	 * Uses quadratic taper for more natural volume perception
	 * @private
	 */
	private updateVolume(): void {
		const actual = this.volumeMuted ? 0 : this.volume;
		this.gainNode!.gain.value = actual ** 2; // Quadratic taper for natural volume curve
	}

	/**
	 * Renders a video frame to the canvas with proper scaling and positioning
	 * Handles different fit modes (contain, cover, fill) and canvas sizing
	 * @private
	 * @param frame - The video frame to render
	 */
	private drawFrameToCanvas(frame: WrappedCanvas): void {
		this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.context.drawImage(frame.canvas, 0, 0);
	}
}
