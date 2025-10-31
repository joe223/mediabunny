import { MediaPlayer, ClipEvent, PlaybackCommandType } from "./media-player.js";

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

let isScrubbing = false;
let durationSec = 0;
progressEl.disabled = true;

const clip = new MediaPlayer({
	canvas,
	enableAudio: true,
	canvasSize: { width: 640, height: 640 },
});

// ----- Audio controls: volume, mute, per-chunk envelope (via onCreateAudioSource) -----
let currentVolume = 1;
let isMuted = false;
clip.setVolume(currentVolume);

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
	currentVolume = Math.max(0, Math.min(1, v));
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
// Checkbox: enable per-chunk fade in/out via onCreateAudioSource
const chunkEnvLabel = document.createElement("label");
chunkEnvLabel.className = "flex items-center gap-2 text-sm opacity-80";
const chunkEnvCheckbox = document.createElement("input");
chunkEnvCheckbox.type = "checkbox";
chunkEnvCheckbox.id = "chunk-envelope";
const chunkEnvText = document.createElement("span");
chunkEnvText.textContent = "启用整段首尾淡入淡出（2s）";
chunkEnvLabel.appendChild(chunkEnvCheckbox);
chunkEnvLabel.appendChild(chunkEnvText);

// onCreateAudioSource-based envelope: fade in first 2s of clip, fade out last 2s
chunkEnvCheckbox.addEventListener("change", () => {
	const enabled = chunkEnvCheckbox.checked;
	if (!enabled) {
		clip.onCreateAudioSource = undefined;
		return;
	}
	const fadeInSec = 2;
	const fadeOutSec = 2;
	clip.onCreateAudioSource = ({
		audioContext,
		sourceNode,
		timestamp,
		timelineNow,
	}) => {
		const g = audioContext.createGain();
		const startACtime = audioContext.currentTime + (timestamp - timelineNow);
		const dur = sourceNode.buffer?.duration ?? 0;
		const duration = durationSec; // set on READY

		if (!Number.isFinite(duration) || duration <= 0 || dur <= 0) {
			g.gain.setValueAtTime(1, startACtime);
			return g;
		}

		const fadeOutStart = Math.max(0, duration - fadeOutSec);
		const fadeOutEnd = duration;

		const envelopeAt = (t: number): number => {
			if (t <= 0) return 0;
			if (t < fadeInSec) return Math.max(0, Math.min(1, t / fadeInSec));
			if (t <= fadeOutStart) return 1;
			if (t < fadeOutEnd)
				return Math.max(0, Math.min(1, (fadeOutEnd - t) / fadeOutSec));
			return 0;
		};

		const gStart = envelopeAt(timestamp);
		const gEnd = envelopeAt(timestamp + dur);
		g.gain.setValueAtTime(gStart, startACtime);
		g.gain.linearRampToValueAtTime(gEnd, startACtime + dur);

		return g;
	};
});

audioControls.appendChild(chunkEnvLabel);
controlsContainer.insertBefore(
	audioControls,
	controlsContainer.querySelector("#status")
);

clip.on(ClipEvent.READY, () => {
	console.log("ready");
	statusEl.textContent = "ready";
	const state = clip.getState();
	durationSec = state.duration;
	progressEl.max = String(Math.max(0, durationSec));
	progressEl.value = "0";
	progressEl.disabled = false;
	timeEl.textContent = `${formatTime(0)} / ${formatTime(durationSec)} (${0})`;
});

clip.on(ClipEvent.PLAY, () => {
	console.log("play");
	statusEl.textContent = "playing";
});

clip.on(ClipEvent.PAUSE, () => {
	console.log("pause");
	statusEl.textContent = "paused";
});

clip.on(ClipEvent.ENDED, () => {
	console.log("ended");
	statusEl.textContent = "ended";
	timeEl.textContent = `${formatTime(durationSec)} / ${formatTime(
		durationSec
	)}`;
});

clip.on(ClipEvent.ERROR, (error: any) => {
	console.error("error", error);
	statusEl.textContent = "error: " + error.message;
});

clip.on(ClipEvent.BUFFERING_START, () => {
	console.log("buffering start");
	loadingEl.style.display = "";
});

clip.on(ClipEvent.BUFFERING_END, ({lag}) => {
	console.log("buffering end", lag);
	loadingEl.style.display = "none";
});

clip.on(ClipEvent.TIME_UPDATE, (data: { time: number }) => {
	const t = data.time;
	if (!isScrubbing) {
		progressEl.value = String(t);
	}
	timeEl.textContent = `${formatTime(t)} / ${formatTime(durationSec)} (${t})`;
});

clip.on(ClipEvent.SEEKED, ({ at }: { at: number }) => {
	console.log("seeked", at);
	progressEl.value = String(at);
	timeEl.textContent = `${formatTime(at)} / ${formatTime(durationSec)}`;
});

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
