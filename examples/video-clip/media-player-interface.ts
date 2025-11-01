/**
 * @fileoverview IMediaPlayer interface and shared types for media player implementations.
 *
 * Defines the standard interface that all media player implementations must follow,
 * ensuring consistency across different player types (WebCodecs, HTML5, etc.).
 * Provides type safety and enables polymorphic usage of different player implementations.
 */

import { EventEmitter } from "eventemitter3";

/**
 * Event types emitted by media player implementations.
 * These events provide lifecycle and state change notifications.
 */
export enum MediaPlayerEvent {
	/** Fired when media is loaded and ready for playback */
	READY = "ready",
	/** Fired when playback starts */
	PLAY = "play",
	/** Fired when playback is paused */
	PAUSE = "pause",
	/** Fired when playback is stopped */
	STOP = "stop",
	/** Fired when playback reaches the end */
	ENDED = "ended",
	/** Fired when seeking operation starts */
	SEEKING = "seeking",
	/** Fired when seeking operation completes */
	SEEKED = "seeked",
	/** Fired periodically during playback to report time updates */
	TIME_UPDATE = "timeupdate",
	/** Fired when buffering starts */
	BUFFERING_START = "bufferingstart",
	/** Fired when buffering ends */
	BUFFERING_END = "bufferingend",
	/** Fired when an error occurs */
	ERROR = "error",
}

/**
 * Event payload mapping for EventEmitter3 type safety.
 * Defines the argument types for each event that can be emitted by media players.
 */
export interface MediaPlayerEventMap {
	[MediaPlayerEvent.READY]: [];
	[MediaPlayerEvent.PLAY]: [];
	[MediaPlayerEvent.PAUSE]: [];
	[MediaPlayerEvent.STOP]: [];
	[MediaPlayerEvent.ENDED]: [];
	[MediaPlayerEvent.SEEKING]: [{ to: number }];
	[MediaPlayerEvent.SEEKED]: [{ at: number }];
	[MediaPlayerEvent.TIME_UPDATE]: [{ time: number }];
	[MediaPlayerEvent.BUFFERING_START]: [];
	[MediaPlayerEvent.BUFFERING_END]: [{ lag: number }];
	[MediaPlayerEvent.ERROR]: [Error];
}

/**
 * Public state snapshot representing the current state of the media player.
 * Provides read-only access to playback status and media properties.
 */
export interface MediaPlayerState {
	/** Whether the media is currently playing */
	playing: boolean;
	/** Current playback time in seconds */
	currentTime: number;
	/** Total duration of the media in seconds */
	duration: number;
	/** Whether the player is currently buffering */
	buffering: boolean;
	/** Whether the media contains video content */
	hasVideo: boolean;
	/** Whether the media contains audio content */
	hasAudio: boolean;
}

/**
 * Result type returned by media probing operations.
 * Contains information about media file compatibility and properties.
 */
export interface MediaProbeResult {
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
}

/**
 * Parameters passed to the onCreateAudioSource hook for custom audio processing.
 * Enables per-buffer audio effects and transformations.
 */
export interface OnCreateAudioSourceParams {
	/** The AudioContext currently used by this player */
	audioContext: AudioContext;
	/** The freshly created AudioBufferSourceNode carrying the decoded audio buffer */
	sourceNode: AudioBufferSourceNode | MediaElementAudioSourceNode;
	/** The media timestamp in seconds of this audio buffer */
	timestamp: number;
	/** Total duration of the sourceNode in seconds */
	duration: number;
	/** The current playback time on the player's timeline in seconds */
	timelineNow: number;
}

/**
 * Configuration options for initializing media player implementations.
 * Provides control over rendering, audio, and playback behavior.
 */
export interface MediaPlayerOptions {
	/** Target canvas element for video rendering */
	canvas: HTMLCanvasElement | OffscreenCanvas;
	/** Enable alpha channel rendering for transparent videos. Default: false */
	allowAlpha?: boolean;
	/** Canvas scaling behavior. Default: 'contain' */
	fit?: "contain" | "cover" | "fill";
	/** Enable audio playback if present. Default: true */
	enableAudio?: boolean;
	/** Initial volume level [0..1]. Default: 1.0 */
	volume?: number;
	/** Delay in ms before showing buffering indicator. Default: 16 */
	loadingDelayMs?: number;
	/** Override canvas dimensions. Default: use video's native size */
	canvasSize?: { width: number; height: number };

	/** Optional hook for custom audio processing */
	onCreateAudioSource?: (
		params: OnCreateAudioSourceParams
	) => GainNode | null | undefined;
}

/**
 * Standard interface that all media player implementations must follow.
 * Provides a consistent API for loading, controlling, and monitoring media playback
 * across different underlying technologies (WebCodecs, HTML5 Video, etc.).
 *
 * @example
 * ```typescript
 * // Using the interface polymorphically
 * const player: IMediaPlayer = new WebCodecsPlayer(options);
 * // or
 * const player: IMediaPlayer = new HTML5Player(options);
 *
 * // Same API regardless of implementation
 * await player.load('video.mp4');
 * await player.play();
 * ```
 */
export interface IMediaPlayer extends EventEmitter<MediaPlayerEventMap> {
	/**
	 * Optional hook for custom audio processing per audio buffer.
	 * Return an AudioNode to insert custom effects or processing chains.
	 * If undefined/null is returned, audio connects directly to the master gain.
	 *
	 * @note The returned node MUST belong to the same AudioContext as provided in params.
	 */
	onCreateAudioSource?: (params: OnCreateAudioSourceParams) => AudioNode | null;

	/**
	 * Loads a media resource into the player for playback.
	 * This method initializes video/audio processing, configures the canvas, and prepares the player for playback.
	 *
	 * @param resource - Media file (File object) or URL (string) to load
	 * @throws {Error} When no decodable audio or video track is found, or required APIs are not supported
	 *
	 * @fires MediaPlayerEvent.READY When the media is successfully loaded and ready for playback
	 * @fires MediaPlayerEvent.ERROR When an error occurs during loading
	 *
	 * @example
	 * ```typescript
	 * await player.load('video.mp4');
	 * // Player is now ready for playback
	 * ```
	 */
	load(resource: File | string): Promise<void>;

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
	getState(): MediaPlayerState;

	/**
	 * Starts or resumes media playback.
	 * This method handles audio context resumption, iterator initialization, and render loop startup.
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
	play(): Promise<void>;

	/**
	 * Pauses media playback.
	 * This method stops audio playback, clears queued audio nodes, and preserves the current playback position.
	 *
	 * @fires MediaPlayerEvent.PAUSE When playback is paused
	 *
	 * @example
	 * ```typescript
	 * player.pause();
	 * console.log('Playback paused');
	 * ```
	 */
	pause(): void;

	/**
	 * Seeks to a specific time position in the media.
	 * This method handles playback state preservation and ensures smooth seeking.
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
	seekToTime(seconds: number): Promise<void>;

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
	seekToFrame(frame: number, fps: number): Promise<void>;

	/**
	 * Sets the playback volume level.
	 *
	 * @param volume - Volume level [0..1] where 0 is silent and 1 is full volume
	 *
	 * @example
	 * ```typescript
	 * player.setVolume(0.5); // Set volume to 50%
	 * ```
	 */
	setVolume(volume: number): void;

	/**
	 * Mutes the audio playback.
	 * The volume level is preserved and can be restored with unmute().
	 *
	 * @example
	 * ```typescript
	 * player.mute();
	 * ```
	 */
	mute(): void;

	/**
	 * Unmutes the audio playback.
	 * Restores the previously set volume level.
	 *
	 * @example
	 * ```typescript
	 * player.unmute();
	 * ```
	 */
	unmute(): void;

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
	dispose(): Promise<void>;
}

/**
 * Static interface for media player classes.
 * Defines static methods that should be available on media player constructors.
 */
export interface IMediaPlayerStatic {
	/**
	 * Probes a media resource to determine compatibility and extract metadata.
	 * This method analyzes the media file without loading it into the player.
	 *
	 * @param resource - Media file (File object) or URL (string) to probe
	 * @returns Promise resolving to probe result with compatibility and metadata information
	 *
	 * @example
	 * ```typescript
	 * const result = await MediaPlayerClass.probeMedia('video.mp4');
	 * if (result.ok) {
	 *   console.log(`Duration: ${result.duration}s, Has video: ${result.hasVideo}`);
	 * } else {
	 *   console.error(`Cannot play: ${result.reason}`);
	 * }
	 * ```
	 */
	probeMedia(resource: File | string): Promise<MediaProbeResult>;

	/**
	 * Constructor signature for media player implementations.
	 */
	new (options: MediaPlayerOptions): IMediaPlayer;
}

/**
 * Type guard to check if an object implements the IMediaPlayer interface.
 *
 * @param obj - Object to check
 * @returns True if the object implements IMediaPlayer interface
 *
 * @example
 * ```typescript
 * if (isMediaPlayer(someObject)) {
 *   // TypeScript now knows someObject is IMediaPlayer
 *   await someObject.play();
 * }
 * ```
 */
export function isMediaPlayer(obj: any): obj is IMediaPlayer {
	return (
		obj &&
		typeof obj === "object" &&
		typeof obj.load === "function" &&
		typeof obj.play === "function" &&
		typeof obj.pause === "function" &&
		typeof obj.seekToTime === "function" &&
		typeof obj.seekToFrame === "function" &&
		typeof obj.setVolume === "function" &&
		typeof obj.mute === "function" &&
		typeof obj.unmute === "function" &&
		typeof obj.getState === "function" &&
		typeof obj.dispose === "function" &&
		typeof obj.on === "function" &&
		typeof obj.off === "function" &&
		typeof obj.emit === "function"
	);
}

/**
 * Abstract base class that provides common functionality for media player implementations.
 * Concrete implementations should extend this class and implement the abstract methods.
 */
export abstract class BaseMediaPlayer
	extends EventEmitter<MediaPlayerEventMap>
	implements IMediaPlayer
{
	/** Configuration options passed during construction */
	protected readonly options: MediaPlayerOptions;

	/**
	 * Creates a new BaseMediaPlayer instance.
	 *
	 * @param options - Configuration options for the media player
	 */
	constructor(options: MediaPlayerOptions) {
		super();
		this.options = { ...options };
	}

	// Abstract methods that must be implemented by concrete classes
	abstract load(resource: File | string): Promise<void>;
	abstract getState(): MediaPlayerState;
	abstract play(): Promise<void>;
	abstract pause(): void;
	abstract seekToTime(seconds: number): Promise<void>;
	abstract setVolume(volume: number): void;
	abstract mute(): void;
	abstract unmute(): void;
	abstract dispose(): Promise<void>;

	/**
	 * Default implementation of frame-based seeking.
	 * Converts frame number to time and delegates to seekToTime.
	 */
	async seekToFrame(frame: number, fps: number): Promise<void> {
		const seconds = frame / fps;
		return this.seekToTime(seconds);
	}

	/**
	 * Utility method to clamp a value between min and max.
	 */
	protected clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	/**
	 * Utility method to emit time update events.
	 * Should be called periodically during playback.
	 */
	protected emitTimeUpdate(time: number): void {
		this.emit(MediaPlayerEvent.TIME_UPDATE, { time });
	}
}

export const DEFAULT_VOLUME = 1;
export const MAX_VOLUME = 10;
export const MIN_VOLUME = 0;
