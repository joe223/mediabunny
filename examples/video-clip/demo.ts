import {
	MediaPlayer as WebCodecMediaPlayer,
	MediaPlayerEvent,
} from "./media-player.js";
import { CompatibleMediaPlayer } from "./compatible-media-player.js";

const getMediaPlayerClass = () => {
	const useCompatible =
		localStorage.getItem("mediaPlayerImpl") === "compatible";
	return useCompatible ? CompatibleMediaPlayer : WebCodecMediaPlayer;
};

let MediaPlayer = getMediaPlayerClass();

const SampleMp3FileUrl =
	"https://cdn.freesound.org/previews/829/829679_5674468-lq.mp3";
const SampleMp4FileUrl =
	"https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

const player = document.getElementById("player")!;
const canvas = player.querySelector("canvas") as HTMLCanvasElement;
const loadingEl = document.getElementById("loading")!;
const statusEl = document.getElementById("status")!;
const timeEl = document.getElementById("time")!;
const progressEl = document.getElementById("progress") as HTMLInputElement;

let isScrubbing = false;
let durationSec = 0;
progressEl.disabled = true;
// Volume reduction interval (seconds) and level
const volumeReduceStart = 20; // 20 seconds
const volumeReduceEnd = 30; // 30 seconds
const reducedVolume = 0.1; // Volume level during 20-30s

const clip = new MediaPlayer({
	canvas,
	enableAudio: true,
	canvasSize: { width: 640, height: 640 },
	onCreateAudioSource: ({
		audioContext,
		sourceNode,
		timestamp,
		duration,
		timelineNow,
	}) => {
		const volumeReduceEnabled = volumeReduceCheckbox.checked;

		if (!volumeReduceEnabled) {
			return;
		}

		const g = audioContext.createGain();
		const startACTime =
			audioContext.currentTime + (volumeReduceStart - timelineNow);
		const endAcTime =
			audioContext.currentTime + (volumeReduceEnd - timelineNow);

		if (startACTime >= 0) g.gain.setValueAtTime(reducedVolume, startACTime);
		if (endAcTime >= 0) g.gain.setValueAtTime(1, endAcTime);

		return g;
	},
});

// ----- Audio controls: volume, mute, per-chunk envelope (via onCreateAudioSource) -----
let currentVolume = 1;
let isMuted = false;
clip.setVolume(currentVolume);

clip.on(MediaPlayerEvent.READY, () => {
	console.log("ready");
	statusEl.textContent = "ready";
	const state = clip.getState();
	durationSec = state.duration;
	progressEl.max = String(Math.max(0, durationSec));
	progressEl.value = "0";
	progressEl.disabled = false;
	timeEl.textContent = `${formatTime(0)} / ${formatTime(durationSec)} (${0})`;
});

clip.on(MediaPlayerEvent.PLAY, () => {
	console.log("play");
	statusEl.textContent = "playing";
});

clip.on(MediaPlayerEvent.PAUSE, () => {
	console.log("pause");
	statusEl.textContent = "paused";
});

clip.on(MediaPlayerEvent.ENDED, () => {
	console.log("ended");
	statusEl.textContent = "ended";
	timeEl.textContent = `${formatTime(durationSec)} / ${formatTime(
		durationSec
	)}`;
});

clip.on(MediaPlayerEvent.ERROR, (error: any) => {
	console.error("error", error);
	statusEl.textContent = "error: " + error.message;
});

clip.on(MediaPlayerEvent.BUFFERING_START, () => {
	console.log("buffering start");
	loadingEl.style.display = "";
});

clip.on(MediaPlayerEvent.BUFFERING_END, ({ lag }) => {
	console.log("buffering end", lag);
	loadingEl.style.display = "none";
});

clip.on(MediaPlayerEvent.TIME_UPDATE, (data: { time: number }) => {
	const t = data.time;
	if (!isScrubbing) {
		progressEl.value = String(t);
	}
	timeEl.textContent = `${formatTime(t)} / ${formatTime(durationSec)} (${t})`;
});

clip.on(MediaPlayerEvent.SEEKED, ({ at }: { at: number }) => {
	console.log("seeked", at);
	progressEl.value = String(at);
	timeEl.textContent = `${formatTime(at)} / ${formatTime(durationSec)}`;
});

// Format seconds to mm:ss or hh:mm:ss
function formatTime(sec: number): string {
	if (!Number.isFinite(sec)) return "--:--";
	// Round to milliseconds for stable display and correct rollover
	const totalMs = Math.max(0, Math.round(sec * 1000));
	const h = Math.floor(totalMs / 3600000);
	const remH = totalMs % 3600000;
	const m = Math.floor(remH / 60000);
	const remM = remH % 60000;
	const s = Math.floor(remM / 1000);
	const ms = remM % 1000;

	const hh = String(h);
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	const mmm = String(ms).padStart(3, "0");

	return h > 0 ? `${hh}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

// Clamp a number to [0, 1]
function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

// Create UI controls dynamically to avoid modifying HTML
const controlsContainer = statusEl.parentElement as HTMLDivElement; // the big controls column
const audioControls = document.createElement("div");
audioControls.className = "flex gap-2 items-center";

// Volume label
const volLabel = document.createElement("label");
volLabel.textContent = "音量";
volLabel.className = "text-sm opacity-80";

// Volume slider
const volSlider = document.createElement("input");
volSlider.type = "range";
volSlider.min = "0";
volSlider.max = "1";
volSlider.step = "0.01";
volSlider.value = String(currentVolume);
volSlider.id = "volume-slider";
volSlider.className = "w-40";
volSlider.addEventListener("input", () => {
	const v = parseFloat(volSlider.value);
	if (!Number.isFinite(v)) return;
	currentVolume = clamp01(v);
	clip.setVolume(currentVolume);
});

// Mute toggle
const muteBtn = document.createElement("button");
muteBtn.id = "mute-toggle";
muteBtn.textContent = "静音";
muteBtn.className =
	"rounded-lg bg-zinc-200 dark:bg-zinc-750 hover:bg-zinc-300 dark:hover:bg-zinc-700 px-3 py-1";
muteBtn.addEventListener("click", () => {
	if (isMuted) {
		clip.unmute();
		isMuted = false;
		muteBtn.textContent = "静音";
	} else {
		clip.mute();
		isMuted = true;
		muteBtn.textContent = "取消静音";
	}
});

audioControls.appendChild(volLabel);
audioControls.appendChild(volSlider);
audioControls.appendChild(muteBtn);

// Checkbox: enable volume reduction within configured interval
const volumeReduceLabel = document.createElement("label");
volumeReduceLabel.className = "flex items-center gap-2 text-sm opacity-80";
const volumeReduceCheckbox = document.createElement("input");
volumeReduceCheckbox.type = "checkbox";
volumeReduceCheckbox.id = "volume-reduce-30-40";
// Load persisted state from localStorage
volumeReduceCheckbox.checked =
	localStorage.getItem("volumeReduce30-40") === "true";
const volumeReduceText = document.createElement("span");
volumeReduceText.textContent = "第20-30秒音量降至0.1";
volumeReduceLabel.appendChild(volumeReduceCheckbox);
volumeReduceLabel.appendChild(volumeReduceText);

audioControls.appendChild(volumeReduceLabel);

// Persist volume reduction toggle
volumeReduceCheckbox.addEventListener("change", () => {
	// Save state to localStorage
	localStorage.setItem(
		"volumeReduce30-40",
		String(volumeReduceCheckbox.checked)
	);
});

controlsContainer.insertBefore(
	audioControls,
	controlsContainer.querySelector("#status")
);

// Media Player implementation switcher
const switcherLabel = document.createElement("label");
switcherLabel.className = "flex items-center gap-2 text-sm opacity-80";
const switcherCheckbox = document.createElement("input");
switcherCheckbox.type = "checkbox";
switcherCheckbox.checked =
	localStorage.getItem("mediaPlayerImpl") === "compatible";
switcherCheckbox.addEventListener("change", () => {
	localStorage.setItem(
		"mediaPlayerImpl",
		switcherCheckbox.checked ? "compatible" : "default"
	);
	window.location.reload();
});
const switcherText = document.createElement("span");
switcherText.textContent = "Use CompatibleMediaPlayer (HTML Video)";
switcherLabel.appendChild(switcherCheckbox);
switcherLabel.appendChild(switcherText);
controlsContainer.insertBefore(
	switcherLabel,
	controlsContainer.querySelector("#status")
);

document.getElementById("play")!.addEventListener("click", () => {
	void clip.play();
});
document.getElementById("pause")!.addEventListener("click", () => {
	void clip.pause();
});

document.getElementById("seek")!.addEventListener("click", () => {
	const value = (document.getElementById("seek-seconds") as HTMLInputElement)
		.value;
	const time = parseFloat(value);
	if (!Number.isFinite(time)) return;
	void clip.seekToTime(time);
});

// Progress bar scrubbing
progressEl.addEventListener("pointerdown", () => {
	isScrubbing = true;
});
progressEl.addEventListener("pointerup", () => {
	isScrubbing = false;
	const time = parseFloat(progressEl.value);
	if (Number.isFinite(time)) {
		void clip.seekToTime(time);
	}
});
progressEl.addEventListener("change", () => {
	// Fallback for keyboard changes
	const time = parseFloat(progressEl.value);
	if (Number.isFinite(time)) {
		void clip.seekToTime(time);
	}
});
progressEl.addEventListener("input", () => {
	// While dragging, update the displayed time but don't spam seek
	const time = parseFloat(progressEl.value);
	if (Number.isFinite(time)) {
		timeEl.textContent = `${formatTime(time)} / ${formatTime(durationSec)}`;
	}
});

document
	.getElementById("file-input")!
	.addEventListener("change", (ev: Event) => {
		const input = ev.target as HTMLInputElement | null;
		const file = input?.files?.[0] ?? null;
		const url = URL.createObjectURL(file!);
		if (!file) return;
		player.style.display = "";
		void clip.load(url);
	});

document.getElementById("load-mp4")!.addEventListener("click", () => {
	player.style.display = "";
	statusEl.textContent = "Loading MP4...";

	clip.load(SampleMp4FileUrl).catch((error) => {
		console.error("Failed to load MP4 URL:", error);
		statusEl.textContent = "Load MP4 failed";
		alert("Failed to load MP4. Please check the URL or network connection");
	});
});

document.getElementById("load-mp3")!.addEventListener("click", () => {
	player.style.display = "";
	statusEl.textContent = "Loading MP3...";

	clip.load(SampleMp3FileUrl).catch((error) => {
		console.error("Failed to load MP3 URL:", error);
		statusEl.textContent = "Load MP3 failed";
		alert("Failed to load MP3. Please check the URL or network connection");
	});
});
