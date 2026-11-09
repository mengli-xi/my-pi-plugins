import { DEFAULT_CONFIG as DEFAULT_TRANSCRIPT } from "../config.ts";
import type { FullscreenLayoutConfig } from "../host/fullscreen/bridge.ts";
import type { TranscriptConfig, WorkingConfig } from "../types.ts";

export type TranscriptFeatureConfig = Omit<TranscriptConfig, "enabled" | "working">;
export type WorkingFeatureConfig = Omit<WorkingConfig, "enabled">;

export interface PerformanceConfig {
	enabled: boolean;
	logEnabled: boolean;
	sampleWindow: number;
	slowSampleMs: number;
}

export interface LoadingConfig {
	/** Tier 0 is always synchronous; this controls when cold UI modules load. */
	mode: "balanced" | "eager" | "minimal";
	idleDelayMs: number;
	preloadOverlays: boolean;
	preloadDiagnostics: boolean;
}

export interface EffectiveCcStyleConfig {
	features: {
		transcript: boolean;
		working: boolean;
	};
	transcript: TranscriptFeatureConfig;
	working: WorkingFeatureConfig;
	performance: PerformanceConfig;
	loading: LoadingConfig;
	/** Pi fullscreen adaptations taken over from the retired pi-pinned-layout. */
	layout: FullscreenLayoutConfig;
}

const {
	enabled: _transcriptEnabled,
	working: _transcriptWorking,
	...transcript
} = DEFAULT_TRANSCRIPT;
const { enabled: _workingEnabled, ...working } = DEFAULT_TRANSCRIPT.working;

export const DEFAULT_EFFECTIVE_CONFIG: EffectiveCcStyleConfig = {
	features: {
		transcript: DEFAULT_TRANSCRIPT.enabled,
		working: DEFAULT_TRANSCRIPT.working.enabled,
	},
	transcript: structuredClone(transcript),
	working: structuredClone(working),
	performance: {
		enabled: false,
		logEnabled: false,
		sampleWindow: 512,
		slowSampleMs: 50,
	},
	loading: {
		mode: "balanced",
		idleDelayMs: 250,
		preloadOverlays: false,
		preloadDiagnostics: false,
	},
	layout: {
		enabled: true,
		stickyUserMessage: true,
		floatAutocomplete: true,
		popupGap: 2,
		minViewportRows: 4,
	},
};
